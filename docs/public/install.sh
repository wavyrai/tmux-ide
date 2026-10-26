#!/bin/sh
# curl -fsSL https://tmux-ide.com/install.sh | sh
set -eu
fail() { printf 'tmux-ide: %s\n' "$*" >&2; exit 1; }
fetch() { curl -fLsS --retry 3 --connect-timeout 15 --max-time 180 "$1" -o "$2"; }
digest() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'
}
if [ -t 1 ]; then step_mark=$(printf '\033[32m>\033[0m'); else step_mark='>'; fi
step() { printf '  %s %s\n' "$step_mark" "$*"; }
# Show captured tool output only when that step fails.
show_log() { [ ! -s "$1" ] || tail -n 20 "$1" | sed 's/^/    /' >&2; }
# Move an older daemon onto the active managed release: first repoint macOS
# launchd jobs that start another tmux-ide copy (their KeepAlive would otherwise
# relaunch it), then retire a running older daemon. tmux sessions keep running.
reconcile_daemon() {
  reconcile_root="$1/share/tmux-ide"
  "$reconcile_root/current/node/bin/node" --input-type=module - "$reconcile_root" "$1" "$2" <<'JS'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [root, prefix, upgrade] = process.argv.slice(2);
const launcher = path.join(prefix, 'bin', 'tmux-ide');
const onPath = (process.env.PATH || '').split(':').filter(Boolean)
  .map(directory => path.join(path.resolve(directory), 'tmux-ide'))
  .find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const command = onPath === launcher ? 'tmux-ide' : "'" + launcher.replaceAll("'", "'\\''") + "'";
const version = JSON.parse(fs.readFileSync(path.join(root, 'current/npm/lib/node_modules/tmux-ide/package.json'), 'utf8')).version;
const run = (file, args, timeout = 30000) => spawnSync(file, args, {encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe']});
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const note = message => console.log(`  > ${message}`);
const warn = message => console.log(`  ! ${message}`);
const infoDir = process.env.TMUX_IDE_DAEMON_INFO_DIR || process.env.TMUX_IDE_REGISTRY_DIR || process.env.TMUX_IDE_HOME || path.join(os.homedir(), '.tmux-ide');
const infoPath = path.join(infoDir, 'daemon.json');
const readInfo = () => { try { return JSON.parse(fs.readFileSync(infoPath, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const compare = (a, b) => {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
};
if (process.platform === 'darwin') {
  const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  let names = [];
  try { names = fs.readdirSync(agents).filter(name => /^com\.tmux-ide\.[A-Za-z0-9._-]+\.plist$/.test(name)).sort(); } catch {}
  for (const name of names) {
    const file = path.join(agents, name);
    const label = name.slice(0, -'.plist'.length);
    const target = `gui/${process.getuid()}/${label}`;
    let args;
    try {
      const parsed = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', file]);
      if (parsed.status === 0) args = JSON.parse(parsed.stdout).ProgramArguments;
    } catch {}
    if (!Array.isArray(args) || typeof args[0] !== 'string' || !path.isAbsolute(args[0]) || path.basename(args[0]) !== 'tmux-ide' || !args.includes('--headless') || args[0] === launcher) continue;
    // Definitions owned by `tmux-ide daemon service` carry an ownership record; re-register them instead.
    if (/^com\.tmux-ide\.[0-9a-f]{24}$/.test(label)) {
      warn(`launchd service ${label} still starts ${args[0]}. Re-register it with: ${command} daemon service remove --yes && ${command} daemon service install ${JSON.stringify(launcher)}`);
      continue;
    }
    const owner = run(args[0], ['--version'], 15000);
    const ownerVersion = /^tmux-ide v(\S+)$/.exec(String(owner.stdout).trim())?.[1];
    // A missing executable is stale by definition; never take a job from a newer or unrecognized copy.
    if (owner.error?.code !== 'ENOENT') {
      const order = ownerVersion ? compare(ownerVersion, version) : null;
      if (order === null || order > 0) {
        warn(`launchd job ${label} starts tmux-ide ${ownerVersion ?? '(unrecognized version)'} from ${args[0]}; left unchanged.`);
        continue;
      }
    }
    if (upgrade !== '1') {
      warn(`launchd job ${label} still starts ${args[0]}${ownerVersion ? ` (${ownerVersion})` : ''}. Rerun the installer without --no-daemon-upgrade to move it to this installation.`);
      continue;
    }
    const backups = path.join(root, 'service-backups');
    const backup = path.join(backups, `${label}.${Date.now()}.plist`);
    const next = `${file}.tmux-ide-next`;
    try {
      fs.mkdirSync(backups, {recursive: true, mode: 0o700});
      fs.copyFileSync(file, backup);
      fs.copyFileSync(file, next);
      const edit = (...edit) => { if (run('/usr/bin/plutil', [...edit, next]).status !== 0) throw new Error('plutil'); };
      // -replace inserts into arrays; swap the executable explicitly.
      edit('-remove', 'ProgramArguments.0');
      edit('-insert', 'ProgramArguments.0', '-string', launcher);
      const environment = run('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.PATH', 'raw', '-o', '-', next]);
      if (environment.status === 0) {
        const bin = path.join(prefix, 'bin');
        edit('-replace', 'EnvironmentVariables.PATH', '-string', [bin, ...environment.stdout.trim().split(':').filter(entry => entry && entry !== bin)].join(':'));
      }
      // Leave tmux servers and panes running when launchd stops this job.
      edit('-replace', 'AbandonProcessGroup', '-bool', 'YES');
      edit('-lint');
      fs.renameSync(next, file);
    } catch {
      fs.rmSync(next, {force: true});
      warn(`Could not update launchd job ${label}; it still starts ${args[0]}.`);
      continue;
    }
    const loaded = () => run('launchctl', ['print', target]).status === 0;
    if (!loaded()) {
      note(`launchd job ${label} now starts ${launcher}; it applies when the job next loads.`);
      continue;
    }
    // bootout lets the daemon release ownership gracefully (SIGTERM).
    run('launchctl', ['bootout', target], 60000);
    for (let i = 0; i < 150 && loaded(); i++) sleep(200);
    const supervised = args.indexOf('--supervised');
    if (supervised > 0 && args[supervised + 1] && !fs.existsSync(infoPath))
      run(launcher, ['daemon', 'reserve-supervisor', args[supervised + 1], '--json']);
    if (loaded() || run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]).status !== 0) {
      fs.copyFileSync(backup, file);
      if (!loaded()) run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
      warn(`Could not restart launchd job ${label}; restored its previous definition. Your sessions are safe.`);
      continue;
    }
    let started = false;
    for (let i = 0; i < 150 && !started; i++) {
      const info = readInfo();
      started = info?.productVersion === version && Number.isInteger(info.pid) && alive(info.pid);
      if (!started) sleep(200);
    }
    note(`Moved launchd job ${label} from ${args[0]} to this installation (backup: ${backup}).`);
    if (!started) warn(`Its daemon has not reported ${version} yet; check ${command} daemon info --json and the job's log.`);
  }
}
const info = readInfo();
if (info && Number.isInteger(info.pid) && typeof info.productVersion === 'string' && info.productVersion !== version && (alive(info.pid) || info.supervisionId)) {
  if (upgrade !== '1') {
    console.log(`\n  A tmux-ide ${info.productVersion} daemon is still running; your sessions are safe.\n  Move it to ${version}:  ${command} update --daemon --if-running`);
  } else {
    const result = run(launcher, ['update', '--daemon', '--if-running', '--json'], 120000);
    let status;
    try { status = JSON.parse(String(result.stdout).trim().split('\n').at(-1)); } catch {}
    if (result.status === 0 && status?.status === 'ready') note(`Restarted the daemon on ${status.productVersion}; tmux sessions kept running.`);
    else if (result.status !== 0 || status?.status !== 'not-running')
      warn(`The tmux-ide ${info.productVersion} daemon could not be moved to ${version}; your sessions are safe. Retry: ${command} update --daemon`);
  }
}
JS
}
main() {
  action=install
  confirmed=false
  version=latest
  prefix=${TMUX_IDE_INSTALL_PREFIX:-"$HOME/.local"}
  agent_teams=1
  [ "${TMUX_IDE_NO_CLAUDE_AGENT_TEAMS:-}" != 1 ] || agent_teams=0
  daemon_upgrade=1
  [ "${TMUX_IDE_NO_DAEMON_UPGRADE:-}" != 1 ] || daemon_upgrade=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--prefix)
        [ "$#" -ge 2 ] || fail "$1 requires a value"
        case "$1" in --version) version=$2 ;; --prefix) prefix=$2 ;; esac
        shift 2 ;;
      --rollback|--uninstall|--prune) [ "$action" = install ] || fail 'Choose one action'; action=${1#--}; shift ;;
      --yes) confirmed=true; shift ;;
      --no-claude-agent-teams) agent_teams=0; shift ;;
      --no-daemon-upgrade) daemon_upgrade=0; shift ;;
      --help) printf 'Usage: install.sh [--version VERSION|beta|latest] [--prefix ABSOLUTE_PATH] [--no-claude-agent-teams] [--no-daemon-upgrade] [--rollback|--uninstall|--prune --yes]\nInstall enables Claude Code agent teams in ~/.claude/settings.json when Claude Code is present and you have not disabled them; opt out with --no-claude-agent-teams or TMUX_IDE_NO_CLAUDE_AGENT_TEAMS=1.\nInstall moves a running older daemon, and macOS launchd jobs that start an older tmux-ide copy, to this installation; tmux sessions keep running. Opt out with --no-daemon-upgrade or TMUX_IDE_NO_DAEMON_UPGRADE=1.\nPrune requires all tmux-ide processes and services to be stopped; it keeps current and previous releases.\nRollback needs a previous successful install. Uninstall removes the launcher, preserves sessions and data, and retains runtime files for running processes.\n'; return ;;
      *) fail "Unknown option: $1" ;;
    esac
  done
  [ "$confirmed" = false ] || [ "$action" = prune ] || fail '--yes is only valid with --prune'
  [ "$daemon_upgrade" = 1 ] || [ "$action" = install ] || fail '--no-daemon-upgrade is only valid when installing'
  [ "$action" != prune ] || [ "$confirmed" = true ] || fail 'Prune requires --yes after stopping all tmux-ide processes and services; ordinary tmux sessions may remain running'
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
  candidate=''
  trap '[ -z "$stage" ] || rm -rf "$stage"; if [ -n "$candidate" ] && [ ! "$candidate" -ef "$root/current" ] && [ ! "$candidate" -ef "$root/previous" ]; then rm -rf "$candidate"; fi; rmdir "$root/install.lock" 2>/dev/null || true' 0
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
} else if (action === 'prune') {
  const keep = new Set([release(current)]);
  try { keep.add(release(previous)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let removed = 0;
  for (const entry of fs.readdirSync(path.join(root, 'releases'), {withFileTypes: true})) {
    if (!entry.isDirectory() || !/^install-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const target = path.join(root, 'releases', entry.name);
    if (keep.has(fs.realpathSync(target))) continue;
    const marker = path.join(target, '.installer-release-v1');
    try {
      if (!fs.lstatSync(marker).isFile() || fs.readFileSync(marker, 'utf8') !== '1\n') continue;
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fs.rmSync(target, {recursive: true});
    removed++;
  }
  console.log(`Removed ${removed} retired releases; current, rollback and unrecognized files are preserved.`);
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
  # Bound disk growth without guessing which old runtime a live process uses.
  # Cleanup is explicit because unlinking a loaded runtime can break later I/O.
  retained=0
  for retained_release in "$root"/releases/install-*; do
    [ -d "$retained_release" ] && [ ! -L "$retained_release" ] && [ -f "$retained_release/.installer-release-v1" ] || continue
    retained=$((retained + 1))
  done
  [ "$retained" -lt 8 ] || fail 'Eight retained releases reached. Stop tmux-ide processes and services, then rerun this script with the same --prefix and --prune --yes. Ordinary tmux sessions may remain running.'
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux; getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Linux requires glibc (musl/Alpine is not supported)' ;;
    *) fail 'Supported systems: macOS and glibc Linux, including supported WSL distributions' ;;
  esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Supported architectures: ARM64 and x64' ;; esac
  [ "$os-$arch" != darwin-x64 ] || fail 'Intel Macs are not supported; tmux-ide on macOS requires Apple Silicon'
  for tool in curl tar gzip awk mktemp grep; do command -v "$tool" >/dev/null 2>&1 || fail "Missing required tool: $tool"; done
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail 'A SHA-256 tool is required'
  stage=$(mktemp -d "$root/releases/.install.XXXXXX")
  candidate="$root/releases/install-${stage##*.install.}"
  case "$os" in darwin) platform='macOS · Apple Silicon' ;; *) platform="Linux · $arch" ;; esac
  printf '\n  tmux-ide installer · tmux-ide.com\n\n'
  step "$platform"
  case "$version" in latest) step 'Downloading tmux-ide…' ;; *) step "Downloading tmux-ide ${version}…" ;; esac
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
  # Dependency lifecycle scripts are unnecessary here: native modules ship
  # prebuilt binaries for every supported platform, and tmux-ide's own
  # postinstall runs explicitly once the release is in place. Skipping them
  # also avoids running third-party install scripts and npm's allowScripts warning.
  if ! TMUX_IDE_RUNTIME_MODE=development npm install --global --ignore-scripts --prefix "$stage/npm" "tmux-ide@$version" >"$stage/npm.log" 2>&1; then
    show_log "$stage/npm.log"
    fail "npm could not install tmux-ide@$version; the existing installation is unchanged"
  fi
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
  if ! node "$cli" update --tui-binary >"$stage/runtime.log" 2>&1; then
    show_log "$stage/runtime.log"
    fail 'Could not download the tmux-ide app runtime; the existing installation is unchanged'
  fi
  step "Verified tmux-ide $installed, its app runtime and bundled $native_version"
  rm "$stage/node.tar.gz" "$stage/SHASUMS256.txt" "$stage/npm.log" "$stage/runtime.log"
  node --input-type=module - "$root" "$prefix" "$stage" "$agent_teams" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [root, prefix, stage, agentTeams] = process.argv.slice(2);
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
let version;
try {
  fs.renameSync(stage, destination);
  const node = path.join(destination, 'node/bin/node');
  const pkg = path.join(destination, 'npm/lib/node_modules/tmux-ide');
  version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  const env = {...process.env, PATH: `${path.join(destination, 'node/bin')}:${process.env.PATH}`, npm_config_global: 'false', npm_config_prefix: path.join(destination, 'npm')};
  // Complete package setup at its final path before switching the active release.
  // Daemon upgrades and other host integrations are explicit follow-up actions;
  // the one default (opt-out) host step, Claude Code agent teams, runs after activation.
  execFileSync(node, [path.join(pkg, 'scripts/postinstall.js')], {env, stdio: 'inherit', timeout: 60000});
  const actual = execFileSync(node, [path.join(pkg, 'bin/cli.js'), '--version'], {env, encoding: 'utf8', timeout: 30000}).trim();
  if (actual !== `tmux-ide v${version}`) throw new Error('Relocated CLI failed its version check');
  fs.writeFileSync(path.join(destination, '.installer-release-v1'), '1\n', {mode: 0o600, flag: 'wx'});
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
// Best-effort and opt-out: never fails the install, never overrides a user's
// explicit "0", and skips quietly when Claude Code is not installed.
if (agentTeams === '1') {
  try {
    const out = execFileSync(launcherPath, ['integration', 'agent-teams', 'enable', '--if-not-disabled'], {encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']});
    if (out.trim()) console.log(`  > ${out.trim()}`);
  } catch (error) {
    const detail = String(error.stdout || error.stderr || error.message).trim().split('\n')[0];
    if (detail.startsWith('Usage: tmux-ide integration <')) console.log('  > This tmux-ide version cannot configure Claude Code agent teams; skipped.');
    else console.log(`  ! Warning: could not configure Claude Code agent teams (${detail}). Retry: ${quote(launcherPath)} integration agent-teams enable`);
  }
} else {
  console.log('  > Skipped Claude Code agent teams (opted out). Enable later: tmux-ide integration agent-teams enable');
}
// Offer the short command only when it resolves to this installation.
const bin = path.join(prefix, 'bin');
const firstOnPath = (process.env.PATH || '').split(':').filter(Boolean)
  .map((directory) => path.join(path.resolve(directory), 'tmux-ide'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
const command = firstOnPath === launcherPath ? 'tmux-ide' : quote(launcherPath);
console.log(`\n  ✓ Installed successfully. tmux-ide ${version} is ready.\n\n  Start:   ${command} app\n  Update:  ${command} update`);
if (firstOnPath === undefined)
  console.log(`\n  To run it as plain \`tmux-ide\`, add this line to your shell profile:\n    export PATH=${quote(bin)}:"$PATH"`);
else if (firstOnPath !== launcherPath) {
  // Name the shadowing copy without running it: a global npm package records its version.
  let other = '', removal = '';
  try {
    const real = fs.realpathSync(firstOnPath);
    if (/\/lib\/node_modules\/tmux-ide\/bin\/cli\.js$/.test(real)) {
      other = ` ${JSON.parse(fs.readFileSync(path.join(path.dirname(real), '../package.json'), 'utf8')).version}`;
      const npm = path.join(path.dirname(firstOnPath), 'npm');
      if (fs.existsSync(npm)) removal = `\n    Remove it:  ${quote(npm)} uninstall -g tmux-ide`;
    }
  } catch {}
  console.log(`\n  ! Another tmux-ide${other} comes first on your PATH (${firstOnPath}),\n    so \`tmux-ide\` still runs that copy instead of ${version}.${removal}\n    ${removal ? 'Or put' : 'Remove it, or put'} this installation first by adding this line at the end of your shell profile:\n      export PATH=${quote(bin)}:"$PATH"\n    Then open a new shell (or run: hash -r).`);
}
JS
  export PATH="$root/current/node/bin:$PATH"
  "$launcher" --version >/dev/null
  reconcile_daemon "$prefix" "$daemon_upgrade" || printf '  ! Could not check the running daemon; your sessions are safe. Retry: %s update --daemon\n' "$launcher"
  printf '\n'
}
# Native alpha is explicit; ordinary CLI installs keep their existing behavior.
if [ "${1:-}" = --native-alpha ]; then
  shift
  if [ "${1:-}" = --help ]; then
    printf '%s\n' 'Usage: install.sh --native-alpha [--prefix ABSOLUTE_NATIVE_ROOT] [--update|--rollback|--uninstall]' 'Apple Silicon macOS 26+. Bootstraps CLI 2.9.13; upgrades older stable CLI versions and preserves 2.9.13; newer or unrecognized versions require explicit review; native actions preserve daemon and tmux processes.'
    exit 0
  fi
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'Native alpha requires an Apple Silicon Mac'
  native_validate() {
    native_action_seen=false
    native_action=install
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --prefix) [ "$#" -ge 2 ] || fail '--prefix requires a value'; case "$2" in /*) ;; *) fail 'Native prefix must be absolute' ;; esac; shift 2 ;;
        --update|--rollback|--uninstall) [ "$native_action_seen" = false ] || fail 'Choose one native action'; native_action_seen=true; native_action=${1#--}; shift ;;
        *) fail "Unknown native option: $1" ;;
      esac
    done
  }
  native_validate "$@"
  native_os=$(sw_vers -productVersion)
  [ "${native_os%%.*}" -ge 26 ] || fail 'The complete native alpha + CLI installation requires macOS 26 or newer'
  native_cli_needed=false
  if [ ! -x "$HOME/.local/share/tmux-ide/current/node/bin/node" ]; then
    case "$native_action" in rollback|uninstall) fail 'Managed CLI runtime is missing; restore it before native maintenance' ;; esac
    native_cli_needed=true
  fi
  case "$native_action" in
    install|update)
      native_cli_version=''
      if [ -x "$HOME/.local/bin/tmux-ide" ]; then
        native_cli_version=$("$HOME/.local/bin/tmux-ide" --version 2>/dev/null) || fail 'Existing CLI preserved: its version could not be read; repair or review it explicitly before continuing'
        [ -n "$native_cli_version" ] || fail 'Existing CLI preserved: its version could not be read; repair or review it explicitly before continuing'
      fi
      case "$native_cli_version" in
        'tmux-ide v2.9.13') ;;
        '') native_cli_needed=true ;;
        *)
          # Only upgrade a recognized older stable release. Unknown/newer
          # installations are never replaced by this pinned prerequisite.
          if printf '%s\n' "$native_cli_version" | awk '
            /^tmux-ide v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/ {
              sub(/^tmux-ide v/, ""); split($0, v, ".");
              older = v[1] < 2 || (v[1] == 2 && (v[2] < 9 || (v[2] == 9 && v[3] < 13)));
              count++;
            }
            END { exit !(count == 1 && NR == 1 && older) }
          '; then
            native_cli_needed=true
          else
            fail 'Existing CLI preserved: its version is not qualified for this pinned native bootstrap; review it explicitly before continuing'
          fi ;;
      esac ;;
  esac
  if [ "$native_cli_needed" = true ]; then
    (main --version 2.9.13 --prefix "$HOME/.local" --no-claude-agent-teams)
  elif [ "$native_action" = install ] || [ "$native_action" = update ]; then
    # The pinned CLI is already current; still move a stale daemon or launchd job onto it.
    native_upgrade=1
    [ "${TMUX_IDE_NO_DAEMON_UPGRADE:-}" != 1 ] || native_upgrade=0
    reconcile_daemon "$HOME/.local" "$native_upgrade" || printf '  ! Could not check the running daemon; your sessions are safe. Retry: %s update --daemon\n' "$HOME/.local/bin/tmux-ide"
  fi
  native_stage=$(mktemp -d "${TMPDIR:-/tmp}/tmux-native-bootstrap.XXXXXXXX")
  trap 'rm -rf "$native_stage"' 0
  trap 'exit 1' INT TERM
  fetch https://github.com/wavyrai/tmux-ide/releases/download/native-alpha-2026102601/install-native-alpha-v4.sh "$native_stage/install.sh"
  [ "$(digest "$native_stage/install.sh")" = 84337c334f00e3f44ae5d208dd061a796363860a0c55ac9ee19b6159ec8ff070 ] || fail 'Native installer checksum mismatch'
  sh "$native_stage/install.sh" "$@"
else
  main "$@"
fi
