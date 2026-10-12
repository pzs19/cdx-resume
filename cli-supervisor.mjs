import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

import { createUnixWebSocketBridge } from "./websocket.mjs";

export async function runCliSupervisor({ args, realCodex }) {
  const proxyScript = path.join(import.meta.dirname, "proxy.mjs");
  const tuiCodex = process.env.SAFE_SWITCH_TEST_TUI_CODEX?.trim() || realCodex;
  const maxRecoveries = Number(process.env.SAFE_SWITCH_MAX_CLI_RECOVERIES) || 2;
  let nextArgs = args;
  let recoveryCount = 0;
  let activeTui = null;
  let activeProxy = null;

  const relay = (signal) => {
    if (activeTui && !activeTui.killed) activeTui.kill(signal);
    if (activeProxy && !activeProxy.killed) activeProxy.kill(signal);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, relay);

  try {
    while (true) {
      const socketPath = chooseSocketPath(recoveryCount);
      const proxy = spawn(process.execPath, [proxyScript, "app-server"], {
        env: {
          ...process.env,
          SAFE_SWITCH_CLI_MODE: "1",
          SAFE_SWITCH_REAL_CODEX: realCodex,
          SAFE_SWITCH_SKIP_RECOVERY: recoveryCount >= maxRecoveries ? "1" : "0",
        },
        stdio: ["pipe", "pipe", "inherit", "pipe"],
      });
      activeProxy = proxy;
      const bridge = await createUnixWebSocketBridge({
        socketPath,
        input: proxy.stdin,
        output: proxy.stdout,
      });
      const endpoint = `unix://${socketPath}`;
      const tui = spawn(tuiCodex, addRemoteEndpoint(nextArgs, endpoint), {
        env: { ...process.env, SAFE_SWITCH_CLI_CHILD: "1" },
        stdio: "inherit",
      });
      activeTui = tui;

      const recoveryPromise = nextControlMessage(proxy.stdio[3]);
      const outcome = await Promise.race([
        childExit(tui).then((exit) => ({ type: "tui-exit", exit })),
        childExit(proxy).then((exit) => ({ type: "proxy-exit", exit })),
        recoveryPromise.then((recovery) => ({ type: "recovery", recovery })),
      ]);

      if (outcome.type === "recovery") {
        recoveryCount += 1;
        process.stderr.write(
          `\ncdx-resume: recovered ${outcome.recovery.sourceThreadId} as ${outcome.recovery.newThreadId}; reopening Codex CLI.\n`,
        );
        await terminate(tui);
        await bridge.close();
        proxy.stdin.end();
        await terminate(proxy);
        nextArgs = recoveredArgs(outcome.recovery);
        activeTui = null;
        activeProxy = null;
        continue;
      }

      if (outcome.type === "proxy-exit") {
        await terminate(tui);
        await bridge.close();
        return outcome.exit;
      }

      await bridge.close();
      proxy.stdin.end();
      await terminate(proxy);
      return outcome.exit;
    }
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, relay);
  }
}

function addRemoteEndpoint(args, endpoint) {
  const filtered = [];
  for (const arg of args) {
    if (arg === "--no-daemon") continue;
    filtered.push(arg);
  }
  return ["--remote", endpoint, ...filtered];
}

function recoveredArgs(recovery) {
  const args = ["resume"];
  for (const image of recovery.images || []) args.push("-i", image);
  args.push(recovery.newThreadId, recovery.prompt);
  return args;
}

function chooseSocketPath(iteration) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR?.trim();
  let directory =
    runtimeDirectory && path.isAbsolute(runtimeDirectory)
      ? path.join(runtimeDirectory, "cdx-r")
      : path.join(codexHome, "safe-switch-proxy", "state");
  let candidate = path.join(directory, `${process.pid}-${iteration}`);
  if (Buffer.byteLength(candidate) > 96) {
    directory = path.join(os.tmpdir(), `cdx-resume-${process.getuid?.() ?? "user"}`);
    candidate = path.join(directory, `${process.pid}-${iteration}`);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return candidate;
}

function nextControlMessage(stream) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (message.type === "cli-recovery-prepared") {
          lines.close();
          resolve(message);
        }
      } catch (error) {
        reject(error);
      }
    });
    stream.once("error", reject);
  });
}

function childExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: 1, signal: null }));
  });
}

async function terminate(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  const exited = childExit(child);
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 3_000)),
  ]);
  if (timedOut && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await childExit(child);
  }
}
