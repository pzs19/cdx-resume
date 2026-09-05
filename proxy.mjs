#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const appServerIndex = args.indexOf("app-server");
const appServerUtilityCommands = new Set([
  "daemon",
  "proxy",
  "generate-ts",
  "generate-json-schema",
  "help",
]);

const resourcesDir =
  process.env.CODEX_ELECTRON_RESOURCES_PATH?.trim() ||
  "/Applications/ChatGPT.app/Contents/Resources";
const realCodex =
  process.env.SAFE_SWITCH_REAL_CODEX?.trim() || path.join(resourcesDir, "codex");

if (!fs.existsSync(realCodex)) {
  process.stderr.write(`Safe Switch: real Codex binary not found: ${realCodex}\n`);
  process.exit(127);
}

const isInteractiveAppServer =
  appServerIndex !== -1 &&
  !args.slice(appServerIndex + 1).some((arg) => appServerUtilityCommands.has(arg));

if (!isInteractiveAppServer || process.env.SAFE_SWITCH_DISABLE_AUTO_RECOVERY === "1") {
  const child = spawn(realCodex, args, { env: process.env, stdio: "inherit" });
  relaySignals(child);
  child.on("exit", (code, signal) => exitLikeChild(code, signal));
} else {
  startProxy();
}

function startProxy() {
  const child = spawn(realCodex, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  relaySignals(child);

  const instanceId = crypto.randomUUID();
  let internalRequestSequence = 0;
  let shuttingDown = false;
  const internalRequests = new Map();
  const clientRequests = new Map();
  const latestTurnByThread = new Map();
  const threadSettingsById = new Map();
  const attemptedRecoveries = new Set();
  const recoveryThreads = new Set();
  const activeRecoveries = new Map();

  const logDirectory = path.join(os.homedir(), ".codex", "safe-switch-proxy", "logs");
  const logPath = path.join(logDirectory, "proxy.log");
  const pendingRepairPath = path.join(
    os.homedir(),
    ".codex",
    "safe-switch-proxy",
    "state",
    "pending-thread-repairs.json",
  );
  const pendingThreadRepairs = loadPendingThreadRepairs(pendingRepairPath);
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(logDirectory, 0o700);
  } catch {}

  function log(event, details = {}) {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...details,
    });
    try {
      fs.appendFileSync(logPath, `${record}\n`, { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(logPath, 0o600);
    } catch {}
  }

  function idKey(id) {
    return `${typeof id}:${String(id)}`;
  }

  function writeToServer(message) {
    if (child.stdin.destroyed) {
      throw new Error("Codex app-server stdin is closed");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function internalRequest(method, params, timeoutMs = 30_000) {
    const id = `safe-switch:${instanceId}:${++internalRequestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        internalRequests.delete(idKey(id));
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      timer.unref();
      internalRequests.set(idKey(id), { method, reject, resolve, timer });
      writeToServer({ jsonrpc: "2.0", id, method, params });
    });
  }

  function handleClientMessage(message) {
    if (message == null || typeof message !== "object") return false;
    if (message.method === "turn/start" && message.params?.threadId) {
      const pendingRepair = pendingThreadRepairs.get(message.params.threadId);
      if (pendingRepair) {
        copyDefinedFields(message.params, pendingRepair, [
          "approvalPolicy",
          "approvalsReviewer",
        ]);
        applyPermissionToTurn(message.params, pendingRepair);
        pendingThreadRepairs.delete(message.params.threadId);
        persistPendingThreadRepairs(pendingRepairPath, pendingThreadRepairs);
        log("pending_settings_repair_applied", { threadId: message.params.threadId });
      }
      const record = {
        params: structuredClone(message.params),
        requestKey: message.id == null ? null : idKey(message.id),
        startedAt: Date.now(),
        turnId: null,
      };
      latestTurnByThread.set(message.params.threadId, record);
      if (record.requestKey != null) {
        clientRequests.set(record.requestKey, {
          method: message.method,
          params: structuredClone(message.params),
          record,
        });
      }
      return false;
    }
    if (message.id != null && message.method) {
      clientRequests.set(idKey(message.id), {
        method: message.method,
        params: structuredClone(message.params || {}),
      });
    }
    return false;
  }

  function handleClientLine(line) {
    if (!line.trim()) return;
    let consumed = false;
    let forwardedLine = line;
    try {
      const message = JSON.parse(line);
      consumed = handleClientMessage(message);
      forwardedLine = JSON.stringify(message);
    } catch {}
    if (!consumed && !child.stdin.destroyed) child.stdin.write(`${forwardedLine}\n`);
  }

  function handleServerMessage(message) {
    if (message == null || typeof message !== "object") return false;

    if (message.id != null) {
      const key = idKey(message.id);
      const internal = internalRequests.get(key);
      if (internal != null) {
        clearTimeout(internal.timer);
        internalRequests.delete(key);
        if (message.error != null) {
          internal.reject(
            new Error(
              `${internal.method} failed: ${message.error.message || JSON.stringify(message.error)}`,
            ),
          );
        } else {
          internal.resolve(message.result);
        }
        return true;
      }

      const client = clientRequests.get(key);
      if (client != null) {
        clientRequests.delete(key);
        if (message.error == null) {
          captureClientResponse(client, message.result);
          if (client.method === "turn/start" && client.record && message.result?.turn?.id) {
            client.record.turnId = message.result.turn.id;
          }
        }
      }
    }

    if (message.method === "thread/settings/updated") {
      const { threadId, threadSettings } = message.params || {};
      if (typeof threadId === "string" && threadSettings) {
        mergeThreadSettings(threadId, settingsFromResolvedState(threadSettings));
      }
    }

    if (message.method === "turn/completed") {
      const { threadId, turn } = message.params || {};
      if (
        typeof threadId === "string" &&
        turn?.status === "failed" &&
        isEncryptedContentFailure(turn.error) &&
        !recoveryThreads.has(threadId)
      ) {
        const recoveryKey = `${threadId}:${turn.id || "unknown"}`;
        if (!attemptedRecoveries.has(recoveryKey)) {
          attemptedRecoveries.add(recoveryKey);
          const sourceTurn = latestTurnByThread.get(threadId);
          setImmediate(() => {
            beginRecovery({
              failedTurnId: turn.id,
              sourceThreadId: threadId,
              sourceTurn,
            }).catch((error) => {
              log("recovery_failed", {
                sourceThreadId: threadId,
                reason: safeErrorMessage(error),
              });
              notifyFailure();
            });
          });
        }
      }
    }
    return false;
  }

  function captureClientResponse(client, result) {
    const params = client.params || {};
    if (client.method === "thread/start" || client.method === "thread/resume") {
      const threadId = result?.thread?.id || params.threadId;
      if (typeof threadId !== "string") return;
      const requestSettings = settingsFromThreadRequest(params);
      const resolvedSettings = settingsFromResolvedState(result || {});
      mergeThreadSettings(threadId, mergeDefined(requestSettings, resolvedSettings));
      return;
    }

    if (client.method === "thread/settings/update" && typeof params.threadId === "string") {
      mergeThreadSettings(params.threadId, settingsFromTurnRequest(params));
      return;
    }

    if (client.method === "turn/start" && typeof params.threadId === "string") {
      mergeThreadSettings(params.threadId, settingsFromTurnRequest(params));
    }
  }

  function mergeThreadSettings(threadId, update) {
    if (!update || Object.keys(update).length === 0) return;
    threadSettingsById.set(
      threadId,
      mergeDefined(threadSettingsById.get(threadId) || {}, update),
    );
  }

  function handleServerLine(line) {
    if (!line.trim()) return;
    let consumed = false;
    try {
      consumed = handleServerMessage(JSON.parse(line));
    } catch {}
    if (!consumed) process.stdout.write(`${line}\n`);
  }

  function beginRecovery(options) {
    const active = activeRecoveries.get(options.sourceThreadId);
    if (active) return active;
    const recovery = recoverThread(options).finally(() => {
      if (activeRecoveries.get(options.sourceThreadId) === recovery) {
        activeRecoveries.delete(options.sourceThreadId);
      }
    });
    activeRecoveries.set(options.sourceThreadId, recovery);
    return recovery;
  }

  async function recoverThread({
    failedTurnId,
    sourceThreadId,
    sourceTurn,
  }) {
    log("recovery_started", { failedTurnId, sourceThreadId });
    const readResult = await internalRequest("thread/read", {
      includeTurns: true,
      threadId: sourceThreadId,
    });
    const sourceThread = readResult?.thread;
    if (!sourceThread?.id || !sourceThread.cwd) {
      throw new Error("thread/read did not return usable source metadata");
    }

    const replay = resolveReplayTurn({
      failedTurnId,
      sourceThread,
      sourceTurn,
    });
    const sourceSettings = resolveSourceSettings(sourceThread, replay.params);
    const visibleItems = buildVisibleHistory(sourceThread.turns || [], replay.omittedTurnId);
    const newThreadParams = buildRecoveredThreadStartParams(
      sourceThread,
      replay.params,
      sourceSettings,
    );
    const newThreadResult = await internalRequest("thread/start", newThreadParams);
    const newThreadId = newThreadResult?.thread?.id;
    if (!newThreadId) throw new Error("thread/start did not return a new thread ID");
    recoveryThreads.add(newThreadId);
    mergeThreadSettings(
      newThreadId,
      mergeDefined(sourceSettings, settingsFromResolvedState(newThreadResult || {})),
    );

    if (visibleItems.length > 0) {
      await internalRequest("thread/inject_items", {
        items: visibleItems,
        threadId: newThreadId,
      });
    }

    const sourceName = sourceThread.name?.trim();
    if (sourceName) {
      try {
        await internalRequest("thread/name/set", {
          name: `${sourceName}（恢复）`,
          threadId: newThreadId,
        });
      } catch (error) {
        log("set_name_failed", { newThreadId, reason: safeErrorMessage(error) });
      }
    }

    const recoveredTurnParams = buildRecoveredTurnParams(
      replay.params,
      sourceThreadId,
      newThreadId,
      sourceSettings,
    );
    await internalRequest("turn/start", recoveredTurnParams, 60_000);
    openRecoveredThread(newThreadId);
    log("recovery_succeeded", {
      copiedVisibleItems: visibleItems.length,
      failedTurnId: replay.omittedTurnId,
      newThreadId,
      sourceThreadId,
    });
    return { newThreadId };
  }

  function resolveSourceSettings(sourceThread, replayParams) {
    const observed = threadSettingsById.get(sourceThread.id) || {};
    const persisted = readPersistedTurnSettings(sourceThread.path);
    const explicit = settingsFromTurnRequest(replayParams);
    return mergeDefined(persisted, observed, explicit);
  }

  function buildRecoveredThreadStartParams(sourceThread, replayParams, sourceSettings) {
    const params = {
      cwd: sourceSettings.cwd || sourceThread.cwd,
      ephemeral: false,
      historyMode: sourceThread.historyMode || null,
      model: sourceSettings.model || replayParams.model || null,
      modelProvider: sourceThread.modelProvider || null,
      personality: sourceSettings.personality || replayParams.personality || null,
      projectId: sourceThread.projectId || null,
      runtimeWorkspaceRoots:
        sourceSettings.runtimeWorkspaceRoots || replayParams.runtimeWorkspaceRoots || null,
      serviceTier: sourceSettings.serviceTier || replayParams.serviceTier || null,
      threadSource: sourceThread.threadSource || null,
    };

    copyDefinedFields(params, sourceSettings, [
      "approvalPolicy",
      "approvalsReviewer",
      "dynamicTools",
      "environments",
      "selectedCapabilityRoots",
    ]);
    applyPermissionToThreadStart(params, sourceSettings);
    return params;
  }

  function buildRecoveredTurnParams(original, sourceThreadId, newThreadId, sourceSettings) {
    const recovered = structuredClone(original);
    recovered.threadId = newThreadId;
    delete recovered.clientUserMessageId;
    copyDefinedFields(recovered, sourceSettings, [
      "approvalPolicy",
      "approvalsReviewer",
      "collaborationMode",
      "cwd",
      "effort",
      "environments",
      "model",
      "personality",
      "runtimeWorkspaceRoots",
      "serviceTier",
      "summary",
    ]);
    applyPermissionToTurn(recovered, sourceSettings);
    recovered.turnTrigger = "safe-switch-auto-recovery";
    recovered.additionalContext = {
      ...(recovered.additionalContext || {}),
      safe_switch_auto_recovery: {
        kind: "application",
        value:
          `This task was automatically recovered from Codex thread ${sourceThreadId} ` +
          "after account-bound encrypted history could not be decrypted. Visible prior user and " +
          "assistant messages were copied into this fresh thread; hidden reasoning and tool state " +
          "were intentionally omitted. Continue the current user request normally. Do not repeat " +
          "this recovery note unless the user asks about it.",
      },
    };
    return recovered;
  }

  function resolveReplayTurn({ failedTurnId, sourceThread, sourceTurn }) {
    const candidate = findLastReplayableTurn(sourceThread.turns || []);
    const params = structuredClone(sourceTurn?.params || {});
    let input = copyReplayInput(params.input);

    if (input.length === 0 && candidate) input = candidate.input;
    if (input.length === 0) {
      input = [
        {
          type: "text",
          text: "Continue the latest unfinished user request from the visible conversation above.",
        },
      ];
    }
    params.input = input;

    let omittedTurnId = failedTurnId || sourceTurn?.turnId || null;
    if (!omittedTurnId && candidate && inputsEqual(candidate.input, input)) {
      omittedTurnId = candidate.turnId;
    }
    return { omittedTurnId, params };
  }

  function findLastReplayableTurn(turns) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const input = [];
      for (const item of turn?.items || []) {
        if (item?.type === "userMessage") input.push(...copyReplayInput(item.content));
      }
      if (input.length > 0) return { input, turnId: turn?.id || null };
    }
    return null;
  }

  function copyReplayInput(input) {
    if (!Array.isArray(input)) return [];
    const copied = [];
    for (const part of input) {
      if (part?.type === "text") {
        if (typeof part.text !== "string" || isSyntheticUserText(part.text)) continue;
        copied.push(structuredClone(part));
      } else if (
        part?.type === "image" ||
        part?.type === "localImage" ||
        part?.type === "audio" ||
        part?.type === "localAudio" ||
        part?.type === "skill" ||
        part?.type === "mention"
      ) {
        copied.push(structuredClone(part));
      }
    }
    return copied;
  }

  function inputsEqual(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function buildVisibleHistory(turns, failedTurnId) {
    const items = [];
    for (const turn of turns) {
      if (turn?.id === failedTurnId) continue;
      for (const item of turn?.items || []) {
        if (item?.type === "userMessage") {
          const content = toResponseInputContent(item.content);
          if (content.length > 0) items.push({ type: "message", role: "user", content });
        } else if (item?.type === "agentMessage" && typeof item.text === "string") {
          const text = redactSecrets(item.text).trim();
          if (text) {
            items.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            });
          }
        }
      }
    }
    return limitHistory(items, 1_500_000);
  }

  function toResponseInputContent(content) {
    if (!Array.isArray(content)) return [];
    const result = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        if (isSyntheticUserText(part.text)) continue;
        const text = redactSecrets(part.text).trim();
        if (text) result.push({ type: "input_text", text });
      } else if (part?.type === "image" || part?.type === "localImage") {
        result.push({ type: "input_text", text: "[Prior image omitted during safe recovery]" });
      } else if (part?.type === "audio" || part?.type === "localAudio") {
        result.push({ type: "input_text", text: "[Prior audio omitted during safe recovery]" });
      }
    }
    return result;
  }

  function limitHistory(items, maxCharacters) {
    const retained = [];
    let total = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const size = JSON.stringify(items[index]).length;
      if (retained.length > 0 && total + size > maxCharacters) continue;
      retained.push(items[index]);
      total += size;
    }
    return retained.reverse();
  }

  function openRecoveredThread(threadId) {
    if (process.env.SAFE_SWITCH_DISABLE_NAVIGATION === "1") return;
    const opener = spawn("/usr/bin/open", [`codex://threads/${encodeURIComponent(threadId)}`], {
      detached: true,
      stdio: "ignore",
    });
    opener.unref();
  }

  function notifyFailure() {
    if (process.platform !== "darwin" || process.env.SAFE_SWITCH_DISABLE_NAVIGATION === "1") return;
    const script =
      'display notification "自动恢复失败；原任务仍被保留。请查看 Safe Switch 日志。" ' +
      'with title "Codex Safe Switch"';
    const notifier = spawn("/usr/bin/osascript", ["-e", script], {
      detached: true,
      stdio: "ignore",
    });
    notifier.unref();
  }

  process.stdin.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  const clientLines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const serverLines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  clientLines.on("line", handleClientLine);
  serverLines.on("line", handleServerLine);
  clientLines.on("close", () => {
    if (!child.stdin.destroyed) child.stdin.end();
  });

  child.on("error", (error) => {
    log("app_server_spawn_failed", { reason: safeErrorMessage(error) });
    process.stderr.write(`Safe Switch: ${safeErrorMessage(error)}\n`);
  });
  child.on("exit", (code, signal) => {
    shuttingDown = true;
    for (const request of internalRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex app-server exited"));
    }
    internalRequests.clear();
    log("proxy_stopped", { code, signal });
    exitLikeChild(code, signal);
  });
  process.on("exit", () => {
    if (!shuttingDown && !child.killed) child.kill();
  });
  log("proxy_started", { appServerPid: child.pid, realCodex });
}

function isEncryptedContentFailure(error) {
  if (error == null) return false;
  let text;
  try {
    text = JSON.stringify(error);
  } catch {
    text = String(error);
  }
  return /encrypted[_ -]?content|could not be decrypted|failed to decrypt/i.test(text);
}

function settingsFromThreadRequest(params) {
  if (!params || typeof params !== "object") return {};
  const settings = settingsFromTurnRequest(params);
  copyDefinedFields(settings, params, [
    "dynamicTools",
    "selectedCapabilityRoots",
  ]);
  if (params.sandbox != null) settings.sandboxMode = params.sandbox;
  return settings;
}

function settingsFromTurnRequest(params) {
  if (!params || typeof params !== "object") return {};
  const settings = {};
  copyDefinedFields(settings, params, [
    "approvalPolicy",
    "approvalsReviewer",
    "collaborationMode",
    "cwd",
    "effort",
    "environments",
    "model",
    "personality",
    "runtimeWorkspaceRoots",
    "sandboxPolicy",
    "serviceTier",
    "summary",
  ]);
  if (typeof params.permissions === "string" && params.permissions) {
    settings.permissionId = params.permissions;
  }
  return settings;
}

function settingsFromResolvedState(state) {
  if (!state || typeof state !== "object") return {};
  const settings = {};
  copyDefinedFields(settings, state, [
    "approvalPolicy",
    "approvalsReviewer",
    "collaborationMode",
    "cwd",
    "effort",
    "model",
    "personality",
    "runtimeWorkspaceRoots",
    "serviceTier",
    "summary",
  ]);
  if (settings.effort == null && state.reasoningEffort != null) {
    settings.effort = structuredClone(state.reasoningEffort);
  }
  if (state.activePermissionProfile?.id) {
    settings.permissionId = state.activePermissionProfile.id;
  }
  if (state.sandboxPolicy != null) {
    settings.sandboxPolicy = structuredClone(state.sandboxPolicy);
  } else if (state.sandbox != null && typeof state.sandbox === "object") {
    settings.sandboxPolicy = structuredClone(state.sandbox);
  }
  return settings;
}

function settingsFromPersistedTurnContext(context) {
  if (!context || typeof context !== "object") return {};
  const settings = {};
  const activeProfile = context.active_permission_profile;
  if (activeProfile?.id) settings.permissionId = activeProfile.id;
  const pairs = [
    ["approval_policy", "approvalPolicy"],
    ["approvals_reviewer", "approvalsReviewer"],
    ["collaboration_mode", "collaborationMode"],
    ["cwd", "cwd"],
    ["effort", "effort"],
    ["model", "model"],
    ["personality", "personality"],
    ["sandbox_policy", "sandboxPolicy"],
    ["summary", "summary"],
    ["workspace_roots", "runtimeWorkspaceRoots"],
  ];
  for (const [source, target] of pairs) {
    if (context[source] != null) settings[target] = structuredClone(context[source]);
  }
  return settings;
}

function readPersistedTurnSettings(sessionPath) {
  if (typeof sessionPath !== "string" || !path.isAbsolute(sessionPath)) return {};
  let descriptor;
  try {
    const stat = fs.statSync(sessionPath);
    if (!stat.isFile() || stat.size === 0) return {};
    descriptor = fs.openSync(sessionPath, "r");
    const maxBytes = Math.min(stat.size, 32 * 1024 * 1024);
    const buffer = Buffer.allocUnsafe(maxBytes);
    fs.readSync(descriptor, buffer, 0, maxBytes, stat.size - maxBytes);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line || !line.includes('"type":"turn_context"')) continue;
      try {
        const record = JSON.parse(line);
        if (record?.type === "turn_context") {
          return settingsFromPersistedTurnContext(record.payload);
        }
      } catch {}
    }
  } catch {
    return {};
  } finally {
    if (descriptor != null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
  return {};
}

function mergeDefined(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const [key, value] of Object.entries(source)) {
      if (value != null) merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function copyDefinedFields(target, source, fields) {
  for (const field of fields) {
    if (source?.[field] != null) target[field] = structuredClone(source[field]);
  }
}

function applyPermissionToThreadStart(params, settings) {
  if (settings.permissionId) {
    params.permissions = settings.permissionId;
    delete params.sandbox;
    return;
  }
  const sandboxMode = settings.sandboxMode || sandboxPolicyToMode(settings.sandboxPolicy);
  if (sandboxMode) params.sandbox = sandboxMode;
}

function applyPermissionToTurn(params, settings) {
  if (settings.permissionId) {
    params.permissions = settings.permissionId;
    delete params.sandboxPolicy;
    return;
  }
  if (settings.sandboxPolicy != null) {
    params.sandboxPolicy = structuredClone(settings.sandboxPolicy);
    delete params.permissions;
  }
}

function sandboxPolicyToMode(policy) {
  if (typeof policy === "string") return policy;
  switch (policy?.type) {
    case "dangerFullAccess":
    case "danger-full-access":
      return "danger-full-access";
    case "workspaceWrite":
    case "workspace-write":
      return "workspace-write";
    case "readOnly":
    case "read-only":
      return "read-only";
    default:
      return null;
  }
}

function loadPendingThreadRepairs(filePath) {
  const repairs = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const [threadId, value] of Object.entries(parsed)) {
      if (!threadId || !value || typeof value !== "object") continue;
      const repair = {};
      if (typeof value.permissionId === "string" && value.permissionId) {
        repair.permissionId = value.permissionId;
      }
      copyDefinedFields(repair, value, [
        "approvalPolicy",
        "approvalsReviewer",
        "sandboxPolicy",
      ]);
      if (Object.keys(repair).length > 0) repairs.set(threadId, repair);
    }
  } catch {}
  return repairs;
}

function persistPendingThreadRepairs(filePath, repairs) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const serialized = Object.fromEntries(repairs);
    fs.writeFileSync(filePath, `${JSON.stringify(serialized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function isSyntheticUserText(text) {
  const stripped = text.trimStart();
  return (
    (stripped.startsWith("<environment_context>") && stripped.includes("<cwd>")) ||
    stripped.startsWith(
      "Another language model started to solve this problem and produced a summary",
    )
  );
}

function redactSecrets(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_GOOGLE_API_KEY]")
    .replace(
      /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
      "$1[REDACTED_TOKEN]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|password|passwd|client[_-]?secret)(\s*[:=]\s*["']?)[^\s"'`]{8,}/gi,
      "$1$2[REDACTED]",
    );
}

function safeErrorMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  return redactSecrets(text)
    .replace(/\bgAAAA[A-Za-z0-9_-]{80,}/g, "[REDACTED_ENCRYPTED_CONTENT]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

function relaySignals(child) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

function exitLikeChild(code, signal) {
  if (signal) {
    const signalNumber = os.constants.signals[signal];
    process.exit(128 + (Number.isInteger(signalNumber) ? signalNumber : 1));
  }
  process.exit(code ?? 1);
}
