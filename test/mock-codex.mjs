#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const tracePath = process.env.SAFE_SWITCH_TEST_TRACE;
if (!tracePath) throw new Error("SAFE_SWITCH_TEST_TRACE is required");
const testMode = process.env.SAFE_SWITCH_TEST_MODE || "automatic";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function trace(message) {
  fs.appendFileSync(tracePath, `${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  trace(message);

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { userAgent: "safe-switch-test" } });
    return;
  }

  if (message.method === "thread/read") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        thread: {
          id: "source-thread",
          cwd: "/tmp/source-project",
          historyMode: "legacy",
          modelProvider: "openai",
          name: "Original task",
          projectId: "project-1",
          threadSource: "appServer",
          turns: [
            {
              id: "turn-old",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  content: [
                    { type: "text", text: "visible user sk-1234567890abcdefghijkl" },
                    { type: "localImage", path: "/tmp/old.png" },
                  ],
                },
                { type: "reasoning", summary: ["hidden"], content: "hidden" },
                { type: "agentMessage", text: "visible assistant" },
                { type: "commandExecution", command: "secret tool state" },
              ],
            },
            {
              id: "turn-failed",
              status: "failed",
              items: [
                { type: "userMessage", content: [{ type: "text", text: "retry me" }] },
              ],
            },
          ],
        },
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { thread: { id: "recovered-thread", turns: [] } },
    });
    return;
  }

  if (message.method === "thread/inject_items" || message.method === "thread/name/set") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "turn/start" && message.params?.threadId === "recovered-thread") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { turn: { id: "turn-recovered", status: "inProgress", items: [], error: null } },
    });
    return;
  }

  if (message.method === "turn/start") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { turn: { id: "turn-failed", status: "inProgress", items: [], error: null } },
    });
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "source-thread",
        turn: {
          id: "turn-failed",
          status: "failed",
          items: [],
          error: {
            message:
              testMode === "manual"
                ? "account context mismatch with an unrecognized error shape"
                : "Invalid 'input[7].encrypted_content': the encrypted content could not be decrypted",
          },
        },
      },
    });
    return;
  }

  if (message.id != null) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
