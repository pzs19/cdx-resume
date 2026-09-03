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
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "goanyway-test-"));
const tracePath = path.join(tempHome, "trace.jsonl");
const commandText = process.env.GOANYWAY_TEST_COMMAND || " /GOANYWAY ";

const child = spawn(process.execPath, [proxy, "app-server"], {
  env: {
    ...process.env,
    HOME: tempHome,
    SAFE_SWITCH_DISABLE_NAVIGATION: "1",
    SAFE_SWITCH_REAL_CODEX: mock,
    SAFE_SWITCH_TEST_MODE: "manual",
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

function readTrace() {
  if (!fs.existsSync(tracePath)) return [];
  return fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
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
  method: "turn/start",
  params: {
    input: [{ type: "text", text: commandText }],
    model: "gpt-test-current-account",
    threadId: "source-thread",
  },
});

await waitFor(() =>
  readTrace().some(
    (message) =>
      message.method === "turn/start" && message.params?.threadId === "recovered-thread",
  ),
);
await waitFor(() =>
  stdout.some(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === "source-thread" &&
      message.params?.turn?.status === "completed",
  ),
);

child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));

const trace = readTrace();
assert.equal(
  trace.some((message) => JSON.stringify(message.params?.input || []).includes(commandText.trim())),
  false,
);

const internal = trace.filter(
  (message) => typeof message.id === "string" && message.id.startsWith("safe-switch:"),
);
assert.deepEqual(
  internal.map((message) => message.method),
  ["thread/read", "thread/start", "thread/inject_items", "thread/name/set", "turn/start"],
);

const recoveredTurn = internal.find((message) => message.method === "turn/start");
assert.deepEqual(recoveredTurn.params.input, [{ type: "text", text: "retry me" }]);
assert.equal(recoveredTurn.params.model, "gpt-test-current-account");
assert.equal(recoveredTurn.params.turnTrigger, "safe-switch-manual-recovery");
assert.match(
  recoveredTurn.params.additionalContext.safe_switch_auto_recovery.value,
  /manually recovered/,
);

const commandResponse = stdout.find((message) => message.id === 2);
assert.equal(commandResponse.result.turn.status, "inProgress");

const logPath = path.join(tempHome, ".codex", "safe-switch-proxy", "logs", "proxy.log");
const log = fs.readFileSync(logPath, "utf8");
assert.match(log, /"event":"recovery_succeeded"/);
assert.match(log, /"trigger":"manual"/);

process.stdout.write("/goanyway recovery test passed\n");
