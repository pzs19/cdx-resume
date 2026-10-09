#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

const tracePath = process.env.SAFE_SWITCH_TEST_TRACE;
if (!tracePath) throw new Error("SAFE_SWITCH_TEST_TRACE is required");
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

  if (message.method === "thread/read" && message.params.threadId === "recovered-thread") {
    send({ id: message.id, result: { thread: { id: "recovered-thread", path: path.join(process.env.HOME, "recovered.jsonl") } } });
    return;
  }
  if (message.method === "thread/read") {
    if (process.env.SAFE_SWITCH_TEST_STALL_READ === "1" && process.env.SAFE_SWITCH_HISTORY_READER !== "1") return;
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
          path: process.env.SAFE_SWITCH_TEST_SOURCE_PATH || null,
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
                { type: "agentMessage", text: "visible assistant\u2028line separator\u2029paragraph separator" },
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

  if (message.method === "thread/resume") {
    const resumedThreadId = message.params?.threadId || "source-thread";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        activePermissionProfile: { id: ":danger-full-access" },
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: "/tmp/source-project",
        model: "gpt-test",
        modelProvider: "openai",
        reasoningEffort: "high",
        runtimeWorkspaceRoots: ["/tmp/source-project", "/tmp/visualizations"],
        sandbox: { type: "dangerFullAccess" },
        serviceTier: "fast",
        thread: { id: resumedThreadId, turns: [] },
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    fs.writeFileSync(path.join(process.env.HOME, "recovered.jsonl"), JSON.stringify({type:"session_meta",payload:{id:"recovered-thread"}}) + "\n");
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
    const inputText = (message.params?.input || [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (inputText === "/goanyway") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { turn: { id: "turn-passthrough", status: "inProgress", items: [], error: null } },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: "source-thread",
          turn: { id: "turn-passthrough", status: "completed", items: [], error: null },
        },
      });
      return;
    }
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
              "Invalid 'input[7].encrypted_content': the encrypted content could not be decrypted",
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
