/**
 * Resolution for the TUI surfaces across BOTH distribution modes.
 *
 * Dev checkout: the surfaces are OpenTUI/Solid `.tsx` spawned by `bun` (the
 * bunfig preload supplies the JSX transform). Installed via npm/pnpm/bun: there
 * is no checkout and no `bun`, so we fall back to the compiled `tmux-ide-tui`
 * binary (see scripts/build-tui.mjs) which bundles every surface behind a
 * `<surface> [flags]` argv dispatcher and needs no runtime.
 *
 * Order is "compiled first, source fallback": interactive startup should not
 * pay Bun's 1s+ TypeScript/JSX module load on every launch. Developers can set
 * `TMUX_IDE_TUI_SOURCE=1` to opt into live `.tsx` sources. {@link findCompiledTui}
 * probes the shipped/local compiled binary first, then a per-platform binary
 * downloaded at runtime into `~/.tmux-ide/bin/` (see lib/tui-binary.ts).
 *
 * {@link resolveTuiLaunch} is a PURE decision (unit-tested); {@link findCompiledTui}
 * and {@link isBunAvailable} are the thin io probes that feed it.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { downloadTuiBinary, findDownloadedTui } from "../lib/tui-binary.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TuiLaunch =
  | { mode: "bun"; bin: "bun"; argv: string[] }
  | { mode: "binary"; bin: string; argv: string[] }
  | { mode: "unavailable"; reasons: string[] };

export interface TuiResolveInput {
  /** Dispatcher surface token: team | explorer | changes | preview | config | setup | sidebar. */
  surface: string;
  /** The checkout `.tsx` entry for this surface. */
  scriptPath: string;
  /** Surface flags (`--session=…`, `--dir=…`, `--theme=…`, …). */
  args: string[];
  /** Whether {@link scriptPath} exists (checkout present). */
  checkoutExists: boolean;
  /** Whether the `bun` runtime is on PATH. */
  bunAvailable: boolean;
  /** Absolute path to the compiled `tmux-ide-tui`, or null if not found. */
  compiledBinary: string | null;
  /** Explicit development override; ordinary launches prefer the fast binary. */
  preferSource?: boolean;
}

export interface TuiLaunchAcquisitionOptions {
  readonly log?: (message: string) => void;
  readonly download?: (options: {
    readonly log?: (message: string) => void;
  }) => Promise<{ readonly path: string; readonly bytes: number }>;
}

/**
 * Build the environment for every standalone OpenTUI surface.
 *
 * `TERM=xterm-256color` alone makes OpenTUI synchronize the terminal's mutable
 * ANSI 0-15 palette. Several embedded hosts remap bright-white slot 15 to their
 * dark default, turning light semantic surfaces black. The app renders 24-bit
 * colors, so advertise that capability explicitly and never let an inherited
 * NO_COLOR disable it. Hosted launches already enforce the same contract in
 * their shell command line.
 */
export function openTuiLaunchEnvironment(
  inherited: NodeJS.ProcessEnv,
  overlay: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    ...overlay,
    COLORTERM: "truecolor",
  };
  delete environment.NO_COLOR;
  return environment;
}

/**
 * Ensure an installed OpenTUI app has a runnable native dispatcher.
 *
 * Development checkouts with Bun and installs that already have an exact-version
 * binary stay entirely local. Only the otherwise-unavailable installed path
 * acquires the matching release artifact. Keeping this decision beside
 * {@link resolveTuiLaunch} prevents the CLI and package gate from inventing a
 * second launch policy.
 */
export async function ensureTuiLaunchAvailable(
  input: TuiResolveInput,
  options: TuiLaunchAcquisitionOptions = {},
): Promise<TuiLaunch> {
  const current = resolveTuiLaunch(input);
  if (current.mode !== "unavailable") return current;

  let downloaded: { readonly path: string; readonly bytes: number };
  try {
    downloaded = await (options.download ?? downloadTuiBinary)({ log: options.log });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Automatic OpenTUI runtime acquisition failed: ${message}\n` +
        "Retry with `tmux-ide update --tui-binary`, then run `tmux-ide app` again.",
      { cause: error },
    );
  }

  const prepared = resolveTuiLaunch({ ...input, compiledBinary: downloaded.path });
  if (prepared.mode === "unavailable") {
    throw new Error(
      "OpenTUI runtime was downloaded but could not be selected. " +
        "Run `tmux-ide doctor`, then retry `tmux-ide update --tui-binary`.",
    );
  }
  return prepared;
}

/**
 * PURE — decide how to launch a surface. Bun-from-checkout wins when both are
 * present (dev); the compiled binary is the installed fallback; otherwise the
 * caller surfaces an actionable message built from `reasons`.
 */
export function resolveTuiLaunch(input: TuiResolveInput): TuiLaunch {
  if (input.compiledBinary && !input.preferSource) {
    return { mode: "binary", bin: input.compiledBinary, argv: [input.surface, ...input.args] };
  }
  if (input.checkoutExists && input.bunAvailable) {
    return { mode: "bun", bin: "bun", argv: [input.scriptPath, ...input.args] };
  }
  if (input.compiledBinary) {
    return { mode: "binary", bin: input.compiledBinary, argv: [input.surface, ...input.args] };
  }
  const reasons: string[] = [];
  if (!input.checkoutExists) {
    reasons.push(
      "the TUI widget sources are absent (reinstall tmux-ide — releases since v2.6.1 ship them)",
    );
  }
  if (!input.bunAvailable) {
    reasons.push("the `bun` runtime is not installed (https://bun.sh)");
  }
  reasons.push(
    "no compiled `tmux-ide-tui` binary was found (build one with `pnpm build:tui`, download it with `tmux-ide update --tui-binary`, or reinstall a release that ships it)",
  );
  return { mode: "unavailable", reasons };
}

// Candidate locations for the compiled binary, relative to an anchor dir. The
// installed tarball ships it at packages/daemon/dist/tui/tmux-ide-tui and the
// bin is bin/cli.js, so a bin-anchored `../packages/daemon/dist/...` hits it;
// the other rels cover unbundled daemon layouts and a co-located binary.
const BINARY_RELS = [
  "../packages/daemon/dist/tui/tmux-ide-tui",
  "../../dist/tui/tmux-ide-tui",
  "../dist/tui/tmux-ide-tui",
  "dist/tui/tmux-ide-tui",
  "tmux-ide-tui",
];

/**
 * io — locate the compiled `tmux-ide-tui`. Honors `TMUX_IDE_TUI_BIN` (absolute
 * override, e.g. for tests / custom installs), then probes bin- and
 * module-relative candidates. Returns null when none exists.
 */
export function findCompiledTui(): string | null {
  const override = process.env.TMUX_IDE_TUI_BIN;
  if (override) return existsSync(override) ? override : null;

  const anchors: string[] = [];
  if (process.argv[1]) anchors.push(dirname(process.argv[1]));
  anchors.push(__dirname);

  for (const anchor of anchors) {
    for (const rel of BINARY_RELS) {
      const candidate = resolve(anchor, rel);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Last: a per-platform binary fetched at runtime by `tmux-ide update
  // --tui-binary` into `~/.tmux-ide/bin/` — the fallback for an npm install with
  // no bun and no shipped compiled binary. Version-stamped, so it only matches
  // the running version (see lib/tui-binary.ts).
  return findDownloadedTui();
}

/** io — is the `bun` runtime callable? */
export function isBunAvailable(): boolean {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A config-free cwd for the standalone Bun executable.
 *
 * Even a `bun build --compile` executable asks Bun to load `bunfig.toml` from
 * its process cwd before the embedded application starts. Running the binary
 * from a tmux-ide checkout therefore tries to resolve the checkout's
 * `@opentui/solid/preload` as a runtime dependency and aborts before our
 * dispatcher can run. The real project cwd is already carried explicitly via
 * `TMUX_IDE_CWD` / `--dir`, so compiled surfaces start in this private,
 * deliberately config-free directory instead.
 */
export function compiledTuiRuntimeDir(home = homedir()): string {
  return join(home, ".tmux-ide", "runtime", "compiled-tui");
}

/** io — create and return the private cwd used by compiled TUI surfaces. */
export function ensureCompiledTuiRuntimeDir(home = homedir()): string {
  const dir = compiledTuiRuntimeDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
