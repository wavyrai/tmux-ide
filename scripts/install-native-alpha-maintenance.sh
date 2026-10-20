#!/bin/sh
# Unreleased next-installer candidate; see scripts/install-native-alpha-maintenance.md.
# Promote as a new immutable release asset and update its dispatcher pin together.
# Deliberately independent of the CLI/daemon installer. Never stops processes.
set -eu
umask 077
fail() { printf 'tmux-ide native alpha: %s\n' "$*" >&2; exit 1; }
action=install
prefix="$HOME/Library/Application Support/tmux-ide/native-alpha"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) [ "$#" -ge 2 ] || fail '--prefix requires a value'; prefix=$2; shift 2 ;;
    --rollback|--uninstall|--update|--recover) [ "$action" = install ] || fail 'Choose one action'; action=${1#--}; shift ;;
    --help) printf '%s\n' 'Usage: install-native-alpha.sh [--prefix ABSOLUTE_PRIVATE_ROOT] [--update|--rollback|--uninstall|--recover]' 'Requires macOS 14.2+, Apple Silicon, and Node 24 from the tmux-ide universal installer.' 'Recovery keeps the currently verified app after an interrupted install; it never selects a previous version automatically.' 'Installs a pinned native alpha. Uninstall detaches it but retains versions/configuration. No daemon or tmux processes are stopped.'; exit 0 ;;
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
# A stable user Applications entry points at the managed alias, never a version.
# Preflight conflicts BEFORE any installer mutation; never replace foreign entries.
applications_entry() {
  "$node" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    const [mode,home,prefix]=process.argv.slice(1);
    const directory=path.join(home,"Applications");
    const entry=path.join(directory,"Tmux IDE Alpha.app");
    const target=path.join(prefix,"TmuxIDE.app");
    const stat=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==="ENOENT")return null;throw e;}};
    const check=()=>{
      const parent=stat(directory);
      if(parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error("Applications directory is not an ordinary directory");
      const current=stat(entry);
      if(current && (!current.isSymbolicLink() || fs.readlinkSync(entry)!==target)) throw new Error("Applications entry already belongs to another app or installation");
      return current;
    };
    try {
      const current=check();
      if(mode==="remove") { if(current) fs.unlinkSync(entry); }
      else if(mode==="create") {
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        if(!check()) fs.symlinkSync(target,entry);
      }
    } catch { console.error("tmux-ide native alpha: Applications entry conflict or operation failed; no foreign entry was replaced"); process.exit(1); }
  ' "$1" "$HOME" "$prefix"
}
applications_entry check
base=https://github.com/wavyrai/tmux-ide/releases/download/native-alpha-2026101702
installer_sha=2f0072b5d843cfdc5328645350dc6d80c668615936155a71555735d5904bf5f4
archive_sha=4633e227a5ecff7cbb867185ccbb248f91fc197e96596c959cb4fa6664547324
scratch=$(mktemp -d "${TMPDIR:-/tmp}/tmux-native-alpha.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --proto-redir '=https' -fLsS --connect-timeout 15 --max-time 300 --max-filesize 536870912 "$1" -o "$2"; }
verify() { actual=$(shasum -a 256 "$1" | awk '{print $1}'); [ "$actual" = "$2" ] || fail 'Downloaded asset checksum mismatch'; }
fetch "$base/tmux-ide-install-v3.mjs" "$scratch/installer.mjs"
verify "$scratch/installer.mjs" "$installer_sha"
printf '%s\n' '{"teamId":"7HWMF997US","bundleId":"com.tmux-ide.gpui.alpha","architecture":"arm64","minimumMacOS":"14.2"}' > "$scratch/policy.json"
mkdir -p "$(dirname "$prefix")"
case "$action" in
  uninstall) "$node" "$scratch/installer.mjs" uninstall --prefix "$prefix" ;;
  recover) "$node" "$scratch/installer.mjs" recover --prefix "$prefix" --policy "$scratch/policy.json" --disposition keep-current ;;
  rollback) "$node" "$scratch/installer.mjs" rollback --prefix "$prefix" --policy "$scratch/policy.json" ;;
  install|update)
    fetch "$base/tmux-ide-gpui-0.1.2-macos-arm64.app.tar.gz" "$scratch/app.tar.gz"
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
    "$node" "$scratch/installer.mjs" "$action" --prefix "$prefix" --policy "$scratch/policy.json" --app "$scratch/TmuxIDE.app" --version 0.1.2-2026101702 ;;
esac
case "$action" in
  uninstall) applications_entry remove ;;
  recover) if [ -d "$prefix/TmuxIDE.app" ]; then applications_entry create; else applications_entry remove; fi ;;
  *) applications_entry create ;;
esac
case "$action" in
  install|update)
    printf '\nNative alpha is installed at:\n  %s/TmuxIDE.app\n' "$prefix"
    printf '\nOpen from your Applications folder:\n  %s/Applications/Tmux IDE Alpha.app\n' "$HOME"
    printf '%s\n' 'If the CLI daemon needs starting or updating, run this separately:' '  ~/.local/bin/tmux-ide update --daemon --json'
    printf '%s\n' 'This installer did not start or stop the daemon or any tmux session.' ;;
  recover)
    if [ -d "$prefix/TmuxIDE.app" ]; then
      printf '\nRecovered the current verified native app at:\n  %s/TmuxIDE.app\n' "$prefix"
    else
      printf '%s\n' 'No installed native app remains. Recovery completed without installing an app; run installation explicitly when ready.'
    fi
    printf '%s\n' 'Recovery did not start or stop any processes or automatically select a previous version.' ;;
  rollback) printf '\nPrevious verified native version restored at:\n  %s/TmuxIDE.app\n' "$prefix" ;;
  uninstall) printf '%s\n' 'Native app detached. Version files and configuration are retained; no processes or tmux sessions were stopped.' ;;
esac
