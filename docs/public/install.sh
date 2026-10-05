#!/bin/sh
# curl -fsSL https://tmux-ide.com/install.sh | sh
set -eu
fail() { printf 'tmux-ide: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fLsS --retry 3 --connect-timeout 15 --max-time 180 "$1" -o "$2"; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}
main() {
  action=install
  version=latest
  prefix=${TMUX_IDE_INSTALL_PREFIX:-"$HOME/.local"}
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--prefix)
        [ "$#" -ge 2 ] || fail "$1 requires a value"
        case "$1" in --version) version=$2 ;; --prefix) prefix=$2 ;; esac
        shift 2 ;;
      --rollback|--uninstall) [ "$action" = install ] || fail 'Choose one action'; action=${1#--}; shift ;;
      --help) printf 'Usage: install.sh [--version VERSION|beta|latest] [--prefix ABSOLUTE_PATH] [--rollback|--uninstall]\nRollback needs a previous successful install. Uninstall removes the launcher, preserves sessions and data, and retains runtime files for running processes.\n'; return ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  case "$prefix" in /*) ;; *) fail 'Install prefix must be absolute' ;; esac
  case "$version" in ''|*[!a-zA-Z0-9.+-]*) fail 'Invalid version or channel' ;; esac
  root="$prefix/share/tmux-ide"
  launcher="$prefix/bin/tmux-ide"
  if [ -e "$launcher" ] || [ -L "$launcher" ]; then
    [ -f "$root/installer-v1" ] && grep -q '^# tmux-ide universal installer v1$' "$launcher" || fail "Refusing to replace an unmanaged installation at $launcher"
  fi
  mkdir -p "$root/releases" "$prefix/bin"
  mkdir "$root/install.lock" 2>/dev/null || fail "Another installation is running (lock: $root/install.lock)"
  stage=''
  trap '[ -z "$stage" ] || rm -rf "$stage"; rmdir "$root/install.lock" 2>/dev/null || true' 0
  trap 'exit 1' INT TERM
  if [ "$action" != install ]; then
    [ -f "$root/installer-v1" ] || fail 'No managed installation found at this prefix'
    [ -x "$root/current/node/bin/node" ] || fail 'Installed Node.js is unavailable; reinstall at this prefix to repair it'
    "$root/current/node/bin/node" --input-type=module - "$root" "$launcher" "$action" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [root, launcher, action] = process.argv.slice(2);
const current = path.join(root, 'current');
const previous = path.join(root, 'previous');
const unlink = file => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const release = link => {
  const target = fs.realpathSync(link);
  if (path.dirname(target) !== fs.realpathSync(path.join(root, 'releases')) || !path.basename(target).startsWith('install-'))
    throw new Error('Refusing to use a release outside this managed installation');
  return target;
};
const switchLink = (target, link) => {
  const temporary = `${link}.next`;
  unlink(temporary);
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
};
if (action === 'rollback') {
  const active = release(current);
  let target;
  try { target = release(previous); } catch { throw new Error('No valid previous release is available for rollback'); }
  const pkg = path.join(target, 'npm/lib/node_modules/tmux-ide');
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  const actual = execFileSync(path.join(target, 'node/bin/node'), [path.join(pkg, 'bin/cli.js'), '--version'], {encoding: 'utf8', timeout: 30000}).trim();
  if (actual !== `tmux-ide v${version}`) throw new Error('Previous release failed its version check; current installation unchanged');
  switchLink(target, current);
  try { switchLink(active, previous); } catch (error) { switchLink(active, current); throw error; }
  console.log(`Rolled back to ${version}. Existing sessions are preserved. Reopen tmux-ide to use this release.`);
} else {
  release(current);
  fs.unlinkSync(launcher);
  fs.unlinkSync(current);
  unlink(previous);
  fs.unlinkSync(path.join(root, 'installer-v1'));
  console.log(`Uninstalled the launcher. Sessions, settings and runtime files are preserved. After all tmux-ide processes have exited, you may remove ${path.join(root, 'releases')}.`);
}
JS
    return
  fi
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux; getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Linux requires glibc (musl/Alpine is not supported)' ;;
    *) fail 'Supported systems: macOS and glibc Linux, including supported WSL distributions' ;;
  esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Supported architectures: ARM64 and x64' ;; esac
  for tool in curl tar gzip awk mktemp grep; do command -v "$tool" >/dev/null 2>&1 || fail "Missing required tool: $tool"; done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail 'A SHA-256 tool is required'
  stage=$(mktemp -d "$root/releases/.install.XXXXXX")
  printf 'Installing tmux-ide@%s for %s-%s…\n' "$version" "$os" "$arch"
  fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt "$stage/SHASUMS256.txt"
  archive=$(awk -v suffix="-$os-$arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$stage/SHASUMS256.txt")
  case "$archive" in ''|*[!a-zA-Z0-9.-]*) fail 'Could not resolve an official Node.js archive' ;; esac
  expected=$(awk -v file="$archive" '$2==file {print $1}' "$stage/SHASUMS256.txt")
  [ "${#expected}" -eq 64 ] || fail 'Invalid Node.js checksum manifest'
  node_version=${archive#node-}
  node_version=${node_version%%-*}
  fetch "https://nodejs.org/dist/$node_version/$archive" "$stage/node.tar.gz"
  [ "$(digest "$stage/node.tar.gz")" = "$expected" ] || fail 'Node.js checksum mismatch'
  mkdir "$stage/node"
  tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/node"
  export PATH="$stage/node/bin:$PATH"
  # Prepare without touching a running daemon. Its supported upgrade runs only
  # after the verified installation has moved to its permanent location.
  TMUX_IDE_RUNTIME_MODE=development npm install --global --prefix "$stage/npm" "tmux-ide@$version"
  cli="$stage/npm/lib/node_modules/tmux-ide/bin/cli.js"
  installed=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$stage/npm/lib/node_modules/tmux-ide/package.json")
  [ "$(node "$cli" --version)" = "tmux-ide v$installed" ] || fail 'Installed CLI version does not match its package'
  case "$version" in [0-9]*.*.*) [ "$installed" = "$version" ] || fail 'Installed package does not match the requested version' ;; esac
  native="$stage/npm/lib/node_modules/tmux-ide/packages/daemon/dist/native/tmux/$os-$arch/tmux"
  [ -f "$native" ] || fail "This version does not bundle tmux for $os-$arch; the existing installation is unchanged"
  node --input-type=module - "$(dirname "$native")/manifest.json" <<'JS'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const bundle = path.dirname(process.argv[2]);
if (manifest.platform !== process.platform || manifest.arch !== process.arch || !manifest.files?.tmux)
  throw new Error('Bundled tmux platform or checksum manifest is invalid');
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.resolve(bundle, file);
  if (!target.startsWith(bundle + path.sep) || !fs.realpathSync(target).startsWith(fs.realpathSync(bundle) + path.sep) || !/^[a-f0-9]{64}$/.test(expected))
    throw new Error('Invalid bundled tmux file manifest');
  const actual = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  if (actual !== expected) throw new Error(`Bundled tmux checksum mismatch: ${file}`);
}
const mac = process.platform === 'darwin';
const minimum = mac ? manifest.minimumMacOS : manifest.minimumGlibc;
const current = mac
  ? execFileSync('/usr/bin/sw_vers', ['-productVersion'], {encoding: 'utf8'}).trim()
  : process.report.getReport().header.glibcVersionRuntime;
const parts = value => String(value).split('.').map(Number);
const required = parts(minimum), installed = parts(current);
if (!minimum || !current || required.some(Number.isNaN) || installed.some(Number.isNaN)) throw new Error('Cannot verify bundled tmux OS requirements');
let compatible = true;
for (let i = 0; i < Math.max(required.length, installed.length); i++) {
  const difference = (installed[i] || 0) - (required[i] || 0);
  if (difference) { compatible = difference > 0; break; }
}
if (!compatible) throw new Error(`Bundled tmux requires ${mac ? 'macOS' : 'glibc'} ${minimum}+; found ${current}. Existing installation unchanged.`);
JS
  chmod +x "$native"
  native_version=$("$native" -V)
  printf '%s\n' "$native_version" | awk '$1 == "tmux" && $2 ~ /^[0-9]+\.[0-9]+[a-z]?$/ { split($2, v, "."); if (v[1]+0 > 3 || (v[1]+0 == 3 && v[2]+0 >= 7)) ok=1 } END { exit !ok }' || fail 'Bundled tmux must be version 3.7 or newer'
  printf '%s\n' "$native_version"
  node "$cli" update --tui-binary
  rm "$stage/node.tar.gz" "$stage/SHASUMS256.txt"
  node --input-type=module - "$root" "$prefix" "$stage" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [root, prefix, stage] = process.argv.slice(2);
const destination = path.join(root, 'releases', path.basename(stage).replace('.install.', 'install-'));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = `#!/bin/sh\n# tmux-ide universal installer v1\nroot=${quote(root)}\nexport PATH="$root/current/node/bin:$PATH"\nexport npm_config_prefix="$root/current/npm"\nexec "$root/current/node/bin/node" "$root/current/npm/lib/node_modules/tmux-ide/bin/cli.js" "$@"\n`;
const current = path.join(root, 'current');
const previous = path.join(root, 'previous');
const unlink = file => { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const marker = path.join(root, 'installer-v1');
const launcherPath = path.join(prefix, 'bin', 'tmux-ide');
const temporaryLauncher = path.join(prefix, 'bin', '.tmux-ide-install');
const next = path.join(root, 'current.next');
const readLink = file => { try { return fs.readlinkSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const oldCurrent = readLink(current), oldPrevious = readLink(previous);
const oldLauncher = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath) : null;
const oldMarker = fs.existsSync(marker);
const replaceLink = (target, link) => {
  const temporary = `${link}.next`;
  unlink(temporary);
  if (target === null) unlink(link);
  else { fs.symlinkSync(target, temporary); fs.renameSync(temporary, link); }
};
let activated = false;
try {
  fs.renameSync(stage, destination);
  const node = path.join(destination, 'node/bin/node');
  const pkg = path.join(destination, 'npm/lib/node_modules/tmux-ide');
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  const env = {...process.env, PATH: `${path.join(destination, 'node/bin')}:${process.env.PATH}`, npm_config_global: 'false', npm_config_prefix: path.join(destination, 'npm')};
  // Complete package setup at its final path before switching the active release.
  // Global host integration and daemon upgrades are explicit follow-up actions.
  execFileSync(node, [path.join(pkg, 'scripts/postinstall.js')], {env, stdio: 'inherit', timeout: 60000});
  const actual = execFileSync(node, [path.join(pkg, 'bin/cli.js'), '--version'], {env, encoding: 'utf8', timeout: 30000}).trim();
  if (actual !== `tmux-ide v${version}`) throw new Error('Relocated CLI failed its version check');
  fs.writeFileSync(temporaryLauncher, launcher, {mode: 0o755});
  fs.writeFileSync(marker, '1\n');
  if (oldCurrent) replaceLink(oldCurrent, previous);
  replaceLink(destination, current);
  activated = true;
  fs.renameSync(temporaryLauncher, launcherPath);
} catch (error) {
  if (activated) replaceLink(oldCurrent, current);
  replaceLink(oldPrevious, previous);
  if (!oldMarker) unlink(marker);
  if (oldLauncher) fs.writeFileSync(launcherPath, oldLauncher, {mode: 0o755});
  else unlink(launcherPath);
  fs.rmSync(destination, {recursive: true, force: true});
  throw error;
} finally {
  unlink(temporaryLauncher);
  unlink(next);
}
console.log(`Add this to your shell profile if needed:\n  export PATH=${quote(path.join(prefix, 'bin'))}:"$PATH"`);
JS
  export PATH="$root/current/node/bin:$PATH"
  "$launcher" --version
  printf '\nInstalled. Start with: %s\nExisting tmux sessions are preserved. Reopen any running tmux-ide UI.\nTo update a running daemon explicitly: tmux-ide update --daemon --if-running\n' "$launcher"
}
main "$@"
