# cdx-resume

[中文说明](README.zh-CN.md)

`cdx-resume` is an unofficial recovery shim for Codex Desktop on macOS. It lets a conversation continue after switching between accounts when account-bound `encrypted_content` can no longer be decrypted.

It does **not** modify `app.asar` or replace the signed application bundle. Instead, it uses Codex Desktop's `CODEX_CLI_PATH` override to place a small JSON-RPC proxy between the desktop app and its bundled Codex CLI.

## What it does

- Automatically detects a failed turn whose error mentions `encrypted_content` or decryption failure.
- Creates a fresh thread using the current account.
- Copies visible user and assistant messages into the fresh thread.
- Intentionally drops encrypted content, hidden reasoning, and tool execution state.
- Replays the latest user request and opens the recovered thread.
- Preserves the source thread's resolved permission profile, approval policy, workspace roots,
  environments, and capability configuration when available.
- Falls back to the latest persisted `turn_context` when the source thread was loaded before the
  proxy could observe its runtime settings.

The original thread is kept unchanged.

## Compatibility

Initially tested with:

- Codex Desktop `26.831.21537`
- Bundled `codex-cli 0.152.1`
- macOS

This project relies on an internal app-server protocol. A Codex Desktop update may require changes. Run the tests again after upgrading.

## Install

Install Codex Desktop in `/Applications`, then:

```bash
git clone https://github.com/pzs19/cdx-resume.git ~/.codex/safe-switch-proxy
cd ~/.codex/safe-switch-proxy
./install.sh
```

Fully quit Codex Desktop with `Cmd+Q`, then reopen it. Closing only the window does not restart the
app-server process.

The installer also creates a per-user LaunchAgent so `CODEX_CLI_PATH` is restored after login or reboot.

## Usage

No command is required. Recovery starts automatically after a recognized decryption failure.

## Update

```bash
cd ~/.codex/safe-switch-proxy
git pull --ff-only
./install.sh
```

Then fully quit and reopen Codex Desktop.

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

Then fully quit and reopen Codex Desktop.

## Privacy and safety

- Do not publish or copy your entire `~/.codex` directory. It may contain account credentials and conversation data.
- Only this repository is needed.
- Common token formats are redacted before visible history is injected or errors are logged.
- Prior images and audio are replaced with omission markers during recovery.
- Proxy logs are local at `~/.codex/safe-switch-proxy/logs/proxy.log` and are excluded from Git.

## How it works

1. Codex Desktop launches the `codex` wrapper through `CODEX_CLI_PATH`.
2. The wrapper starts `proxy.mjs` using the Node.js runtime bundled with Codex Desktop.
3. The proxy launches the real bundled Codex CLI and forwards newline-delimited JSON-RPC traffic.
4. It captures resolved thread settings from `thread/start`, `thread/resume`, and
   `thread/settings/updated`; the persisted `turn_context` is used as a cold-start fallback.
5. On a matching failure, the proxy calls `thread/read`, `thread/start`, `thread/inject_items`,
   `thread/name/set`, and `turn/start`, applying the source permission and capability settings to
   the fresh thread.

This project is unofficial and is not supported by OpenAI.

## License

MIT
