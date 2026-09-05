#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const proxy = path.join(root, "proxy.mjs");
const mock = path.join(import.meta.dirname, "mock-codex.mjs");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "persisted-settings-test-"));
const tracePath = path.join(tempHome, "trace.jsonl");
const sourcePath = path.join(tempHome, "source-thread.jsonl");

fs.writeFileSync(
  sourcePath,
  `${JSON.stringify({
    type: "turn_context",
    payload: {
      active_permission_profile: { id: ":danger-full-access" },
      approval_policy: "never",
      approvals_reviewer: "user",
      cwd: "/tmp/source-project",
      effort: "high",
      model: "gpt-test",
      sandbox_policy: { type: "danger-full-access" },
      workspace_roots: ["/tmp/source-project", "/tmp/visualizations"],
    },
  })}\n`,
);

const child = spawn(process.execPath, [proxy, "app-server"], {
  env: {
    ...process.env,
    HOME: tempHome,
    SAFE_SWITCH_DISABLE_NAVIGATION: "1",
    SAFE_SWITCH_REAL_CODEX: mock,
    SAFE_SWITCH_TEST_SOURCE_PATH: sourcePath,
    SAFE_SWITCH_TEST_TRACE: tracePath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/start",
    params: {
      input: [{ type: "text", text: "retry from cold start" }],
      threadId: "source-thread",
    },
  })}\n`,
);

const started = Date.now();
let trace = [];
while (Date.now() - started < 5_000) {
  if (fs.existsSync(tracePath)) {
    trace = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    if (
      trace.some(
        (message) =>
          message.method === "turn/start" && message.params?.threadId === "recovered-thread",
      )
    ) {
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));

const internal = trace.filter(
  (message) => typeof message.id === "string" && message.id.startsWith("safe-switch:"),
);
const threadStart = internal.find((message) => message.method === "thread/start");
const turnStart = internal.find(
  (message) => message.method === "turn/start" && message.params?.threadId === "recovered-thread",
);

assert.equal(threadStart.params.permissions, ":danger-full-access");
assert.equal(threadStart.params.approvalPolicy, "never");
assert.deepEqual(threadStart.params.runtimeWorkspaceRoots, [
  "/tmp/source-project",
  "/tmp/visualizations",
]);
assert.equal(turnStart.params.permissions, ":danger-full-access");
assert.equal(turnStart.params.approvalPolicy, "never");

process.stdout.write("persisted thread settings recovery test passed\n");
