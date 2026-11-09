/**
 * The OS sandbox every program a plugin runs goes through.
 *
 * Programs a plugin runs can do anything the user can, except write inside
 * the tmux-ide state home: consent records, init.lua and its modules, the
 * plugins themselves and the daemon's own files stay out of reach, so a
 * plugin cannot consent to itself or plant code that runs without consent.
 * Only the plugin's own data directory under the state home is writable.
 *
 * macOS uses sandbox-exec; Linux uses bubblewrap. Without either, plugins
 * cannot run programs at all.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

export type SandboxPlan =
  | { readonly ok: true; readonly argv: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export interface SandboxPaths {
  /** The state home; nothing under it is writable, except `writable`. */
  readonly stateHome: string;
  /** The plugin's own data directory, the one writable place under the state home. */
  readonly writable: string;
}

/** Resolve symlinks (macOS /tmp is /private/tmp), including for paths that do not exist yet. */
export function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** The sandbox-exec profile: allow everything, deny writes under the state home but the data dir. */
export function darwinProfile(
  paths: SandboxPaths,
  resolve: (path: string) => string = realPath,
): string {
  // Later rules win in SBPL, so the narrower allow comes after the deny.
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (subpath ${sbplString(resolve(paths.stateHome))}))`,
    `(allow file-write* (subpath ${sbplString(resolve(paths.writable))}))`,
  ].join("");
}

export function findOnPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
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
    const tool = find("bwrap");
    if (!tool)
      return {
        ok: false,
        reason: "running programs from plugins needs bubblewrap (bwrap) on Linux",
      };
    const home = resolve(paths.stateHome);
    const writable = resolve(paths.writable);
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
        "--die-with-parent",
        "--",
        ...command,
      ],
    };
  }
  return { ok: false, reason: `plugins cannot run programs on ${platform}` };
}
