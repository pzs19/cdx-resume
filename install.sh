#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
codex_home=${CODEX_HOME:-"$HOME/.codex"}
install_dir="$codex_home/safe-switch-proxy"
legacy_prompt="$codex_home/prompts/goanyway.md"
resources_dir=${CODEX_ELECTRON_RESOURCES_PATH:-/Applications/ChatGPT.app/Contents/Resources}
platform=$(uname -s)
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
node_bin="$resources_dir/cua_node/bin/node"

if [[ ! -x "$node_bin" ]]; then
  node_bin=$(command -v node || true)
fi
if [[ -z "$node_bin" ]]; then
  printf '%s\n' 'Node.js was not found.' >&2
  exit 1
fi

desktop_codex=""
for candidate in \
  "$resources_dir/codex" \
  "$resources_dir/codex-cli/bin/codex" \
  "$resources_dir/codex-cli/CodexCLI.app/Contents/MacOS/codex"; do
  if [[ -x "$candidate" ]]; then
    desktop_codex="$candidate"
    break
  fi
done

stored_real_codex=""
if [[ -f "$install_dir/real-codex-path" ]]; then
  stored_real_codex=$(sed -n '1p' "$install_dir/real-codex-path")
fi
cli_codex=${SAFE_SWITCH_REAL_CODEX:-$(command -v codex || true)}
case "$cli_codex" in
  "$install_dir/codex"|"$install_dir/bin/codex") cli_codex="$stored_real_codex" ;;
esac
if [[ -n "$cli_codex" && -e "$cli_codex" ]]; then
  cli_codex=$("$node_bin" -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$cli_codex")
fi
real_codex=${SAFE_SWITCH_REAL_CODEX:-${cli_codex:-$desktop_codex}}

if [[ -z "$real_codex" || ! -x "$real_codex" ]]; then
  printf '%s\n' 'A real Codex CLI executable was not found.' >&2
  printf '%s\n' 'Install Codex CLI, install ChatGPT Desktop on macOS, or set SAFE_SWITCH_REAL_CODEX.' >&2
  exit 1
fi
if [[ "$platform" == "Darwin" && "${CDX_RESUME_SKIP_APP_CHECK:-0}" != "1" && -z "$desktop_codex" ]]; then
  printf '%s\n' 'ChatGPT Desktop was not found; CLI recovery will be installed without Desktop interception.' >&2
fi

mkdir -p "$install_dir/bin" "$install_dir/logs" "$install_dir/state" "$install_dir/test"

if [[ "$repo_dir" != "$install_dir" ]]; then
  install -m 755 "$repo_dir/codex" "$install_dir/codex"
  install -m 755 "$repo_dir/codex" "$install_dir/bin/codex"
  install -m 755 "$repo_dir/proxy.mjs" "$install_dir/proxy.mjs"
  install -m 644 "$repo_dir/cli-supervisor.mjs" "$install_dir/cli-supervisor.mjs"
  install -m 644 "$repo_dir/websocket.mjs" "$install_dir/websocket.mjs"
  install -m 644 "$repo_dir/history.mjs" "$install_dir/history.mjs"
  install -m 755 "$repo_dir/install.sh" "$install_dir/install.sh"
  install -m 755 "$repo_dir/uninstall.sh" "$install_dir/uninstall.sh"
  install -m 755 "$repo_dir/scripts/status.sh" "$install_dir/status.sh"
  install -m 700 "$repo_dir/test/mock-codex.mjs" "$install_dir/test/mock-codex.mjs"
  install -m 700 "$repo_dir/test/mock-cli-tui.mjs" "$install_dir/test/mock-cli-tui.mjs"
  install -m 700 "$repo_dir/test/recovery.test.mjs" "$install_dir/test/recovery.test.mjs"
  install -m 700 "$repo_dir/test/cli-supervisor.test.mjs" "$install_dir/test/cli-supervisor.test.mjs"
  install -m 700 "$repo_dir/test/history.test.mjs" "$install_dir/test/history.test.mjs"
  install -m 700 "$repo_dir/test/persisted-settings.test.mjs" "$install_dir/test/persisted-settings.test.mjs"
  install -m 700 "$repo_dir/test/passthrough.test.mjs" "$install_dir/test/passthrough.test.mjs"
fi

printf '%s\n' "$real_codex" > "$install_dir/real-codex-path"
chmod 600 "$install_dir/real-codex-path"
chmod 755 "$install_dir/codex" "$install_dir/bin/codex" "$install_dir/proxy.mjs" "$install_dir/status.sh"
chmod 700 "$install_dir/test/"*.mjs "$install_dir/logs" "$install_dir/state"
rm -f "$install_dir/test/goanyway.test.mjs"
if [[ -f "$legacy_prompt" ]] && grep -Fq '__CODEX_GOANYWAY_RECOVERY__' "$legacy_prompt"; then
  rm "$legacy_prompt"
fi

file_mode() {
  if [[ "$platform" == "Darwin" ]]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

update_profile() {
  local profile_path=$1
  local include_desktop=$2
  touch "$profile_path"
  local mode
  mode=$(file_mode "$profile_path")
  local temporary
  temporary=$(mktemp "${TMPDIR:-/tmp}/cdx-resume-profile.XXXXXX")
  awk '
    $0 == "# >>> cdx-resume >>>" { skipping = 1; next }
    $0 == "# <<< cdx-resume <<<" { skipping = 0; next }
    skipping != 1 && $0 !~ /^[[:space:]]*export CODEX_CLI_PATH=.*safe-switch-proxy\/codex/ && $0 !~ /^[[:space:]]*export PATH=.*safe-switch-proxy\/bin/ { print }
  ' "$profile_path" > "$temporary"
  {
    printf '\n# >>> cdx-resume >>>\n'
    printf '%s\n' '# Route interactive Codex CLI sessions through the recovery proxy.'
    printf '%s\n' 'export PATH="$HOME/.codex/safe-switch-proxy/bin:$PATH"'
    if [[ "$include_desktop" == "1" ]]; then
      printf '%s\n' '# Let ChatGPT Desktop start its bundled app-server through the same proxy.'
      printf '%s\n' 'export CODEX_CLI_PATH="$HOME/.codex/safe-switch-proxy/codex"'
    fi
    printf '# <<< cdx-resume <<<\n'
  } >> "$temporary"
  chmod "$mode" "$temporary"
  mv "$temporary" "$profile_path"
}

if [[ "${CDX_RESUME_SKIP_PROFILE:-0}" != "1" ]]; then
  if [[ "$platform" == "Darwin" ]]; then
    update_profile "$HOME/.zprofile" 1
    if [[ -f "$HOME/.bash_profile" ]]; then update_profile "$HOME/.bash_profile" 1; fi
  else
    update_profile "$HOME/.profile" 0
    update_profile "$HOME/.bashrc" 0
  fi
fi

if [[ "$platform" == "Darwin" && -n "$desktop_codex" && "${CDX_RESUME_SKIP_LAUNCHCTL:-0}" != "1" ]]; then
  mkdir -p "$(dirname "$launch_agent")"
  launchctl bootout "gui/$UID" "$launch_agent" >/dev/null 2>&1 || true
  rm -f "$launch_agent"
  plutil -create xml1 "$launch_agent"
  plutil -insert Label -string com.pzs19.cdx-resume "$launch_agent"
  plutil -insert ProgramArguments -xml '<array/>' "$launch_agent"
  plutil -insert ProgramArguments.0 -string /bin/launchctl "$launch_agent"
  plutil -insert ProgramArguments.1 -string setenv "$launch_agent"
  plutil -insert ProgramArguments.2 -string CODEX_CLI_PATH "$launch_agent"
  plutil -insert ProgramArguments.3 -string "$install_dir/codex" "$launch_agent"
  plutil -insert RunAtLoad -bool YES "$launch_agent"
  plutil -insert LimitLoadToSessionType -string Aqua "$launch_agent"
  launchctl bootstrap "gui/$UID" "$launch_agent"
  launchctl setenv CODEX_CLI_PATH "$install_dir/codex"
fi

"$node_bin" "$install_dir/test/recovery.test.mjs"
SAFE_SWITCH_TEST_STALL_READ=1 SAFE_SWITCH_READ_TIMEOUT_MS=100 "$node_bin" "$install_dir/test/recovery.test.mjs"
"$node_bin" "$install_dir/test/cli-supervisor.test.mjs"
"$node_bin" "$install_dir/test/persisted-settings.test.mjs"
"$node_bin" "$install_dir/test/history.test.mjs"
"$node_bin" "$install_dir/test/passthrough.test.mjs"

printf '\n%s\n' 'cdx-resume installed successfully.'
printf '%s\n' 'Start a new shell before using Codex CLI through the automatic recovery wrapper.'
if [[ "$platform" == "Darwin" && -n "$desktop_codex" ]]; then
  printf '%s\n' 'Fully quit ChatGPT Desktop with Cmd+Q, then reopen it.'
fi
printf '%s\n' 'Recovery runs automatically after a recognized encrypted-content failure.'
