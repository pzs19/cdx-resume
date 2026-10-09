#!/bin/zsh
set -u

install_dir="$HOME/.codex/safe-switch-proxy"
wrapper="$install_dir/codex"
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
log_file="$install_dir/logs/proxy.log"
configured_path=$(launchctl getenv CODEX_CLI_PATH 2>/dev/null || true)

if [[ -x "$wrapper" ]]; then
  print "installed=yes"
else
  print "installed=no"
fi

if [[ "$configured_path" == "$wrapper" ]]; then
  print "launch_environment=enabled"
elif [[ -n "$configured_path" ]]; then
  print "launch_environment=other"
else
  print "launch_environment=disabled"
fi

if [[ -f "$launch_agent" ]]; then
  print "launch_agent=present"
else
  print "launch_agent=missing"
fi

if pgrep -f "$install_dir/proxy.mjs" >/dev/null 2>&1; then
  print "proxy_process=running"
else
  print "proxy_process=not-running"
fi

if [[ -f "$log_file" ]]; then
  print "last_log=$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S%z' "$log_file")"
else
  print "last_log=none"
fi
