/**
 * The OS sandbox every program a plugin runs goes through.
 *
 * It is a seat belt, not the security boundary: consent is. A program a
 * plugin may run can usually do anything your account can (edit your shell
 * profile, start other programs, talk to the network). What the sandbox
 * adds:
 *
 * - no writes under the tmux-ide state home except the plugin's own data
 *   directory, so a program cannot simply edit consent records, init.lua or
 *   installed plugins in place;
 * - no reads of the daemon record and credential files the daemon names;
 * - on Linux, its own PID namespace and /proc, so it cannot reach the
 *   daemon through /proc/<pid>.
 *
 * macOS uses sandbox-exec. Linux uses bubblewrap, but running programs on
 * Linux is off unless TMUX_IDE_PLUGIN_EXEC_LINUX=1: it has not been tested
 * on a real Linux machine yet. Elsewhere, plugins cannot run programs.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export type SandboxPlan =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export interface SandboxPaths {
  /** The state home; nothing under it is writable, except `writable`. */
  readonly stateHome: string;
  /** The plugin's own data directory, the one writable place under the state home. */
  readonly writable: string;
  /** Files and directories programs may not read: the daemon record, credentials. */
  readonly unreadable?: readonly string[];
}

/** The environment variable that turns plugin programs on for Linux. */
export const LINUX_EXEC_OPT_IN = "TMUX_IDE_PLUGIN_EXEC_LINUX";

/** Resolve symlinks (macOS /tmp is /private/tmp), including for paths that do not exist yet. */
export function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * The data directory as the sandbox should name it: its parent resolved,
 * its own name kept. If something replaced the directory with a symlink,
 * this still names the link, so the link's target never becomes writable.
 */
export function writablePath(
  paths: SandboxPaths,
  resolve: (path: string) => string = realPath,
): string {
  return join(resolve(dirname(paths.writable)), basename(paths.writable));
}

/** The sandbox-exec profile: allow everything, deny writes under the state home but the data dir. */
export function darwinProfile(
  paths: SandboxPaths,
  resolve: (path: string) => string = realPath,
): string {
  // Later rules win in SBPL, so the narrower allow comes after the deny,
  // and the read denials come last.
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sbplString(resolve(paths.stateHome))}))`,
    `(allow file-write* (subpath ${sbplString(writablePath(paths, resolve))}))`,
    ...(paths.unreadable ?? []).map(
      (path) => `(deny file-read* file-write* (subpath ${sbplString(resolve(path))}))`,
    ),
  ].join("");
}

/**
 * The first executable regular file called `name` in `path`'s directories.
 * Relative entries (".", "bin", empty) are skipped: they would resolve
 * against whatever directory the program starts in.
 */
export function findOnPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not there, or not executable: keep looking.
    }
  }
  return null;
}

/** Wrap `command` so it runs inside the sandbox, or say why it cannot. */
export function sandboxedArgv(
  command: readonly string[],
  paths: SandboxPaths,
  options: {
    platform?: NodeJS.Platform;
    find?: (name: string) => string | null;
    exists?: (path: string) => boolean;
    /** Resolves symlinks; the sandbox matches real paths. */
    resolve?: (path: string) => string;
    /** Whether the owner turned plugin programs on for Linux. */
    linuxOptIn?: boolean;
  } = {},
): SandboxPlan {
  const platform = options.platform ?? process.platform;
  const find = options.find ?? ((name: string) => findOnPath(name));
  const exists = options.exists ?? existsSync;
  const resolve = options.resolve ?? realPath;
  if (platform === "darwin") {
    const tool = "/usr/bin/sandbox-exec";
    if (!exists(tool)) return { ok: false, reason: "sandbox-exec is missing" };
    return { ok: true, argv: [tool, "-p", darwinProfile(paths, resolve), ...command] };
  }
  if (platform === "linux") {
    const optIn = options.linuxOptIn ?? process.env[LINUX_EXEC_OPT_IN] === "1";
    if (!optIn)
      return {
        ok: false,
        reason: `running programs from plugins on Linux is untested and off; set ${LINUX_EXEC_OPT_IN}=1 for the daemon to turn it on`,
      };
    const tool = find("bwrap");
    if (!tool)
      return {
        ok: false,
        reason: "running programs from plugins needs bubblewrap (bwrap) on Linux",
      };
    const home = resolve(paths.stateHome);
    const writable = writablePath(paths, resolve);
    const hidden = (paths.unreadable ?? []).map(resolve).filter((path) => exists(path));
    return {
      ok: true,
      argv: [
        tool,
        "--dev-bind",
        "/",
        "/",
        "--ro-bind",
        home,
        home,
        "--bind",
        writable,
        writable,
        // Hide each unreadable file behind an empty one, each directory
        // behind an empty tmpfs.
        ...hidden.flatMap((path) =>
          isDirectory(path) ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path],
        ),
        // Its own PIDs and /proc: the daemon's /proc/<pid> (environ, root,
        // fds) is out of sight. Its own IPC and session (no TIOCSTI into
        // the daemon's terminal), and it dies with the daemon.
        "--unshare-pid",
        "--proc",
        "/proc",
        "--unshare-ipc",
        "--new-session",
        "--die-with-parent",
        "--",
        ...command,
      ],
    };
  }
  return { ok: false, reason: `plugins cannot run programs on ${platform}` };
}
