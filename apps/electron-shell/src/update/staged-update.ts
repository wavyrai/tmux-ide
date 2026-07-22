/**
 * Staging and apply-on-launch for a verified update.
 *
 * ## Mechanism (staged directory + marker)
 *
 * A verified download is moved into a staging directory beside a small
 * `pending-update.json` marker under the app's state dir (governed by
 * `TMUX_IDE_HOME` in tests, `app.getPath("userData")` in production). The running
 * session is never touched: the live daemon and terminals keep going. The swap
 * happens at the NEXT launch, before any window or daemon comes up, via
 * {@link applyStagedUpdate}.
 *
 * ## Why apply-on-launch, not apply-on-quit
 *
 * A running application cannot atomically replace its own on-disk image on macOS
 * while it is executing from it. So the atomic step is deferred to the earliest
 * point of the next launch, when nothing is mapped from the target yet. The swap
 * itself is a single POSIX `rename(2)` from the staged path onto the install
 * path — atomic when both are on the same filesystem (they are: both under the
 * user's home). The quit coordinator only needs to make sure the marker is
 * durable before exit; it never yanks anything mid-session.
 *
 * ## Linux (documented, unimplemented here)
 *
 * The same marker + `rename` swap applies to a Linux install tree or an unpacked
 * AppImage directory. AppImage single-file distributions would instead rename the
 * new `.AppImage` over the old path and re-exec. Wiring that is release-engineering
 * work outside this card; the marker format and {@link applyStagedUpdate} seam are
 * platform-neutral and ready for it.
 *
 * Marker parsing is PURE; read/write/clear and the swap are thin io with injected
 * filesystem operations so the apply flow is fully testable without real bundles.
 */

/** Bump on a breaking change to the on-disk marker shape. */
export const PENDING_UPDATE_MARKER_SCHEMA_VERSION = 1 as const;

/** The durable record that an update is staged and ready to swap in on launch. */
export interface PendingUpdateMarker {
  readonly schemaVersion: typeof PENDING_UPDATE_MARKER_SCHEMA_VERSION;
  /** The staged version. */
  readonly version: string;
  /** Absolute path to the staged payload inside the state dir. */
  readonly stagedPath: string;
  /** The trusted artifact digest, re-checked on apply as defense in depth. */
  readonly artifactSha256: string;
  /** ISO timestamp the payload was staged. */
  readonly stagedAt: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PURE — validate an untrusted marker body. Returns null (never throws) for
 * anything malformed, so a corrupt marker simply means "no pending update".
 */
export function parsePendingUpdateMarker(raw: string): PendingUpdateMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const { schemaVersion, version, stagedPath, artifactSha256, stagedAt } = parsed;
  if (schemaVersion !== PENDING_UPDATE_MARKER_SCHEMA_VERSION) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof stagedPath !== "string" || stagedPath.length === 0) return null;
  if (typeof artifactSha256 !== "string" || !HEX64.test(artifactSha256)) return null;
  if (typeof stagedAt !== "string" || stagedAt.length === 0) return null;
  return { schemaVersion, version, stagedPath, artifactSha256, stagedAt };
}

/** PURE — serialize a marker to its canonical on-disk form. */
export function serializePendingUpdateMarker(marker: PendingUpdateMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

export type ApplyStagedUpdateOutcome =
  | { readonly status: "applied"; readonly version: string }
  | { readonly status: "none" }
  | { readonly status: "stale-payload-discarded"; readonly reason: ApplyDiscardReason };

export type ApplyDiscardReason = "payload-missing" | "checksum-mismatch" | "swap-failed";

/**
 * Injected filesystem seam for {@link applyStagedUpdate}. Every operation is
 * best-effort and may reject; the apply flow degrades to discarding the stale
 * payload rather than ever partially swapping.
 */
export interface StagedUpdateFilesystem {
  /** True iff the staged payload still exists on disk. */
  pathExists(path: string): Promise<boolean>;
  /** SHA-256 (lowercase hex) of the file at `path`. */
  digestFile(path: string): Promise<string>;
  /** Atomic same-filesystem swap of the staged payload onto the install path. */
  swapIntoPlace(stagedPath: string, installPath: string): Promise<void>;
  /** Best-effort removal of a discarded/consumed staged payload. */
  discard(path: string): Promise<void>;
}

/**
 * Apply a staged update at launch, BEFORE the window or daemon start. Re-verifies
 * the staged bytes against the marker digest (defense in depth against an
 * interrupted or tampered staging), then performs the atomic swap. Any problem —
 * a vanished payload, a digest mismatch, a failed swap — discards the staged
 * payload and reports it, leaving the current install untouched so the app boots
 * on its existing version. Clearing the marker is the caller's responsibility
 * once this returns.
 */
export async function applyStagedUpdate(
  marker: PendingUpdateMarker | null,
  installPath: string,
  fs: StagedUpdateFilesystem,
): Promise<ApplyStagedUpdateOutcome> {
  if (!marker) return { status: "none" };
  try {
    if (!(await fs.pathExists(marker.stagedPath))) {
      return { status: "stale-payload-discarded", reason: "payload-missing" };
    }
    const digest = (await fs.digestFile(marker.stagedPath)).trim().toLowerCase();
    if (digest !== marker.artifactSha256) {
      await fs.discard(marker.stagedPath).catch(() => undefined);
      return { status: "stale-payload-discarded", reason: "checksum-mismatch" };
    }
    await fs.swapIntoPlace(marker.stagedPath, installPath);
    return { status: "applied", version: marker.version };
  } catch {
    await fs.discard(marker.stagedPath).catch(() => undefined);
    return { status: "stale-payload-discarded", reason: "swap-failed" };
  }
}
