#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const proxy = path.join(root, "proxy.mjs");
const mockBackend = path.join(import.meta.dirname, "mock-codex.mjs");
const mockTui = path.join(import.meta.dirname, "mock-cli-tui.mjs");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "safe-switch-cli-test-"));
const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cdx-r-test-"));
const backendTrace = path.join(tempHome, "backend-trace.jsonl");
const tuiTrace = path.join(tempHome, "tui-trace.jsonl");

const child = spawn(process.execPath, [proxy], {
  env: {
    ...process.env,
    CODEX_HOME: path.join(tempHome, ".codex"),
    HOME: tempHome,
    XDG_RUNTIME_DIR: runtimeDirectory,
    SAFE_SWITCH_DISABLE_NAVIGATION: "1",
    SAFE_SWITCH_FORCE_CLI_PROXY: "1",
    SAFE_SWITCH_REAL_CODEX: mockBackend,
    SAFE_SWITCH_TEST_CLI_TRACE: tuiTrace,
    SAFE_SWITCH_TEST_TRACE: backendTrace,
    SAFE_SWITCH_TEST_TUI_CODEX: mockTui,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));

const exit = await Promise.race([
  new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`CLI supervisor timed out: ${Buffer.concat(stderr).toString()}`)), 10_000),
  ),
]);
assert.equal(exit.signal, null);
assert.equal(exit.code, 0, Buffer.concat(stderr).toString());

const tuiEvents = fs
  .readFileSync(tuiTrace, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const invocations = tuiEvents.filter((event) => event.type === "tui-invocation");
assert.equal(invocations.length, 2);
for (const invocation of invocations) {
  const remoteIndex = invocation.args.indexOf("--remote");
  assert.equal(remoteIndex >= 0, true);
  assert.match(invocation.args[remoteIndex + 1], new RegExp(`^unix://${runtimeDirectory}/cdx-r/\\d+-\\d+$`));
}
assert.equal(invocations[0].sourceThreadId, "source-thread");
assert.equal(invocations[1].sourceThreadId, "recovered-thread");
assert.equal(invocations[1].prompt, "retry me");
assert.equal(
  tuiEvents.some((event) => event.type === "recovered-turn-started"),
  true,
);

const backend = fs
  .readFileSync(backendTrace, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const internal = backend.filter(
  (message) => typeof message.id === "string" && message.id.startsWith("safe-switch:"),
);
assert.deepEqual(
  internal.map((message) => message.method),
  [
    "thread/read",
    "thread/start",
    "thread/inject_items",
    "thread/archive",
    "thread/read",
    "thread/unarchive",
    "thread/resume",
    "thread/name/set",
  ],
);
const replayedTurn = backend.find(
  (message) => message.method === "turn/start" && message.params?.threadId === "recovered-thread",
);
assert.ok(replayedTurn);
assert.deepEqual(replayedTurn.params.input, [{ type: "text", text: "retry me" }]);
assert.equal(replayedTurn.params.permissions, ":danger-full-access");
assert.equal(replayedTurn.params.approvalPolicy, "never");
assert.equal(replayedTurn.params.approvalsReviewer, "user");

const logPath = path.join(tempHome, ".codex", "safe-switch-proxy", "logs", "proxy.log");
const log = fs.readFileSync(logPath, "utf8");
assert.match(log, /"event":"cli_recovery_prepared"/);
assert.match(Buffer.concat(stderr).toString(), /reopening Codex CLI/);
assert.equal(Buffer.concat(stdout).length, 0);

process.stdout.write("CLI supervisor recovery test passed\n");
