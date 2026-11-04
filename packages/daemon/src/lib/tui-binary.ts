import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
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
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { acquirePrivateOperationLock } from "./private-operation-lock.ts";
import { getCurrentVersion } from "./update-check.ts";

/** The `<os>-<arch>` tags we publish a prebuilt TUI binary for. Intel macOS is unsupported as of 2.9.6. */
export type TuiPlatformTag = "darwin-arm64" | "linux-x64" | "linux-arm64";

/** The GitHub repo the release assets live under. */
export const RELEASE_REPO = "wavyrai/tmux-ide";

/** A downloaded binary smaller than this is treated as corrupt/truncated. */
export const MIN_TUI_BINARY_BYTES = 10 * 1024 * 1024;

/** Hard download/decompression ceilings: release binaries are currently ~70MB. */
export const MAX_TUI_COMPRESSED_BYTES = 128 * 1024 * 1024;
export const MAX_TUI_BINARY_BYTES = 256 * 1024 * 1024;
/** Abort a request when no bytes arrive for this long; a slow transfer never trips it. */
export const TUI_DOWNLOAD_STALL_TIMEOUT_MS = 30_000;
/** One budget for the manifest, the binary, and every retry: ~145 KB/s at the size ceiling. */
export const TUI_DOWNLOAD_TOTAL_TIMEOUT_MS = 15 * 60_000;
/** Attempts per file; only transient failures are retried. */
export const TUI_DOWNLOAD_MAX_ATTEMPTS = 3;
export const TUI_DOWNLOAD_RETRY_DELAY_MS = 1_000;

const MAX_CHECKSUM_MANIFEST_BYTES = 4 * 1024;
/** A second installer says why it is quiet once the wait is longer than a lock handover. */
const TUI_DOWNLOAD_LOCK_NOTICE_MS = 2_000;
/** Lets a lock waiter outlast the holder's verify and install after its download budget. */
const TUI_DOWNLOAD_LOCK_MARGIN_MS = 5_000;

const SUPPORTED: Record<string, TuiPlatformTag> = {
  "darwin-arm64": "darwin-arm64",
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

/** PURE — checksum manifest published beside a platform release asset. */
export function releaseAssetChecksumName(tag: TuiPlatformTag): string {
  return `${releaseAssetName(tag)}.sha256`;
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

/** PURE — URL for the exact-version/platform checksum manifest. */
export function releaseAssetChecksumUrl(version: string, tag: TuiPlatformTag): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${normalizeVersion(version)}/${releaseAssetChecksumName(tag)}`;
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
  return resolveRuntimeNamespace().stateHome;
}

/**
 * io — locate a previously downloaded per-platform binary for THIS version and
 * platform, or null. Feeds the resolution order in `tui/compiled.ts` after the
 * shipped/local compiled binary and before the honest "unavailable" error.
 */
export function findDownloadedTui(
  version: string = getCurrentVersion(),
  options: {
    readonly home?: string;
    readonly tag?: TuiPlatformTag | null;
    readonly limits?: Pick<DownloadLimits, "minBinaryBytes" | "maxBinaryBytes">;
  } = {},
): string | null {
  if (resolveRuntimeNamespace().development) return null;
  const tag = options.tag === undefined ? tuiPlatformTag() : options.tag;
  if (!tag) return null;
  const path = downloadedTuiPath(options.home ?? tuiStateHome(), tag, version);
  const cached = inspectCachedBinary(path, tag, normalizeVersion(version), options.limits);
  if (cached) return path;

  // Do not interfere with a writer between its sidecar and binary renames.
  if (!existsSync(downloadLockPath(path))) purgeCachedBinary(path);
  return null;
}

interface ChecksumManifest {
  readonly compressedSha256: string;
  readonly binarySha256: string;
  readonly asset: string;
  readonly binary: string;
  readonly version: string;
  readonly platform: TuiPlatformTag;
  readonly commit: string;
}

interface DownloadLimits {
  readonly minBinaryBytes: number;
  readonly maxCompressedBytes: number;
  readonly maxBinaryBytes: number;
}

interface DownloadPolicy {
  readonly stallTimeoutMs: number;
  readonly deadline: number;
  readonly totalTimeoutMs: number;
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
}

/** A failure a retry cannot fix: the release asset is missing or breaks a hard limit. */
class PermanentDownloadError extends Error {}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function checksumPath(path: string): string {
  return `${path}.sha256`;
}

function downloadLockPath(path: string): string {
  return `${path}.lock`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseChecksumLine(line: string, expectedName: string, label: string): string {
  const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
  if (!match || match[2] !== expectedName) {
    throw new Error(`invalid ${label} checksum entry for ${expectedName}`);
  }
  return match[1]!;
}

function parseChecksumManifest(
  bytes: Buffer,
  expected: { readonly version: string; readonly tag: TuiPlatformTag },
): ChecksumManifest {
  if (bytes.byteLength > MAX_CHECKSUM_MANIFEST_BYTES) {
    throw new Error(`checksum manifest exceeds ${MAX_CHECKSUM_MANIFEST_BYTES} bytes`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.trimEnd().split(/\r?\n/u);
  if (lines.length !== 5) throw new Error("checksum manifest must contain exactly five lines");

  const asset = releaseAssetName(expected.tag);
  const binary = asset.slice(0, -3);
  const compressedSha256 = parseChecksumLine(lines[0]!, asset, "compressed artifact");
  const binarySha256 = parseChecksumLine(lines[1]!, binary, "executable");
  const fields = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const match = /^(version|platform|commit) ([^\s]+)$/u.exec(line);
    if (!match || fields.has(match[1]!)) throw new Error("checksum manifest metadata is invalid");
    fields.set(match[1]!, match[2]!);
  }
  const version = fields.get("version");
  const platform = fields.get("platform");
  const commit = fields.get("commit");
  if (version !== expected.version)
    throw new Error(`checksum manifest version mismatch: ${version}`);
  if (platform !== expected.tag)
    throw new Error(`checksum manifest platform mismatch: ${platform}`);
  if (!commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error("checksum manifest commit is not a canonical Git object ID");
  }
  return {
    compressedSha256,
    binarySha256,
    asset,
    binary,
    version,
    platform: expected.tag,
    commit,
  };
}

function inspectCachedBinary(
  path: string,
  tag: TuiPlatformTag,
  version: string,
  limits: Pick<DownloadLimits, "minBinaryBytes" | "maxBinaryBytes"> = {
    minBinaryBytes: MIN_TUI_BINARY_BYTES,
    maxBinaryBytes: MAX_TUI_BINARY_BYTES,
  },
): { readonly bytes: number; readonly manifest: ChecksumManifest } | null {
  try {
    const stat = statSync(path);
    if (
      !stat.isFile() ||
      stat.size < limits.minBinaryBytes ||
      stat.size > limits.maxBinaryBytes ||
      (stat.mode & 0o111) === 0
    ) {
      return null;
    }
    accessSync(path, fsConstants.X_OK);
    const manifestBytes = readFileSync(checksumPath(path));
    const manifest = parseChecksumManifest(manifestBytes, { version, tag });
    const binary = readFileSync(path);
    if (sha256(binary) !== manifest.binarySha256) return null;
    return { bytes: stat.size, manifest };
  } catch {
    return null;
  }
}

function purgeCachedBinary(path: string): void {
  for (const candidate of [path, checksumPath(path)]) {
    try {
      unlinkSync(candidate);
    } catch {
      // Missing or concurrently replaced cache entries are already unusable.
    }
  }
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readBoundedResponse(
  fetchImpl: FetchLike,
  url: string,
  maxBytes: number,
  policy: DownloadPolicy,
): Promise<Buffer> {
  const controller = new AbortController();
  let total = 0;
  let timeoutMessage: string | null = null;
  const abortWith = (message: () => string) => () => {
    timeoutMessage = message();
    controller.abort();
  };
  const overallTimer = setTimeout(
    abortWith(() => `download did not finish within ${policy.totalTimeoutMs}ms`),
    Math.max(0, policy.deadline - Date.now()),
  );
  const onStall = abortWith(
    () => `download stalled: no data for ${policy.stallTimeoutMs}ms after ${total} bytes`,
  );
  let stallTimer = setTimeout(onStall, policy.stallTimeoutMs);
  const markProgress = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(onStall, policy.stallTimeoutMs);
  };
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      const message = `HTTP ${response.status} ${response.statusText}`;
      if (isTransientHttpStatus(response.status)) throw new Error(message);
      throw new PermanentDownloadError(message);
    }
    markProgress();
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new PermanentDownloadError(`declared size ${declaredLength} exceeds ${maxBytes} bytes`);
    }
    if (!response.body) throw new Error("response has no body");

    const chunks: Buffer[] = [];
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength === 0) continue;
        markProgress();
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PermanentDownloadError(`download exceeds ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (timeoutMessage) throw new Error(timeoutMessage, { cause: error });
    throw error;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(stallTimer);
    // Releases the connection of any response whose body was not fully read.
    controller.abort();
  }
}

async function readWithRetries(
  fetchImpl: FetchLike,
  url: string,
  maxBytes: number,
  policy: DownloadPolicy,
  log: (msg: string) => void,
): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readBoundedResponse(fetchImpl, url, maxBytes, policy);
    } catch (error) {
      const delayMs = policy.retryDelayMs * attempt;
      if (
        error instanceof PermanentDownloadError ||
        attempt >= policy.maxAttempts ||
        Date.now() + delayMs >= policy.deadline
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      log(`download attempt ${attempt}/${policy.maxAttempts} failed (${message}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * io — download, verify, and install the per-platform TUI binary for the running
 * version. Fetches a bounded gzip asset and its exact-version checksum manifest,
 * verifies both the compressed bytes and inflated executable, then writes it
 * `0o755` and atomically renames it into place (temp-in-same-dir → rename, so a
 * crashed download never leaves a half-written executable).
 *
 * Throws with an actionable message on an unsupported platform or a failed
 * fetch. Returns the installed path and byte size.
 */
export async function downloadTuiBinary(
  opts: {
    version?: string;
    log?: (msg: string) => void;
    home?: string;
    tag?: TuiPlatformTag | null;
    fetch?: FetchLike;
    stallTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxAttempts?: number;
    retryDelayMs?: number;
    limits?: Partial<DownloadLimits>;
  } = {},
): Promise<{ path: string; bytes: number }> {
  if (resolveRuntimeNamespace().development)
    throw new Error("Development binary download is disabled; build exact artifacts");
  const log = opts.log ?? (() => {});
  const version = normalizeVersion(opts.version ?? getCurrentVersion());
  const tag = opts.tag === undefined ? tuiPlatformTag() : opts.tag;
  if (!tag) {
    throw new Error(
      `no prebuilt TUI binary is published for ${process.platform}-${process.arch} — ` +
        `install bun (https://bun.sh) to run the TUI surfaces from source instead`,
    );
  }

  const url = releaseAssetUrl(version, tag);
  const checksumUrl = releaseAssetChecksumUrl(version, tag);
  const dest = downloadedTuiPath(opts.home ?? tuiStateHome(), tag, version);
  const limits: DownloadLimits = {
    minBinaryBytes: opts.limits?.minBinaryBytes ?? MIN_TUI_BINARY_BYTES,
    maxCompressedBytes: opts.limits?.maxCompressedBytes ?? MAX_TUI_COMPRESSED_BYTES,
    maxBinaryBytes: opts.limits?.maxBinaryBytes ?? MAX_TUI_BINARY_BYTES,
  };
  const totalTimeoutMs = opts.totalTimeoutMs ?? TUI_DOWNLOAD_TOTAL_TIMEOUT_MS;
  mkdirSync(dirname(dest), { recursive: true });
  const lockNotice = setTimeout(
    () => log("waiting for another tmux-ide download of this version to finish"),
    TUI_DOWNLOAD_LOCK_NOTICE_MS,
  );
  const releaseLock = await acquirePrivateOperationLock(
    downloadLockPath(dest),
    totalTimeoutMs + TUI_DOWNLOAD_LOCK_MARGIN_MS,
  ).finally(() => clearTimeout(lockNotice));
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const binaryTmp = `${dest}.${suffix}`;
  const checksumTmp = `${checksumPath(dest)}.${suffix}`;
  try {
    const cached = inspectCachedBinary(dest, tag, version, limits);
    if (cached) return { path: dest, bytes: cached.bytes };
    purgeCachedBinary(dest);

    const fetchImpl = opts.fetch ?? globalThis.fetch;
    // Starts after the lock so the budget matches what a lock waiter allows for.
    const policy: DownloadPolicy = {
      stallTimeoutMs: opts.stallTimeoutMs ?? TUI_DOWNLOAD_STALL_TIMEOUT_MS,
      deadline: Date.now() + totalTimeoutMs,
      totalTimeoutMs,
      maxAttempts: opts.maxAttempts ?? TUI_DOWNLOAD_MAX_ATTEMPTS,
      retryDelayMs: opts.retryDelayMs ?? TUI_DOWNLOAD_RETRY_DELAY_MS,
    };
    log(`downloading checksum manifest ${checksumUrl}`);
    let manifestBytes: Buffer;
    let gz: Buffer;
    try {
      manifestBytes = await readWithRetries(
        fetchImpl,
        checksumUrl,
        MAX_CHECKSUM_MANIFEST_BYTES,
        policy,
        log,
      );
      log(`downloading ${url}`);
      gz = await readWithRetries(fetchImpl, url, limits.maxCompressedBytes, policy, log);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        error instanceof PermanentDownloadError
          ? "Check that the release published both exact-version assets."
          : "Check your network connection, then retry with `tmux-ide update --tui-binary`, or run the installer again if tmux-ide is not installed yet.";
      throw new Error(
        `could not download the TUI binary and checksum for v${version} (${message}). ${hint}`,
        { cause: error },
      );
    }
    const manifest = parseChecksumManifest(manifestBytes, { version, tag });
    if (sha256(gz) !== manifest.compressedSha256) {
      throw new Error(`SHA-256 mismatch for ${manifest.asset}; refusing to install it`);
    }

    let bin: Buffer;
    try {
      bin = gunzipSync(gz, { maxOutputLength: limits.maxBinaryBytes });
    } catch (error) {
      throw new Error(`could not safely decompress ${manifest.asset}`, { cause: error });
    }
    if (bin.byteLength < limits.minBinaryBytes || bin.byteLength > limits.maxBinaryBytes) {
      throw new Error(
        `the downloaded TUI binary is ${bin.byteLength} bytes ` +
          `(expected ${limits.minBinaryBytes}-${limits.maxBinaryBytes})`,
      );
    }
    if (sha256(bin) !== manifest.binarySha256) {
      throw new Error(`SHA-256 mismatch for ${manifest.binary}; refusing to install it`);
    }

    writeFileSync(binaryTmp, bin, { mode: 0o755 });
    chmodSync(binaryTmp, 0o755);
    writeFileSync(checksumTmp, manifestBytes, { mode: 0o600 });
    // The executable is the commit point: a reader cannot observe it until its
    // matching manifest is already at the stable path.
    renameSync(checksumTmp, checksumPath(dest));
    renameSync(binaryTmp, dest);

    const installed = inspectCachedBinary(dest, tag, version, limits);
    if (!installed) {
      purgeCachedBinary(dest);
      throw new Error("installed TUI binary failed its post-install integrity check");
    }
    const mb = (bin.byteLength / 1024 / 1024).toFixed(1);
    log(`installed ${dest} (${mb} MB, commit ${manifest.commit.slice(0, 12)})`);
    return { path: dest, bytes: bin.byteLength };
  } finally {
    for (const temporary of [binaryTmp, checksumTmp]) {
      try {
        unlinkSync(temporary);
      } catch {
        // Successfully renamed or never written.
      }
    }
    releaseLock();
  }
}
