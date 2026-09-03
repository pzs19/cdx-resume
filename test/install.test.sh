#!/bin/zsh
set -eu

repo_dir=${0:A:h:h}
test_home=$(mktemp -d "${TMPDIR:-/tmp}/cdx-resume-install.XXXXXX")
trap 'rm -rf "$test_home"' EXIT

HOME="$test_home" \
CDX_RESUME_SKIP_APP_CHECK=1 \
CDX_RESUME_SKIP_LAUNCHCTL=1 \
  "$repo_dir/install.sh"

test -x "$test_home/.codex/safe-switch-proxy/codex"
test -x "$test_home/.codex/safe-switch-proxy/proxy.mjs"
test -f "$test_home/.codex/prompts/goanyway.md"
grep -Fq 'export CODEX_CLI_PATH="$HOME/.codex/safe-switch-proxy/codex"' \
  "$test_home/.zprofile"

HOME="$test_home" "$test_home/.codex/safe-switch-proxy/uninstall.sh"

test ! -f "$test_home/.codex/prompts/goanyway.md"
test -z "$(rg 'safe-switch-proxy/codex' "$test_home/.zprofile" || true)"

print 'install/uninstall test passed'
