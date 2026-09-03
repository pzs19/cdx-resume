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
  const attemptedRecoveries = new Set();
  const recoveryThreads = new Set();
  const activeRecoveries = new Map();

  const logDirectory = path.join(os.homedir(), ".codex", "safe-switch-proxy", "logs");
  const logPath = path.join(logDirectory, "proxy.log");
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
      const record = {
        params: structuredClone(message.params),
        requestKey: message.id == null ? null : idKey(message.id),
        startedAt: Date.now(),
        turnId: null,
      };
      latestTurnByThread.set(message.params.threadId, record);
      if (record.requestKey != null) {
        clientRequests.set(record.requestKey, { method: message.method, record });
      }
      return false;
    }
    if (message.id != null && message.method) {
      clientRequests.set(idKey(message.id), { method: message.method });
    }
    return false;
  }

  function handleClientLine(line) {
    if (!line.trim()) return;
    let consumed = false;
    try {
      consumed = handleClientMessage(JSON.parse(line));
    } catch {}
    if (!consumed && !child.stdin.destroyed) child.stdin.write(`${line}\n`);
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
        if (client.method === "turn/start" && client.record && message.result?.turn?.id) {
          client.record.turnId = message.result.turn.id;
        }
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
    const visibleItems = buildVisibleHistory(sourceThread.turns || [], replay.omittedTurnId);
    const newThreadResult = await internalRequest("thread/start", {
      cwd: sourceThread.cwd,
      ephemeral: false,
      historyMode: sourceThread.historyMode || null,
      model: replay.params.model || null,
      modelProvider: sourceThread.modelProvider || null,
      personality: replay.params.personality || null,
      projectId: sourceThread.projectId || null,
      runtimeWorkspaceRoots: replay.params.runtimeWorkspaceRoots || null,
      serviceTier: replay.params.serviceTier || null,
      threadSource: sourceThread.threadSource || null,
    });
    const newThreadId = newThreadResult?.thread?.id;
    if (!newThreadId) throw new Error("thread/start did not return a new thread ID");
    recoveryThreads.add(newThreadId);

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

  function buildRecoveredTurnParams(original, sourceThreadId, newThreadId) {
    const recovered = structuredClone(original);
    recovered.threadId = newThreadId;
    delete recovered.clientUserMessageId;
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
