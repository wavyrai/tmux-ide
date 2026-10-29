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
# A stable user Applications entry points at the managed alias, never a version.
# Preflight conflicts BEFORE any installer mutation; never replace foreign entries.
applications_entry() {
  "$node" --input-type=module -e '
    import fs from "node:fs";
    import path from "node:path";
    import {spawnSync} from "node:child_process";
    const [mode,home,prefix,action]=process.argv.slice(1);
    const directory=path.join(home,"Applications");
    const entry=path.join(directory,"Tmux IDE Alpha.app");
    const target=path.join(prefix,"TmuxIDE.app");
    const stat=p=>{try{return fs.lstatSync(p);}catch(e){if(e.code==="ENOENT")return null;throw e;}};
    const legacy=()=>{
      if(action!=="install" && action!=="update") return false;
      const contents=stat(path.join(entry,"Contents"));
      const plist=path.join(entry,"Contents/Info.plist");
      if(!contents?.isDirectory() || contents.isSymbolicLink() || !stat(plist)?.isFile() || stat(plist).isSymbolicLink()) return false;
      const result=spawnSync("/usr/bin/plutil",["-extract","CFBundleIdentifier","raw","-o","-",plist],{encoding:"utf8",timeout:5000,maxBuffer:65536});
      return !result.error && result.status===0 && result.stdout.trim()==="com.tmux-ide.gpui.alpha";
    };
    const check=()=>{
      const parent=stat(directory);
      if(parent && (!parent.isDirectory() || parent.isSymbolicLink())) throw new Error("Applications directory is not an ordinary directory");
      const current=stat(entry);
      if(current && !(current.isSymbolicLink() && fs.readlinkSync(entry)===target) && !(current.isDirectory() && legacy())) throw new Error("Applications entry already belongs to another app or installation");
      return current;
    };
    try {
      const current=check();
      if(mode==="remove") { if(current) fs.unlinkSync(entry); }
      else if(mode==="create") {
        fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const previous=check();
        if(previous?.isDirectory()) {
          const backups=path.join(prefix,"app-backups");
          fs.mkdirSync(backups,{recursive:true,mode:0o700});
          const parent=stat(backups);
          if(!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("App backups must be an ordinary directory");
          const backup=fs.mkdtempSync(path.join(backups,"legacy-"));
          const saved=path.join(backup,"Tmux IDE Alpha.app");
          let moved=false;
          try {
            if(!check()?.isDirectory()) throw new Error("Legacy app changed during installation");
            fs.renameSync(entry,saved);
            moved=true;
            fs.symlinkSync(target,entry);
          } catch(error) {
            // Do not replace a newly appeared foreign entry during recovery.
            if(moved && !stat(entry)) fs.renameSync(saved,entry);
            if(!stat(saved)) fs.rmdirSync(backup);
            else console.error("Previous app retained at: "+saved);
            throw error;
          }
          console.log("Previous app retained at: "+saved);
        } else if(!previous) fs.symlinkSync(target,entry);
      }
    } catch { console.error("tmux-ide native alpha: Applications entry conflict or operation failed; no foreign entry was replaced"); process.exit(1); }
  ' "$1" "$HOME" "$prefix" "$action"
}
applications_entry check
base=https://github.com/wavyrai/tmux-ide/releases/download/native-alpha-2026102901
installer_sha=2f0072b5d843cfdc5328645350dc6d80c668615936155a71555735d5904bf5f4
archive_sha=2d1a346e3986e603df4c59a6d16afbcdac3da3e8e31a987b98e1472d8dde01d5
scratch=$(mktemp -d "${TMPDIR:-/tmp}/tmux-native-alpha.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() { curl --proto '=https' --proto-redir '=https' -fLsS --connect-timeout 15 --max-time 300 --max-filesize 536870912 "$1" -o "$2"; }
verify() { actual=$(shasum -a 256 "$1" | awk '{print $1}'); [ "$actual" = "$2" ] || fail 'Downloaded asset checksum mismatch'; }
fetch "$base/tmux-ide-install-v4.mjs" "$scratch/installer.mjs"
verify "$scratch/installer.mjs" "$installer_sha"
printf '%s\n' '{"teamId":"7HWMF997US","bundleId":"com.tmux-ide.gpui.alpha","architecture":"arm64","minimumMacOS":"14.2"}' > "$scratch/policy.json"
mkdir -p "$(dirname "$prefix")"
case "$action" in
  uninstall) "$node" "$scratch/installer.mjs" uninstall --prefix "$prefix" ;;
  rollback) "$node" "$scratch/installer.mjs" rollback --prefix "$prefix" --policy "$scratch/policy.json" ;;
  install|update)
    fetch "$base/tmux-ide-gpui-0.1.11-macos-arm64.app.tar.gz" "$scratch/app.tar.gz"
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
    "$node" "$scratch/installer.mjs" "$action" --prefix "$prefix" --policy "$scratch/policy.json" --app "$scratch/TmuxIDE.app" --version 0.1.11-2026102901 ;;
esac
case "$action" in
  uninstall) applications_entry remove ;;
  *) applications_entry create ;;
esac
case "$action" in
  install|update)
    printf '\nNative alpha is installed at:\n  %s/TmuxIDE.app\n' "$prefix"
    printf '\nOpen from your Applications folder:\n  %s/Applications/Tmux IDE Alpha.app\n' "$HOME"
    printf '%s\n' 'If the CLI daemon needs starting or updating, run this separately:' '  ~/.local/bin/tmux-ide update --daemon --json'
    printf '%s\n' 'This installer did not start or stop the daemon or any tmux session.' ;;
  rollback) printf '\nPrevious verified native version restored at:\n  %s/TmuxIDE.app\n' "$prefix" ;;
  uninstall) printf '%s\n' 'Native app detached. Version files and configuration are retained; no processes or tmux sessions were stopped.' ;;
esac
