---
name: cdx-resume
description: Install, diagnose, repair, or remove automatic invalid_encrypted_content recovery for Codex Desktop on macOS and interactive Codex CLI on macOS or Linux. Do not use for ordinary interrupted turns, capacity errors, or generic chat continuation.
---

# Codex Resume

Use this skill to manage recovery for Codex sessions whose encrypted history cannot be decrypted by the current account.

The skill is only the installer and maintenance interface. Runtime detection, visible-history copying, clean-thread creation, and request replay are performed automatically by the local proxy without model involvement.

## Workflow

1. Run `../../scripts/status.sh` from this skill directory to inspect the installation without changing anything.
2. When the user asks to install, enable, repair, or use recovery, run `../../install.sh`. The script:
   - installs the proxy under `~/.codex/safe-switch-proxy`;
   - prepends a Codex CLI wrapper through the user's shell profile on macOS and Linux;
   - configures `CODEX_CLI_PATH` through a per-user LaunchAgent on macOS when ChatGPT Desktop is installed;
   - preserves the original chat and copies only visible history into a replacement chat;
   - requires a new shell for CLI interception and a full Desktop restart for Desktop interception.
3. Run the status script again after the relevant restart. `cli_current_shell=enabled` confirms CLI routing; `desktop_environment=enabled` confirms macOS Desktop routing.
4. For an already broken session, start it again only after routing is active. The proxy recognizes the decryption failure and performs recovery automatically.

## Boundaries

- Never delete or rewrite the original chat.
- Do not claim automatic recovery is active until the relevant CLI shell or Desktop process has restarted through the wrapper.
- Do not copy hidden reasoning, encrypted blobs, credentials, or raw tool state into a replacement chat.
- Do not use the proxy for model-capacity, network, authentication, or ordinary interrupted-turn errors.
- Run `../../uninstall.sh` only when the user explicitly asks to disable the proxy. Use `--remove-files` only when the user explicitly asks to remove installed files too.
