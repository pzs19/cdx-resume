#!/usr/bin/env bash
set -euo pipefail

codex_home=${CODEX_HOME:-"$HOME/.codex"}
install_dir="$codex_home/safe-switch-proxy"
legacy_prompt="$codex_home/prompts/goanyway.md"
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
platform=$(uname -s)
remove_files=0

if [[ "${1:-}" == "--remove-files" ]]; then
  remove_files=1
elif [[ $# -gt 0 ]]; then
  printf '%s\n' 'Usage: uninstall.sh [--remove-files]' >&2
  exit 2
fi

if [[ "$platform" == "Darwin" ]]; then
  configured_path=$(launchctl getenv CODEX_CLI_PATH 2>/dev/null || true)
  if [[ "$configured_path" == "$install_dir/codex" ]]; then
    launchctl unsetenv CODEX_CLI_PATH
  fi
  launchctl bootout "gui/$UID" "$launch_agent" >/dev/null 2>&1 || true
  rm -f "$launch_agent"
fi

file_mode() {
  if [[ "$platform" == "Darwin" ]]; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

remove_profile_block() {
  local profile_path=$1
  [[ -f "$profile_path" ]] || return 0
  local mode
  mode=$(file_mode "$profile_path")
  local temporary
  temporary=$(mktemp "${TMPDIR:-/tmp}/cdx-resume-profile.XXXXXX")
  awk '
    $0 == "# >>> cdx-resume >>>" { skipping = 1; next }
    $0 == "# <<< cdx-resume <<<" { skipping = 0; next }
    skipping != 1 && $0 !~ /^[[:space:]]*export CODEX_CLI_PATH=.*safe-switch-proxy\/codex/ && $0 !~ /^[[:space:]]*export PATH=.*safe-switch-proxy\/bin/ { print }
  ' "$profile_path" > "$temporary"
  chmod "$mode" "$temporary"
  mv "$temporary" "$profile_path"
}

for profile_path in "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc"; do
  remove_profile_block "$profile_path"
done

if [[ -f "$legacy_prompt" ]] && grep -Fq '__CODEX_GOANYWAY_RECOVERY__' "$legacy_prompt"; then
  rm "$legacy_prompt"
fi

if (( remove_files )); then
  expected="$codex_home/safe-switch-proxy"
  if [[ "$install_dir" != "$expected" || ! -d "$install_dir" ]]; then
    printf 'Refusing to remove unexpected install directory: %s\n' "$install_dir" >&2
    exit 1
  fi
  rm -rf "$install_dir"
fi

printf '%s\n' 'cdx-resume disabled.'
printf '%s\n' 'Start a new shell so the Codex CLI PATH change is removed.'
if [[ "$platform" == "Darwin" ]]; then
  printf '%s\n' 'Fully quit ChatGPT Desktop with Cmd+Q, then reopen it.'
fi
