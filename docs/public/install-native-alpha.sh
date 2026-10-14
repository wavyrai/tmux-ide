#!/bin/sh
# curl -fsSL https://tmux-ide.com/install-native-alpha.sh | sh
# Deliberately independent of the CLI/daemon installer. Never stops processes.
set -eu
umask 077
fail() { printf 'tmux-ide native alpha: %s\n' "$*" >&2; exit 1; }
action=install
prefix="$HOME/Library/Application Support/tmux-ide/native-alpha"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || fail '--prefix requires a value'; prefix=$2; shift 2 ;;
    --rollback|--uninstall|--update) [ "$action" = install ] || fail 'Choose one action'; action=${1#--}; shift ;;
    --help) printf '%s\n' 'Usage: install-native-alpha.sh [--prefix ABSOLUTE_PRIVATE_ROOT] [--update|--rollback|--uninstall]' 'Requires macOS 14.2+, Apple Silicon, and Node 24 from the tmux-ide universal installer.' 'Installs a pinned native alpha. Uninstall detaches it but retains versions/configuration. No daemon or tmux processes are stopped.'; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done
case "$prefix" in /*) ;; *) fail 'Prefix must be absolute' ;; esac
[ "$(uname -s)" = Darwin ] || fail 'Only macOS is supported'
[ "$(uname -m)" = arm64 ] || fail 'Apple Silicon is required (run outside Rosetta)'
os_version=$(sw_vers -productVersion)
printf '%s\n' "$os_version" | awk -F. '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && ($1 > 14 || ($1 == 14 && $2 >= 2)) {ok=1} END {exit !ok}' || fail 'macOS 14.2 or newer is required'
node="$HOME/.local/share/tmux-ide/current/node/bin/node"
[ -f "$node" ] && [ -x "$node" ] || fail 'First run the universal installer: curl -fsSL https://tmux-ide.com/install.sh | sh'
unset NODE_OPTIONS NODE_PATH
case "$("$node" --version)" in v24.*) ;; *) fail 'Managed Node 24 is required; update using https://tmux-ide.com/install.sh' ;; esac
base=https://github.com/wavyrai/tmux-ide/releases/download/native-alpha-2026101406
installer_sha=17cf01adb3d2d46f2b8f9d56c603d4942974b3ec097edd022b621cbb0c0c21c1
archive_sha=c676bdec31f0cebf748e58e0538e3de0944eca825020a830f1eac15af64c2710
scratch=$(mktemp -d "${TMPDIR:-/tmp}/tmux-native-alpha.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --proto-redir '=https' -fLsS --connect-timeout 15 --max-time 300 --max-filesize 536870912 "$1" -o "$2"; }
verify() { actual=$(shasum -a 256 "$1" | awk '{print $1}'); [ "$actual" = "$2" ] || fail 'Downloaded asset checksum mismatch'; }
fetch "$base/tmux-ide-install.mjs" "$scratch/installer.mjs"
verify "$scratch/installer.mjs" "$installer_sha"
printf '%s\n' '{"teamId":"7HWMF997US","bundleId":"com.tmux-ide.gpui.alpha","architecture":"arm64","minimumMacOS":"14.2"}' > "$scratch/policy.json"
mkdir -p "$(dirname "$prefix")"
case "$action" in
  uninstall) "$node" "$scratch/installer.mjs" uninstall --prefix "$prefix" ;;
  rollback) "$node" "$scratch/installer.mjs" rollback --prefix "$prefix" --policy "$scratch/policy.json" ;;
  install|update)
    fetch "$base/tmux-ide-gpui-0.1.0-macos-arm64.app.tar.gz" "$scratch/app.tar.gz"
    verify "$scratch/app.tar.gz" "$archive_sha"
    # Only the pinned, checksum-verified archive reaches tar. Bound both reads.
    "$node" --input-type=module -e '
      import {spawnSync} from "node:child_process";
      const [archive,destination]=process.argv.slice(1);
      const listing=spawnSync("/usr/bin/tar",["-tzf",archive],{encoding:"utf8",timeout:60000,maxBuffer:4*1024*1024});
      if(listing.error || listing.status!==0) process.exit(1);
      const entries=listing.stdout.trimEnd().split("\n");
      if(!entries.length || entries.some(p=>!/^TmuxIDE[.]app(?:\/|$)/.test(p) || p.split("/").includes(".."))) process.exit(1);
      const extraction=spawnSync("/usr/bin/tar",["-xzf",archive,"-C",destination],{stdio:"inherit",timeout:120000});
      if(extraction.error || extraction.status!==0) process.exit(1);
    ' "$scratch/app.tar.gz" "$scratch"
    "$node" "$scratch/installer.mjs" "$action" --prefix "$prefix" --policy "$scratch/policy.json" --app "$scratch/TmuxIDE.app" --version 0.1.0-2026101406 ;;
esac
case "$action" in
  install|update)
    printf '\nNative alpha is installed at:\n  %s/TmuxIDE.app\n' "$prefix"
    printf '%s\n' 'In Finder, choose Go → Go to Folder and paste that app path to open it.'
    printf '%s\n' 'If the CLI daemon needs starting or updating, run this separately:' '  ~/.local/bin/tmux-ide update --daemon --json'
    printf '%s\n' 'This installer did not start or stop the daemon or any tmux session.' ;;
  rollback) printf '\nPrevious verified native version restored at:\n  %s/TmuxIDE.app\n' "$prefix" ;;
  uninstall) printf '%s\n' 'Native app detached. Version files and configuration are retained; no processes or tmux sessions were stopped.' ;;
esac
