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
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "passthrough-test-"));
const tracePath = path.join(tempHome, "trace.jsonl");
const repairPath = path.join(
  tempHome,
  ".codex",
  "safe-switch-proxy",
  "state",
  "pending-thread-repairs.json",
);
fs.mkdirSync(path.dirname(repairPath), { recursive: true });
fs.writeFileSync(
  repairPath,
  `${JSON.stringify({
    "source-thread": {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      permissionId: ":danger-full-access",
    },
  })}\n`,
);

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

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "turn/start",
    params: {
      input: [{ type: "text", text: "/goanyway" }],
      threadId: "source-thread",
    },
  })}\n`,
);

const started = Date.now();
while (
  Date.now() - started < 5_000 &&
  !stdout.some((message) => message.params?.turn?.id === "turn-passthrough")
) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

child.kill("SIGTERM");
await new Promise((resolve) => child.once("exit", resolve));

assert.equal(stderr.join(""), "");
assert.equal(
  stdout.some((message) => message.id === 2 && message.result?.turn?.id === "turn-passthrough"),
  true,
);

const trace = fs
  .readFileSync(tracePath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
assert.equal(
  trace.some(
    (message) =>
      message.method === "turn/start" &&
      message.params?.input?.some((part) => part?.text === "/goanyway"),
  ),
  true,
);
const forwardedTurn = trace.find(
  (message) =>
    message.method === "turn/start" &&
    message.params?.input?.some((part) => part?.text === "/goanyway"),
);
assert.equal(forwardedTurn.params.permissions, ":danger-full-access");
assert.equal(forwardedTurn.params.approvalPolicy, "never");
assert.equal(JSON.parse(fs.readFileSync(repairPath, "utf8"))["source-thread"], undefined);
assert.equal(
  trace.some(
    (message) => typeof message.id === "string" && message.id.startsWith("safe-switch:"),
  ),
  false,
);

process.stdout.write("removed /goanyway command passes through normally\n");
