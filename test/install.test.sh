#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_home=$(mktemp -d "${TMPDIR:-/tmp}/cdx-resume-install.XXXXXX")
trap 'rm -rf "$test_home"' EXIT

HOME="$test_home" \
CODEX_HOME="$test_home/.codex" \
SAFE_SWITCH_REAL_CODEX=/usr/bin/true \
CDX_RESUME_SKIP_APP_CHECK=1 \
CDX_RESUME_SKIP_LAUNCHCTL=1 \
  "$repo_dir/install.sh"

install_dir="$test_home/.codex/safe-switch-proxy"
test -x "$install_dir/codex"
test -x "$install_dir/bin/codex"
test -x "$install_dir/proxy.mjs"
test -x "$install_dir/status.sh"
test -f "$install_dir/cli-supervisor.mjs"
test -f "$install_dir/websocket.mjs"
test ! -f "$test_home/.codex/prompts/goanyway.md"
grep -Fq 'CODEX_UPSTREAM_PROXY_URL:-http://127.0.0.1:62333' "$install_dir/codex"
grep -Fq 'CODEX_UPSTREAM_PROXY_URL:-http://127.0.0.1:62333' "$install_dir/bin/codex"
mkdir -p "$test_home/.local/bin"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$test_home/.local/bin/cdx-gateway-provider"
chmod 700 "$test_home/.local/bin/cdx-gateway-provider"
HOME="$test_home" CODEX_HOME="$test_home/.codex" "$install_dir/bin/codex" --version >/dev/null
grep -Fq 'export PATH="$HOME/.codex/safe-switch-proxy/bin:$PATH"' \
  "$test_home/.zprofile" "$test_home/.profile" 2>/dev/null

HOME="$test_home" CODEX_HOME="$test_home/.codex" "$install_dir/uninstall.sh"

test -z "$(rg 'safe-switch-proxy/(bin|codex)' "$test_home/.zprofile" "$test_home/.profile" "$test_home/.bashrc" 2>/dev/null || true)"

printf '%s\n' 'install/uninstall test passed'
