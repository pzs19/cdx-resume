#!/usr/bin/env node

import fs from "node:fs";

import { connectUnixWebSocket } from "../websocket.mjs";

const tracePath = process.env.SAFE_SWITCH_TEST_CLI_TRACE;
if (!tracePath) throw new Error("SAFE_SWITCH_TEST_CLI_TRACE is required");
const args = process.argv.slice(2);
const remoteIndex = args.indexOf("--remote");
const endpoint = remoteIndex === -1 ? null : args[remoteIndex + 1];
if (!endpoint?.startsWith("unix://")) throw new Error("mock TUI requires a Unix remote endpoint");
const resumeIndex = args.indexOf("resume");
const sourceThreadId = resumeIndex === -1 ? "source-thread" : args[resumeIndex + 1];
const prompt = resumeIndex === -1 ? "retry me" : args.at(-1);
fs.appendFileSync(
  tracePath,
  `${JSON.stringify({ args, prompt, sourceThreadId, type: "tui-invocation" })}\n`,
);

const connection = await connectUnixWebSocket(endpoint.slice("unix://".length));
const responses = new Map();
connection.onMessage((text) => {
  const message = JSON.parse(text);
  const waiter = responses.get(String(message.id));
  if (waiter) {
    responses.delete(String(message.id));
    waiter.resolve(message);
  }
});

function request(id, method, params) {
  const response = new Promise((resolve, reject) => {
    responses.set(String(id), { resolve, reject });
  });
  connection.sendText(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return response;
}

await request("initialize", "initialize", {
  clientInfo: { name: "cdx-resume-mock-tui", version: "1" },
  capabilities: { experimentalApi: true },
});
connection.sendText(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
await request("resume", "thread/resume", { threadId: sourceThreadId });
const turn = await request("turn", "turn/start", {
  input: [{ type: "text", text: prompt }],
  threadId: sourceThreadId,
});

if (sourceThreadId === "recovered-thread") {
  fs.appendFileSync(
    tracePath,
    `${JSON.stringify({ result: turn.result, type: "recovered-turn-started" })}\n`,
  );
  connection.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.exit(0);
}

process.on("SIGTERM", () => {
  connection.close();
  process.exit(0);
});
await new Promise(() => {});
