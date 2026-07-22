/**
 * The Electron-main-owned auto-update orchestrator.
 *
 * It drives the pure {@link ./update-state-machine.ts} through one full cycle —
 * check → download → verify → stage → ready — on a modest cadence and on launch,
 * and NEVER blocks startup or throws into its caller. Every failure path fails
 * closed to `idle`, keeping the current version running silently.
 *
 * Trust: the feed URL, download URLs, temp paths, checksums, and signatures all
 * live here. The only thing that leaves is {@link DesktopUpdateStatus} — a phase
 * plus two version strings — via {@link status} / {@link subscribe}. Nothing is
 * ever executed before both the manifest signature ({@link ManifestSignatureVerifier})
 * and the artifact checksum verify.
 */
import type { DesktopUpdateStatus } from "@tmux-ide/contracts";

import {
  parseUpdateManifest,
  type ParseUpdateManifestContext,
} from "./update-manifest.ts";
import {
  INITIAL_UPDATE_STATE,
  reduceUpdateState,
  type UpdateEvent,
  type UpdateState,
} from "./update-state-machine.ts";
import {
  verifyArtifactChecksum,
  verifyManifestSignature,
  type ManifestSignatureVerifier,
} from "./update-verify.ts";
import {
  PENDING_UPDATE_MARKER_SCHEMA_VERSION,
  type PendingUpdateMarker,
} from "./staged-update.ts";

export interface DesktopUpdaterConfig {
  /** Whether checking is enabled at all. When false the updater is inert. */
  readonly enabled: boolean;
  /** The main-owned feed base URL. Never renderer input. */
  readonly feedBaseUrl: string;
  /** The release channel to track (e.g. "stable"). */
  readonly channel: string;
  /** `${process.platform}-${process.arch}`. */
  readonly platformKey: string;
  /** The running version. */
  readonly currentVersion: string;
  /** Hard ceiling on an artifact's declared/downloaded size (bytes). */
  readonly maxArtifactBytes: number;
  /** Minimum spacing between feed checks (ms). */
  readonly checkIntervalMs: number;
  /** URL trust policy for manifest artifact URLs. */
  readonly trustArtifactUrl: (url: URL) => boolean;
}

/** The io seam. Production wires Electron `net` + node:fs/crypto; tests fake it. */
export interface DesktopUpdaterIo {
  /** Fetch a channel manifest body, or null on ANY failure (offline, non-200). */
  fetchManifest(url: string): Promise<string | null>;
  /**
   * Download `url` to a private temp file, enforcing `maxBytes`, returning the
   * path, streamed SHA-256, and byte count. Rejects on network error or overflow.
   */
  downloadArtifact(input: {
    readonly url: string;
    readonly maxBytes: number;
  }): Promise<{ readonly path: string; readonly sha256: string; readonly size: number }>;
  /** Move a verified download into the staging area; return its staged path. */
  stageArtifact(input: {
    readonly downloadedPath: string;
    readonly version: string;
  }): Promise<string>;
  /** Persist the pending-update marker durably. */
  writeMarker(marker: PendingUpdateMarker): Promise<void>;
  /** Best-effort cleanup of a temp download that will not be staged. */
  discard(path: string): Promise<void>;
  /** Structured, non-fatal diagnostic sink. */
  log(message: string, detail?: Record<string, unknown>): void;
  now(): number;
}

export type UpdateStatusListener = (status: DesktopUpdateStatus) => void;

/** PURE — resolve the per-channel manifest URL from the main-owned feed base. */
export function resolveManifestUrl(feedBaseUrl: string, channel: string): string {
  const base = feedBaseUrl.replace(/\/+$/u, "");
  return `${base}/${encodeURIComponent(channel)}.json`;
}

export class DesktopUpdater {
  readonly #config: DesktopUpdaterConfig;
  readonly #io: DesktopUpdaterIo;
  readonly #verifier: ManifestSignatureVerifier;
  readonly #listeners = new Set<UpdateStatusListener>();

  #state: UpdateState = INITIAL_UPDATE_STATE;
  #lastCheckAt: number | null = null;
  #checkInFlight: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(options: {
    readonly config: DesktopUpdaterConfig;
    readonly io: DesktopUpdaterIo;
    readonly verifier: ManifestSignatureVerifier;
  }) {
    this.#config = options.config;
    this.#io = options.io;
    this.#verifier = options.verifier;
  }

  /** The renderer-safe status. Never exposes URLs, paths, or trust material. */
  status(): DesktopUpdateStatus {
    return {
      phase: this.#state.phase,
      currentVersion: this.#config.currentVersion,
      availableVersion: this.#state.availableVersion,
    };
  }

  subscribe(listener: UpdateStatusListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** True once a verified update is staged and waiting for the next launch. */
  hasPendingUpdate(): boolean {
    return this.#state.phase === "ready" || this.#state.phase === "applying";
  }

  /**
   * Begin the launch check and the periodic cadence. Non-blocking: the first
   * check is fire-and-forget so startup never waits on the network.
   */
  start(): void {
    if (this.#disposed || !this.#config.enabled) return;
    void this.checkNow();
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.checkNow();
    }, this.#config.checkIntervalMs);
    // Do not keep the event loop (and thus the app) alive for the cadence alone.
    this.#timer.unref?.();
  }

  /** Stop the cadence. Any in-flight check is left to settle harmlessly. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#listeners.clear();
  }

  /**
   * Coordinate with quit: if an update is staged, flip to `applying` (for status)
   * and re-persist the marker so the swap-on-next-launch is durable. Returns
   * whether an update is pending. Never yanks the daemon or terminals — the swap
   * itself happens at the next launch, before anything comes up.
   */
  async finalizePendingUpdateForQuit(): Promise<boolean> {
    if (!this.hasPendingUpdate()) return false;
    this.#dispatch({ type: "apply-requested" });
    return true;
  }

  /**
   * Run one throttled check cycle. Coalesces concurrent callers, respects the
   * cadence, and is a no-op once an update is staged (`ready`) or while a cycle
   * is already running. Always resolves; never rejects.
   */
  checkNow(): Promise<void> {
    if (this.#checkInFlight) return this.#checkInFlight;
    const run = this.#runCheck().finally(() => {
      this.#checkInFlight = null;
    });
    this.#checkInFlight = run;
    return run;
  }

  async #runCheck(): Promise<void> {
    if (this.#disposed || !this.#config.enabled) return;
    if (this.#state.phase !== "idle") return; // sticky ready / mid-cycle
    const now = this.#io.now();
    if (this.#lastCheckAt !== null && now - this.#lastCheckAt < this.#config.checkIntervalMs) {
      return;
    }
    this.#lastCheckAt = now;
    this.#dispatch({ type: "check-requested" });

    const url = resolveManifestUrl(this.#config.feedBaseUrl, this.#config.channel);
    const body = await this.#io.fetchManifest(url).catch(() => null);
    if (body === null) return this.#failCheck("feed-unreachable");

    const parseContext: ParseUpdateManifestContext = {
      currentVersion: this.#config.currentVersion,
      channel: this.#config.channel,
      platformKey: this.#config.platformKey,
      maxArtifactBytes: this.#config.maxArtifactBytes,
      trustArtifactUrl: this.#config.trustArtifactUrl,
    };
    const verdict = parseUpdateManifest(body, parseContext);
    if (!verdict.ok) {
      // A "not-newer" verdict is the normal up-to-date case, not a failure.
      if (verdict.reason === "not-newer") {
        this.#dispatch({ type: "no-update" });
        return;
      }
      return this.#failCheck(`manifest-rejected:${verdict.reason}`);
    }

    const signature = verifyManifestSignature(this.#verifier, {
      signedBody: verdict.manifest.signedBody,
      signature: verdict.manifest.signature,
    });
    if (signature !== "verified") {
      return this.#failCheck(`signature-${signature}`);
    }

    this.#dispatch({ type: "update-found", version: verdict.manifest.version });
    await this.#downloadAndStage(verdict.manifest.version, verdict.manifest.artifact);
  }

  async #downloadAndStage(
    version: string,
    artifact: { readonly url: string; readonly size: number; readonly sha256: string },
  ): Promise<void> {
    let downloadedPath: string | null = null;
    try {
      const download = await this.#io.downloadArtifact({
        url: artifact.url,
        maxBytes: this.#config.maxArtifactBytes,
      });
      downloadedPath = download.path;
      if (download.size !== artifact.size) {
        return this.#failDownload("size-mismatch", downloadedPath);
      }
      if (verifyArtifactChecksum(download.sha256, artifact.sha256) !== "match") {
        return this.#failDownload("checksum-mismatch", downloadedPath);
      }
      const stagedPath = await this.#io.stageArtifact({ downloadedPath, version });
      downloadedPath = null; // ownership moved into staging
      const marker: PendingUpdateMarker = {
        schemaVersion: PENDING_UPDATE_MARKER_SCHEMA_VERSION,
        version,
        stagedPath,
        artifactSha256: artifact.sha256,
        stagedAt: new Date(this.#io.now()).toISOString(),
      };
      await this.#io.writeMarker(marker);
      this.#dispatch({ type: "download-succeeded", version });
    } catch (error) {
      this.#io.log("update download failed", { message: String(error) });
      this.#failDownload("download-error", downloadedPath);
    }
  }

  #failCheck(reason: string): void {
    this.#io.log("update check ended without staging", { reason });
    this.#dispatch({ type: "check-failed" });
  }

  #failDownload(reason: string, downloadedPath: string | null): void {
    this.#io.log("update download discarded", { reason });
    if (downloadedPath) void this.#io.discard(downloadedPath).catch(() => undefined);
    this.#dispatch({ type: "download-failed" });
  }

  #dispatch(event: UpdateEvent): void {
    const next = reduceUpdateState(this.#state, event);
    if (next === this.#state) return;
    this.#state = next;
    const snapshot = this.status();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // One listener cannot break the updater.
      }
    }
  }
}
