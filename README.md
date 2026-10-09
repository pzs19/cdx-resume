# cdx-resume

[中文说明](README.zh-CN.md)

`cdx-resume` is an unofficial automatic recovery shim for Codex Desktop on macOS and interactive Codex CLI on macOS or Linux. It lets a conversation continue after switching accounts when account-bound `encrypted_content` can no longer be decrypted.

The repository also ships as a personal Codex plugin. The plugin handles discovery, installation, and health checks; recovery itself is performed by the local proxy without model involvement.

It does **not** modify `app.asar`, the signed application bundle, or the real Codex executable. Desktop uses `CODEX_CLI_PATH`; interactive CLI sessions use the native `--remote unix://...` app-server transport through a local wrapper.

## What it does

- Automatically detects a failed turn whose error mentions `encrypted_content` or decryption failure.
- Falls back to an independent read-only app-server connection if history reading fails or stalls for 5 seconds; the fallback has a 30-second deadline.
- Creates a fresh thread using the current account.
- Copies visible user and assistant messages into the fresh thread, including durable UI turns and the paginated history index so older messages can be scrolled into view.
- Intentionally drops encrypted content, hidden reasoning, and tool execution state.
- Replays the latest user request and opens the recovered thread.
- For CLI sessions, closes the failed TUI and automatically reopens it on the recovered thread.
- Preserves the source thread's resolved permission profile, approval policy, workspace roots,
  environments, and capability configuration when available.
- Falls back to the latest persisted `turn_context` when the source thread was loaded before the
  proxy could observe its runtime settings.

The original thread is kept unchanged.

## Recovery fixes

JSON-RPC framing uses ASCII LF only. Unicode U+2028 and U+2029 in conversation text must remain inside JSON strings; Node readline can otherwise split responses and cause false read timeouts. Regression tests cover both characters and a stalled primary reader.

## Compatibility

Tested with:

- Codex Desktop on macOS
- Codex CLI `0.159.2` on Linux and `0.161.0` on macOS

This project relies on an internal app-server protocol. A Codex Desktop update may require changes. Run the tests again after upgrading.

## Install

### Personal plugin

Add this repository to a personal or private Git marketplace, install **Codex Resume**, and ask its bundled management skill to install the proxy. Start a new shell for CLI use. On macOS, fully quit Desktop with `Cmd+Q` and reopen it.

### Direct proxy installation

Install Codex CLI, then:

```bash
git clone https://github.com/pzs19/cdx-resume.git ~/.codex/safe-switch-proxy
cd ~/.codex/safe-switch-proxy
./install.sh
```

Start a new shell. On macOS with Desktop installed, fully quit it with `Cmd+Q` and reopen it.

On macOS, the installer also creates a per-user LaunchAgent so Desktop interception is restored after login or reboot.

## Usage

No command is required. Recovery starts automatically after a recognized decryption failure.

## Update

```bash
cd ~/.codex/safe-switch-proxy
git pull --ff-only
./install.sh
```

Then start a new shell and, on macOS, fully quit and reopen Desktop.

## Test

```bash
./test/install.test.sh
```

The installer runs recovery, permission-preservation, removed-command pass-through, and lifecycle
tests. Tests use a mock Codex process and do not touch real conversations.

## Uninstall

Disable the integration while keeping the repository and logs:

```bash
./uninstall.sh
```

To also remove the cloned repository:

```bash
./uninstall.sh --remove-files
```

Then start a new shell and, on macOS, fully quit and reopen Desktop.

## Privacy and safety

- Do not publish or copy your entire `~/.codex` directory. It may contain account credentials and conversation data.
- Only this repository is needed.
- Common token formats are redacted before visible history is injected or errors are logged.
- Prior images and audio are replaced with omission markers during recovery.
- Proxy logs are local at `~/.codex/safe-switch-proxy/logs/proxy.log` and are excluded from Git.

## How it works

1. Codex Desktop launches the wrapper through `CODEX_CLI_PATH`; interactive CLI sessions reach the wrapper through `PATH`.
2. Desktop JSON-RPC is proxied directly. CLI TUI sessions connect through a local Unix WebSocket bridge to the same proxy logic.
3. The proxy launches the real Codex app-server and forwards JSON-RPC traffic.
4. It captures resolved thread settings from `thread/start`, `thread/resume`, and
   `thread/settings/updated`; the persisted `turn_context` is used as a cold-start fallback.
5. On a matching failure, the proxy creates a clean thread, copies visible history, and reapplies permissions. Desktop replays the turn in place; CLI restarts its native TUI on the recovered thread and replays the request.

This project is unofficial and is not supported by OpenAI.

## License

MIT
