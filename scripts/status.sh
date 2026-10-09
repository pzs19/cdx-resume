#!/usr/bin/env bash
set -u

codex_home=${CODEX_HOME:-"$HOME/.codex"}
install_dir="$codex_home/safe-switch-proxy"
wrapper="$install_dir/codex"
cli_wrapper="$install_dir/bin/codex"
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
log_file="$install_dir/logs/proxy.log"
platform=$(uname -s)

if [[ -x "$wrapper" && -x "$cli_wrapper" ]]; then
  printf '%s\n' 'installed=yes'
else
  printf '%s\n' 'installed=no'
fi

if [[ -f "$install_dir/real-codex-path" ]]; then
  printf 'real_codex=%s\n' "$(sed -n '1p' "$install_dir/real-codex-path")"
else
  printf '%s\n' 'real_codex=missing'
fi

if grep -Fqs 'safe-switch-proxy/bin:$PATH' "$HOME/.zprofile" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc" 2>/dev/null; then
  printf '%s\n' 'cli_profile=enabled'
else
  printf '%s\n' 'cli_profile=disabled'
fi

case ":$PATH:" in
  *":$install_dir/bin:"*) printf '%s\n' 'cli_current_shell=enabled' ;;
  *) printf '%s\n' 'cli_current_shell=restart-required' ;;
esac

if [[ "$platform" == "Darwin" ]]; then
  configured_path=$(launchctl getenv CODEX_CLI_PATH 2>/dev/null || true)
  if [[ "$configured_path" == "$wrapper" ]]; then
    printf '%s\n' 'desktop_environment=enabled'
  elif [[ -n "$configured_path" ]]; then
    printf '%s\n' 'desktop_environment=other'
  else
    printf '%s\n' 'desktop_environment=disabled'
  fi
  if [[ -f "$launch_agent" ]]; then
    printf '%s\n' 'desktop_launch_agent=present'
  else
    printf '%s\n' 'desktop_launch_agent=missing'
  fi
else
  printf '%s\n' 'desktop_environment=not-applicable'
fi

if pgrep -f "$install_dir/proxy.mjs" >/dev/null 2>&1; then
  printf '%s\n' 'proxy_process=running'
else
  printf '%s\n' 'proxy_process=not-running'
fi

if [[ -f "$log_file" ]]; then
  if [[ "$platform" == "Darwin" ]]; then
    printf 'last_log=%s\n' "$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S%z' "$log_file")"
  else
    printf 'last_log=%s\n' "$(stat -c '%y' "$log_file")"
  fi
else
  printf '%s\n' 'last_log=none'
fi
