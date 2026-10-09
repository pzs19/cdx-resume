---
name: cdx-resume
description: Diagnose and recover Codex desktop chats that fail with invalid_encrypted_content or account-bound encrypted history errors, and install, repair, check, or remove the local cdx-resume recovery proxy. Do not use for ordinary interrupted turns, model-capacity errors, or generic chat continuation.
---

# Codex Resume

Use this skill for Codex desktop failures caused by encrypted history that the current account cannot decrypt.

The plugin manages a local JSON-RPC proxy. The skill itself cannot rewrite a broken turn: the proxy must be active before Codex Desktop starts its bundled CLI.

## Workflow

1. Run `../../scripts/status.sh` from this skill directory to inspect the installation without changing anything.
2. Confirm the error is `invalid_encrypted_content`, “encrypted content could not be decrypted or parsed,” or an equivalent account-switch history failure.
3. When the user asks to install, enable, repair, or use recovery, run `../../install.sh`. Explain that the script:
   - installs the proxy under `~/.codex/safe-switch-proxy`;
   - configures `CODEX_CLI_PATH` through a per-user LaunchAgent and `.zprofile`;
   - preserves the original chat and copies only visible history into a replacement chat;
   - requires fully quitting and reopening Codex Desktop before interception becomes active.
4. After restart, run the status script again. A configured wrapper plus new `proxy_started` log entry confirms activation.
5. If a chat is already broken while the proxy is inactive, use Codex app thread tools from a healthy chat to create a clean replacement containing a concise task brief. Preserve the original chat and reproduce its sandbox and approval settings when those settings are available.

## Boundaries

- Never delete or rewrite the original chat.
- Do not claim automatic recovery is active until the wrapper is configured and Codex Desktop has restarted.
- Do not copy hidden reasoning, encrypted blobs, credentials, or raw tool state into a replacement chat.
- Do not use the proxy for model-capacity, network, authentication, or ordinary interrupted-turn errors.
- Run `../../uninstall.sh` only when the user explicitly asks to disable the proxy. Use `--remove-files` only when the user explicitly asks to remove installed files too.
