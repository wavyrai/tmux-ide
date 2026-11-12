import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";

/**
 * No test may reach a live tmux server.
 *
 * How a daemon picks its server (lib/workspace-pane-creation.ts
 * resolveWorkspacePaneTmuxAuthority, lib/runtime-namespace.ts):
 *   1. TMUX_IDE_TMUX_SOCKET_PATH or TMUX_IDE_TMUX_SOCKET_NAME: explicit;
 *   2. else the socket named in TMUX;
 *   3. else the socket NAME "default".
 * Its tmux clients run with a scrubbed environment (tmuxClientEnvironment drops
 * TMUX_TMPDIR on purpose), so case 3 is always /tmp/tmux-<uid>/default: the
 * developer's own server. Exporting TMUX_TMPDIR does not isolate a daemon.
 *
 * So the test run puts a guard in front of tmux itself. Every tmux call a
 * test makes, directly or through product code, goes through a wrapper that
 * refuses and records any call that would reach a shared server, and the run
 * fails if anything was refused.
 */
const PRIVATE_PREFIX = "tmux-ide-test-";
export const TMUX_GUARD_REFUSAL_EXIT_CODE = 97;

export interface TmuxGuard {
  readonly directory: string;
  /** The wrapper: first on PATH, so `tmux` resolves to it. */
  readonly executable: string;
  readonly log: string;
  readonly created: boolean;
}

function findRealTmux(environment: NodeJS.ProcessEnv): string | null {
  for (const entry of (environment.PATH ?? "").split(delimiter)) {
    if (!entry.startsWith("/") || entry.includes(PRIVATE_PREFIX)) continue;
    const candidate = join(entry, "tmux");
    try {
      const real = realpathSync(candidate);
      execFileSync(real, ["-V"], { stdio: "ignore", timeout: 3000 });
      return real;
    } catch {
      /* Not here. */
    }
  }
  return null;
}

/**
 * POSIX sh, absolute paths only: product code runs tmux without PATH.
 *
 * tmux finds a server in one of three ways, and the wrapper makes each safe:
 *   -S <path>      explicit path. Allowed below a temp dir; a path in
 *                  /tmp/tmux-<uid>/ or outside any temp dir is REFUSED (exit 97)
 *                  and recorded: nothing but a live server lives there.
 *   -L <name>,     resolved inside $TMUX_TMPDIR. If that is not a private
 *   or neither     directory (a daemon's clients have none at all), the call is
 *                  REDIRECTED into the guard's own directory: the test gets an
 *                  empty private namespace, exactly what a CI machine without
 *                  a tmux server looks like, instead of the developer's server.
 *   $TMUX          an inherited live socket is dropped, a private one is kept.
 * Every redirection is attributed to the test file that caused it. A test
 * that needs a daemon with no server of its own declares that with
 * `allowDefaultTmuxServerInPrivateNamespace()`; its redirections are recorded
 * as declared. A redirection from any other test, and every refusal, fails
 * the run: a test either names a private server or says that it has none.
 */
export function tmuxGuardScript(realTmux: string | null, directory: string): string {
  return `#!/bin/sh
GUARD='${directory}'
REAL='${realTmux ?? ""}'
private_dir() {
  case "$1" in
    /tmp/tmux-[0-9]*|/private/tmp/tmux-[0-9]*) return 1 ;;
    /tmp/?*/?*|/private/tmp/?*/?*|/var/folders/?*/?*|/private/var/folders/?*/?*) return 0 ;;
  esac
  return 1
}
selector=none; value=; previous=
for argument in "$@"; do
  case "$previous" in
    -S) selector=path; value="$argument" ;;
    -L) [ "$selector" = path ] || { selector=name; value="$argument"; } ;;
  esac
  case "$argument" in
    -S?*) selector=path; value="\${argument#-S}" ;;
    -L?*) [ "$selector" = path ] || { selector=name; value="\${argument#-L}"; } ;;
  esac
  previous="$argument"
done
if [ "$selector" = path ]; then
  if ! private_dir "$value"; then
    printf 'REFUSED socket=%s args=%s\n' "$value" "$*" >> "$GUARD/refused.log"
    echo "tmux test guard: refused a call to a tmux socket outside a private temp dir ($value)" >&2
    exit ${TMUX_GUARD_REFUSAL_EXIT_CODE}
  fi
else
  redirect=
  if [ -n "$TMUX" ] && ! private_dir "\${TMUX%%,*}"; then
    redirect="dropped TMUX=$TMUX"
    unset TMUX TMUX_PANE
  fi
  if [ -z "$TMUX" ] && ! private_dir "$TMUX_TMPDIR/x"; then
    redirect="$selector TMUX_TMPDIR=\${TMUX_TMPDIR:-unset}"
    TMUX_TMPDIR="$GUARD"; export TMUX_TMPDIR
  fi
  if [ -n "$redirect" ]; then
    # Which test is this? Walk up to the test process that registered itself.
    pid=$PPID; test=unknown; declared=no; hops=0
    while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$hops" -lt 8 ]; do
      if [ -f "$GUARD/current-test.$pid" ]; then
        test=$(/bin/cat "$GUARD/current-test.$pid" 2>/dev/null)
        [ -f "$GUARD/allow-redirect.$pid" ] && declared=yes
        break
      fi
      pid=$(/bin/ps -o ppid= -p "$pid" 2>/dev/null)
      pid="\${pid##* }"
      hops=$((hops + 1))
    done
    if [ "$declared" = yes ]; then log="$GUARD/redirected.log"; else log="$GUARD/undeclared.log"; fi
    printf 'REDIRECTED %s test=%s args=%s\\n' "$redirect" "$test" "$*" >> "$log"
  fi
fi
if [ -z "$REAL" ]; then echo "tmux test guard: no tmux installed" >&2; exit 127; fi
exec "$REAL" "$@"
`;
}

/**
 * Put the guard in front of tmux for this process and every child that
 * inherits its environment. Keeps a guard a parent runner already installed.
 */
export function installTmuxGuard(environment: NodeJS.ProcessEnv = process.env): TmuxGuard {
  const inherited = environment.TMUX_IDE_TEST_TMUX_GUARD;
  if (inherited && existsSync(join(inherited, "tmux")))
    return {
      directory: inherited,
      executable: join(inherited, "tmux"),
      log: join(inherited, "refused.log"),
      created: false,
    };
  // /tmp, not os.tmpdir(): macOS's per-user temp path would push a socket in
  // this directory past the sun_path limit.
  const directory = mkdtempSync(`/tmp/${PRIVATE_PREFIX}`);
  const executable = join(directory, "tmux");
  const log = join(directory, "refused.log");
  writeFileSync(executable, tmuxGuardScript(findRealTmux(environment), directory));
  chmodSync(executable, 0o755);
  writeFileSync(log, "");
  writeFileSync(join(directory, "redirected.log"), "");
  writeFileSync(join(directory, "undeclared.log"), "");
  environment.TMUX_IDE_TEST_TMUX_GUARD = directory;
  environment.PATH = [directory, ...(environment.PATH ?? "").split(delimiter)].join(delimiter);
  // resolveTmuxExecutable prefers a bundled binary over PATH. The configured
  // binary wins over both, so the daemon cannot be handed any other tmux.
  environment.TMUX_IDE_TMUX_BIN = executable;
  // Raw tmux children inherit these; an inherited live TMUX would win over both.
  environment.TMUX_TMPDIR = directory;
  delete environment.TMUX;
  delete environment.TMUX_PANE;
  return { directory, executable, log, created: true };
}

function lines(path: string): readonly string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
/** Calls to a live server's socket path that the guard stopped. Any of these fails the run. */
export function refusedTmuxCalls(guard: Pick<TmuxGuard, "directory">): readonly string[] {
  return lines(join(guard.directory, "refused.log"));
}
/** Redirected calls of tests that declared they run a daemon with no server of its own. */
export function redirectedTmuxCalls(guard: Pick<TmuxGuard, "directory">): readonly string[] {
  return lines(join(guard.directory, "redirected.log"));
}
/** Redirected calls of tests that declared nothing. Any of these fails the run. */
export function undeclaredTmuxCalls(guard: Pick<TmuxGuard, "directory">): readonly string[] {
  return lines(join(guard.directory, "undeclared.log"));
}

function guardDirectory(environment: NodeJS.ProcessEnv): string | null {
  const directory = environment.TMUX_IDE_TEST_TMUX_GUARD;
  return directory && existsSync(join(directory, "tmux")) ? directory : null;
}
/** Tell the guard which test file this process is running; redirections are attributed to it. */
export function registerCurrentTest(
  testPath: string,
  environment: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): void {
  const directory = guardDirectory(environment);
  if (directory) writeFileSync(join(directory, `current-test.${String(pid)}`), `${testPath}\n`);
}
/**
 * For a test whose subject is a daemon with NO tmux server intent (no
 * explicit socket, no TMUX): such a daemon addresses the socket named
 * "default", which the guard keeps in its private namespace. Declaring it
 * says the redirect is this test's isolation and not an oversight. Returns
 * the function that withdraws the declaration.
 */
export function allowDefaultTmuxServerInPrivateNamespace(
  environment: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): () => void {
  const directory = guardDirectory(environment);
  if (!directory) return () => {};
  const marker = join(directory, `allow-redirect.${String(pid)}`);
  writeFileSync(marker, "");
  return () => rmSync(marker, { force: true });
}

/** Why this environment no longer has the guard in force, or null if it has. */
export function tmuxGuardViolation(environment: NodeJS.ProcessEnv): string | null {
  const directory = environment.TMUX_IDE_TEST_TMUX_GUARD;
  if (!directory || !existsSync(join(directory, "tmux")))
    return "the tmux guard is not installed (TMUX_IDE_TEST_TMUX_GUARD)";
  if ((environment.PATH ?? "").split(delimiter)[0] !== directory)
    return "the tmux guard is no longer first on PATH";
  // Unset, the daemon would take a bundled tmux before PATH; a test's own
  // fake tmux in a temp dir is fine, any other binary bypasses the guard.
  const configured = environment.TMUX_IDE_TMUX_BIN;
  if (!configured)
    return "TMUX_IDE_TMUX_BIN is unset: a bundled tmux would be used instead of the guard";
  if (configured !== join(directory, "tmux") && !isBelowTemporaryDirectory(configured))
    return `TMUX_IDE_TMUX_BIN names ${JSON.stringify(configured)}, a tmux that bypasses the guard`;
  if (environment.TMUX_IDE_RUNTIME_MODE === "development")
    return "TMUX_IDE_RUNTIME_MODE=development makes the daemon ignore TMUX_IDE_TMUX_BIN";
  return null;
}

function isBelowTemporaryDirectory(path: string): boolean {
  return /^(?:\/private)?\/(?:tmp|var\/folders)\/[^/]+\/.+/u.test(path);
}

export function assertTmuxGuarded(environment: NodeJS.ProcessEnv = process.env): void {
  const violation = tmuxGuardViolation(environment);
  if (violation)
    throw new Error(
      `Refusing to run: this test could reach a live tmux server: ${violation}. ` +
        "See packages/daemon/test-support/tmux-isolation.ts.",
    );
}

/**
 * Keep the guard's records where CI can upload them: every redirected and
 * refused call of the run, i.e. the complete list of tests' tmux calls that
 * named no private server.
 */
export function saveTmuxGuardReport(guard: TmuxGuard, destination: string | undefined): void {
  if (!destination) return;
  mkdirSync(destination, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  for (const name of ["refused.log", "undeclared.log", "redirected.log"])
    writeFileSync(
      join(destination, `${stamp}-${name}`),
      lines(join(guard.directory, name)).join("\n") + "\n",
    );
}

export function tmuxGuardFailureMessage(
  refused: readonly string[],
  undeclared: readonly string[],
): string {
  return [
    `${refused.length + undeclared.length} tmux call(s) from this test run named no private tmux server.`,
    ...(refused.length
      ? [
          "Refused (a socket path outside a private temp dir; use a socket under mkdtemp()):",
          ...refused.slice(0, 40),
        ]
      : []),
    ...(undeclared.length
      ? [
          "Kept away from the default server, but the test did not say it has none. Give it a private",
          "server (-S, TMUX or TMUX_IDE_TMUX_SOCKET_PATH under a temp dir), or, if its subject is a daemon",
          "without a server, call allowDefaultTmuxServerInPrivateNamespace() from test-support/tmux-isolation.ts:",
          ...undeclared.slice(0, 40),
        ]
      : []),
  ].join("\n");
}

export function removeTmuxGuard(guard: TmuxGuard): void {
  if (guard.created && guard.directory.includes(PRIVATE_PREFIX))
    rmSync(guard.directory, { recursive: true, force: true });
}
