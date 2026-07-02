/**
 * Resolution for the TUI surfaces across BOTH distribution modes.
 *
 * Dev checkout: the surfaces are OpenTUI/Solid `.tsx` spawned by `bun` (the
 * bunfig preload supplies the JSX transform). Installed via npm/pnpm/bun: there
 * is no checkout and no `bun`, so we fall back to the compiled `tmux-ide-tui`
 * binary (see scripts/build-tui.mjs) which bundles every surface behind a
 * `<surface> [flags]` argv dispatcher and needs no runtime.
 *
 * Order is "checkout first, binary second": a dev machine that happens to have
 * built the binary still uses its live `.tsx` sources. The binary is consulted
 * only when the checkout sources or `bun` are missing.
 *
 * {@link resolveTuiLaunch} is a PURE decision (unit-tested); {@link findCompiledTui}
 * and {@link isBunAvailable} are the thin io probes that feed it.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
}

/**
 * PURE — decide how to launch a surface. Bun-from-checkout wins when both are
 * present (dev); the compiled binary is the installed fallback; otherwise the
 * caller surfaces an actionable message built from `reasons`.
 */
export function resolveTuiLaunch(input: TuiResolveInput): TuiLaunch {
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
    "no compiled `tmux-ide-tui` binary was found (build one with `pnpm build:tui`, or reinstall a release that ships it)",
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
  return null;
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
