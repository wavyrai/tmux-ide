/**
 * Per-platform TUI binary: the runtime-download fallback that lets a clean
 * `npm i -g tmux-ide` run the full OpenTUI/Solid cockpit WITHOUT `bun`.
 *
 * The dev checkout runs the `.tsx` surfaces via bun; an npm install with no bun
 * needs a self-contained binary. We do NOT bundle that ~70MB blob in the npm
 * tarball (a surprise on every install) — instead the release workflow
 * (`.github/workflows/release-binaries.yml`) cross-compiles one per platform and
 * uploads them as GitHub release assets, and this module downloads the right one
 * on demand (explicit `tmux-ide update --tui-binary`, or a consented first run).
 *
 * The mapping/URL/path helpers are PURE (unit-tested); {@link downloadTuiBinary}
 * and {@link findDownloadedTui} are the thin io that fetch and probe.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getCurrentVersion } from "./update-check.ts";

/** The `<os>-<arch>` tags we publish a prebuilt TUI binary for. */
export type TuiPlatformTag = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

/** The GitHub repo the release assets live under. */
export const RELEASE_REPO = "wavyrai/tmux-ide";

/** A downloaded binary smaller than this is treated as corrupt/truncated. */
export const MIN_TUI_BINARY_BYTES = 10 * 1024 * 1024;

const SUPPORTED: Record<string, TuiPlatformTag> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
};

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * PURE — map a Node `process.platform`/`process.arch` pair to the release tag,
 * or null when we don't publish a binary for it (e.g. windows, freebsd) so the
 * caller can fall back to the "install bun" message.
 */
export function tuiPlatformTag(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): TuiPlatformTag | null {
  return SUPPORTED[`${platform}-${arch}`] ?? null;
}

/** PURE — the `bun build --compile --target` flag for a tag (`bun-<tag>`). */
export function bunTargetForTag(tag: TuiPlatformTag): string {
  return `bun-${tag}`;
}

/** PURE — the release asset filename for a tag (gzip-compressed binary). */
export function releaseAssetName(tag: TuiPlatformTag): string {
  return `tmux-ide-tui-${tag}.gz`;
}

/** PURE — strip a leading `v` from a version string; `2.6.1` and `v2.6.1` both → `2.6.1`. */
export function normalizeVersion(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * PURE — the GitHub download URL for a platform's asset at a given version:
 * `https://github.com/<repo>/releases/download/v<version>/tmux-ide-tui-<tag>.gz`.
 */
export function releaseAssetUrl(version: string, tag: TuiPlatformTag): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${normalizeVersion(version)}/${releaseAssetName(tag)}`;
}

/**
 * PURE — where a downloaded binary lives: `<home>/bin/tmux-ide-tui-<tag>-<version>`.
 * The version is stamped INTO the name so a `tmux-ide update` to a new version
 * misses the old download and re-fetches (rather than launching a stale binary).
 */
export function downloadedTuiPath(home: string, tag: TuiPlatformTag, version: string): string {
  return join(home, "bin", `tmux-ide-tui-${tag}-${normalizeVersion(version)}`);
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

/**
 * io — the tmux-ide state home (`TMUX_IDE_HOME` override, else `~/.tmux-ide`),
 * the same resolution the update-check cache and welcome marker use.
 */
export function tuiStateHome(): string {
  return process.env.TMUX_IDE_HOME ?? join(homedir(), ".tmux-ide");
}

/**
 * io — locate a previously downloaded per-platform binary for THIS version and
 * platform, or null. Feeds the resolution order in `tui/compiled.ts` after the
 * shipped/local compiled binary and before the honest "unavailable" error.
 */
export function findDownloadedTui(version: string = getCurrentVersion()): string | null {
  const tag = tuiPlatformTag();
  if (!tag) return null;
  const path = downloadedTuiPath(tuiStateHome(), tag, version);
  return existsSync(path) ? path : null;
}

/**
 * io — download, verify, and install the per-platform TUI binary for the running
 * version. Fetches the gzip asset, inflates it, rejects anything under
 * {@link MIN_TUI_BINARY_BYTES} (a truncated download or an HTML error page),
 * writes it `0o755`, and atomically renames it into place (temp-in-same-dir →
 * rename, so a crashed download never leaves a half-written executable).
 *
 * Throws with an actionable message on an unsupported platform or a failed
 * fetch. Returns the installed path and byte size.
 */
export async function downloadTuiBinary(
  opts: {
    version?: string;
    log?: (msg: string) => void;
  } = {},
): Promise<{ path: string; bytes: number }> {
  const log = opts.log ?? (() => {});
  const version = normalizeVersion(opts.version ?? getCurrentVersion());
  const tag = tuiPlatformTag();
  if (!tag) {
    throw new Error(
      `no prebuilt TUI binary is published for ${process.platform}-${process.arch} — ` +
        `install bun (https://bun.sh) to run the TUI surfaces from source instead`,
    );
  }

  const url = releaseAssetUrl(version, tag);
  const dest = downloadedTuiPath(tuiStateHome(), tag, version);
  mkdirSync(dirname(dest), { recursive: true });

  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not download the TUI binary (${url} → HTTP ${res.status} ${res.statusText}). ` +
        `Check that release v${version} exists and published its assets.`,
    );
  }

  const gz = Buffer.from(await res.arrayBuffer());
  const bin = gunzipSync(gz);
  if (bin.byteLength < MIN_TUI_BINARY_BYTES) {
    throw new Error(
      `the downloaded TUI binary is only ${bin.byteLength} bytes (expected >10MB) — ` +
        `treating it as corrupt and leaving the previous binary (if any) in place`,
    );
  }

  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, bin, { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);

  const mb = (bin.byteLength / 1024 / 1024).toFixed(1);
  log(`installed ${dest} (${mb} MB)`);
  return { path: dest, bytes: bin.byteLength };
}
