#!/bin/zsh
set -eu

repo_dir=${0:A:h}
codex_home="$HOME/.codex"
install_dir="$codex_home/safe-switch-proxy"
legacy_prompt="$codex_home/prompts/goanyway.md"
profile_path="$HOME/.zprofile"
launch_agent="$HOME/Library/LaunchAgents/com.pzs19.cdx-resume.plist"
resources_dir=${CODEX_ELECTRON_RESOURCES_PATH:-/Applications/ChatGPT.app/Contents/Resources}
node_bin="$resources_dir/cua_node/bin/node"

if [[ "${CDX_RESUME_SKIP_APP_CHECK:-0}" != "1" && ! -x "$resources_dir/codex" ]]; then
  print -u2 "Codex CLI was not found at: $resources_dir/codex"
  print -u2 "Install the Codex desktop app in /Applications, or set CODEX_ELECTRON_RESOURCES_PATH."
  exit 1
fi

if [[ ! -x "$node_bin" ]]; then
  node_bin=$(command -v node || true)
fi
if [[ -z "$node_bin" ]]; then
  print -u2 "Node.js was not found."
  exit 1
fi

mkdir -p "$install_dir/test" "$install_dir/logs"

if [[ "$repo_dir" != "$install_dir" ]]; then
  install -m 755 "$repo_dir/codex" "$install_dir/codex"
  install -m 755 "$repo_dir/proxy.mjs" "$install_dir/proxy.mjs"
  install -m 755 "$repo_dir/install.sh" "$install_dir/install.sh"
  install -m 755 "$repo_dir/uninstall.sh" "$install_dir/uninstall.sh"
  install -m 700 "$repo_dir/test/mock-codex.mjs" "$install_dir/test/mock-codex.mjs"
  install -m 700 "$repo_dir/test/recovery.test.mjs" "$install_dir/test/recovery.test.mjs"
  install -m 700 "$repo_dir/test/passthrough.test.mjs" "$install_dir/test/passthrough.test.mjs"
fi

chmod 755 "$install_dir/codex" "$install_dir/proxy.mjs"
chmod 700 "$install_dir/test/"*.mjs
chmod 700 "$install_dir/logs"
rm -f "$install_dir/test/goanyway.test.mjs"
if [[ -f "$legacy_prompt" ]] && grep -Fq '__CODEX_GOANYWAY_RECOVERY__' "$legacy_prompt"; then
  rm "$legacy_prompt"
fi

touch "$profile_path"
if ! grep -Eq '^[[:space:]]*export CODEX_CLI_PATH=.*safe-switch-proxy/codex' "$profile_path"; then
  {
    print ''
    print '# >>> cdx-resume >>>'
    print '# Use the recovery proxy when Codex Desktop starts its bundled CLI.'
    print 'export CODEX_CLI_PATH="$HOME/.codex/safe-switch-proxy/codex"'
    print '# <<< cdx-resume <<<'
  } >> "$profile_path"
fi

if [[ "${CDX_RESUME_SKIP_LAUNCHCTL:-0}" != "1" ]]; then
  mkdir -p "${launch_agent:h}"
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
"$node_bin" "$install_dir/test/passthrough.test.mjs"

print ''
print 'cdx-resume installed successfully.'
print 'Fully quit Codex Desktop with Cmd+Q, then reopen it.'
print 'Recovery will run automatically after a recognized encrypted-content failure.'
