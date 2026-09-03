#!/bin/zsh
set -eu

codex_home="$HOME/.codex"
install_dir="$codex_home/safe-switch-proxy"
legacy_prompt="$codex_home/prompts/goanyway.md"
profile_path="$HOME/.zprofile"
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
remove_files=0

if [[ "${1:-}" == "--remove-files" ]]; then
  remove_files=1
elif [[ $# -gt 0 ]]; then
  print -u2 "Usage: $0 [--remove-files]"
  exit 2
fi

configured_path=$(launchctl getenv CODEX_CLI_PATH 2>/dev/null || true)
if [[ "$configured_path" == "$install_dir/codex" ]]; then
  launchctl unsetenv CODEX_CLI_PATH
fi
launchctl bootout "gui/$UID" "$launch_agent" >/dev/null 2>&1 || true
rm -f "$launch_agent"

if [[ -f "$profile_path" ]]; then
  profile_mode=$(stat -f '%Lp' "$profile_path")
  temp_profile=$(mktemp "${TMPDIR:-/tmp}/cdx-resume-profile.XXXXXX")
  awk '
    $0 == "# >>> cdx-resume >>>" { skipping = 1; next }
    $0 == "# <<< cdx-resume <<<" { skipping = 0; next }
    skipping != 1 && $0 !~ /^[[:space:]]*export CODEX_CLI_PATH=.*safe-switch-proxy\/codex/ { print }
  ' "$profile_path" > "$temp_profile"
  chmod "$profile_mode" "$temp_profile"
  mv "$temp_profile" "$profile_path"
fi

if [[ -f "$legacy_prompt" ]] && grep -Fq '__CODEX_GOANYWAY_RECOVERY__' "$legacy_prompt"; then
  rm "$legacy_prompt"
fi

if (( remove_files )); then
  expected="$HOME/.codex/safe-switch-proxy"
  if [[ "$install_dir" != "$expected" || ! -d "$install_dir" ]]; then
    print -u2 "Refusing to remove unexpected install directory: $install_dir"
    exit 1
  fi
  rm -rf "$install_dir"
fi

print 'cdx-resume disabled.'
print 'Fully quit Codex Desktop with Cmd+Q, then reopen it.'
