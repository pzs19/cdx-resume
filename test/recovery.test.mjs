#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "..");
const proxy = path.join(root, "proxy.mjs");
const mock = path.join(import.meta.dirname, "mock-codex.mjs");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "safe-switch-test-"));
const tracePath = path.join(tempHome, "trace.jsonl");

const child = spawn(process.execPath, [proxy, "app-server"], {
  env: {
    ...process.env,
    HOME: tempHome,
    SAFE_SWITCH_DISABLE_NAVIGATION: "1",
    SAFE_SWITCH_REAL_CODEX: mock,
    SAFE_SWITCH_TEST_TRACE: tracePath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const stdout = [];
const stderr = [];
readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim()) stdout.push(JSON.parse(line));
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition; stderr=${stderr.join("")}`);
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "thread/resume",
  params: {
    threadId: "source-thread",
  },
});
send({
  jsonrpc: "2.0",
  id: 3,
  method: "turn/start",
  params: {
    clientUserMessageId: "client-message-1",
    input: [{ type: "text", text: "retry me" }],
    model: "gpt-test",
    personality: "friendly",
    environments: [{ cwd: "/tmp/source-project", id: "local" }],
    serviceTier: "fast",
    threadId: "source-thread",
  },
});

await waitFor(() => {
  if (!fs.existsSync(tracePath)) return false;
  return fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .some(
      (message) =>
        message.method === "turn/start" && message.params?.threadId === "recovered-thread",
    );
});

await new Promise((resolve) => setTimeout(resolve, 50));
child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));

const trace = fs
  .readFileSync(tracePath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const internal = trace.filter(
  (message) => typeof message.id === "string" && message.id.startsWith("safe-switch:"),
);

assert.deepEqual(
  internal.map((message) => message.method),
  ["thread/read", "thread/start", "thread/inject_items", "thread/name/set", "turn/start"],
);

const threadStart = internal.find((message) => message.method === "thread/start");
assert.equal(threadStart.params.cwd, "/tmp/source-project");
assert.equal(threadStart.params.historyMode, "legacy");
assert.equal(threadStart.params.model, "gpt-test");
assert.equal(threadStart.params.modelProvider, "openai");
assert.equal(threadStart.params.projectId, "project-1");
assert.equal(threadStart.params.threadSource, "appServer");
assert.equal(threadStart.params.permissions, ":danger-full-access");
assert.equal(threadStart.params.approvalPolicy, "never");
assert.equal(threadStart.params.approvalsReviewer, "user");
assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, [
  "/tmp/source-project",
  "/tmp/visualizations",
]);
assert.deepEqual(threadStart.params.environments, [
  { cwd: "/tmp/source-project", id: "local" },
]);
assert.equal("sandbox" in threadStart.params, false);

const injection = internal.find((message) => message.method === "thread/inject_items");
assert.deepEqual(injection.params.items, [
  {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "visible user [REDACTED_OPENAI_KEY]" },
      { type: "input_text", text: "[Prior image omitted during safe recovery]" },
    ],
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "visible assistant" }],
  },
]);
assert.equal(JSON.stringify(injection).includes("hidden"), false);
assert.equal(JSON.stringify(injection).includes("secret tool state"), false);
assert.equal(JSON.stringify(injection).includes("retry me"), false);

const setName = internal.find((message) => message.method === "thread/name/set");
assert.equal(setName.params.name, "Original task（恢复）");

const recoveredTurn = internal.find((message) => message.method === "turn/start");
assert.equal(recoveredTurn.params.threadId, "recovered-thread");
assert.deepEqual(recoveredTurn.params.input, [{ type: "text", text: "retry me" }]);
assert.equal("clientUserMessageId" in recoveredTurn.params, false);
assert.equal(recoveredTurn.params.turnTrigger, "safe-switch-auto-recovery");
assert.equal(recoveredTurn.params.permissions, ":danger-full-access");
assert.equal(recoveredTurn.params.approvalPolicy, "never");
assert.equal(recoveredTurn.params.approvalsReviewer, "user");
assert.equal("sandboxPolicy" in recoveredTurn.params, false);
assert.match(
  recoveredTurn.params.additionalContext.safe_switch_auto_recovery.value,
  /Visible prior user and assistant messages were copied/,
);

assert.deepEqual(
  stdout.filter((message) => message.id != null).map((message) => message.id),
  [1, 2, 3],
);
assert.equal(
  stdout.some(
    (message) =>
      message.method === "turn/completed" && message.params?.threadId === "source-thread",
  ),
  true,
);

const logPath = path.join(tempHome, ".codex", "safe-switch-proxy", "logs", "proxy.log");
const log = fs.readFileSync(logPath, "utf8");
assert.match(log, /"event":"recovery_succeeded"/);
assert.equal(log.includes("sk-1234567890abcdefghijkl"), false);

process.stdout.write("safe-switch recovery test passed\n");
