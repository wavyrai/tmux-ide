/**
 * Production io wiring for the auto-updater: config resolution, the Electron
 * `net` + node fs/crypto {@link DesktopUpdaterIo}, marker read/clear, and the
 * launch-time {@link StagedUpdateFilesystem}. Kept apart from the pure/orchestration
 * modules so those stay testable without Electron or a real filesystem.
 *
 * State lives under a per-user directory governed by `TMUX_IDE_HOME` (tests /
 * overrides) or the Electron `userData` dir (production). Nothing here runs in dev
 * mode — main gates the whole updater on `app.isPackaged`.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { httpsOnlyArtifactUrl, loopbackOrHttpsArtifactUrl } from "./update-manifest.ts";
import type { DesktopUpdaterConfig, DesktopUpdaterIo } from "./desktop-updater.ts";
import {
  parsePendingUpdateMarker,
  serializePendingUpdateMarker,
  type PendingUpdateMarker,
  type StagedUpdateFilesystem,
} from "./staged-update.ts";

/** Placeholder feed base. Release engineering pins the real signed feed origin. */
export const DEFAULT_UPDATE_FEED_BASE_URL = "https://desktop-updates.tmux-ide.dev";
export const DEFAULT_UPDATE_CHANNEL = "stable";
/** 6h cadence: modest, never on a hot path, unref'd so it cannot hold the app open. */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 1 GiB ceiling — comfortably above a packaged desktop app, far below abuse. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

/** Resolve the state dir that holds the marker + staged payloads. */
export function resolveUpdateStateDir(userDataDir: string): string {
  const home = process.env.TMUX_IDE_HOME;
  const root = home && home.length > 0 ? join(home, ".tmux-ide") : userDataDir;
  return join(root, "updates");
}

export function pendingMarkerPath(stateDir: string): string {
  return join(stateDir, "pending-update.json");
}

/**
 * Resolve the updater config from the environment, with safe defaults. `enabled`
 * is the caller's call (main passes `app.isPackaged`); everything else is
 * overridable for tests via env. Insecure (loopback http) artifact URLs are only
 * trusted when explicitly opted in — never in a default production build.
 */
export function resolveUpdaterConfig(input: {
  readonly enabled: boolean;
  readonly platformKey: string;
  readonly currentVersion: string;
}): DesktopUpdaterConfig {
  const env = process.env;
  const allowInsecure = env.TMUX_IDE_UPDATE_ALLOW_INSECURE === "1";
  return {
    enabled: input.enabled && env.TMUX_IDE_UPDATE_DISABLE !== "1",
    feedBaseUrl: env.TMUX_IDE_UPDATE_FEED_URL ?? DEFAULT_UPDATE_FEED_BASE_URL,
    channel: env.TMUX_IDE_UPDATE_CHANNEL ?? DEFAULT_UPDATE_CHANNEL,
    platformKey: input.platformKey,
    currentVersion: input.currentVersion,
    maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    checkIntervalMs: DEFAULT_UPDATE_CHECK_INTERVAL_MS,
    trustArtifactUrl: allowInsecure ? loopbackOrHttpsArtifactUrl : httpsOnlyArtifactUrl,
  };
}

/** Minimal shape of Electron's `net` used for fetching — injected for testing. */
export interface UpdaterNet {
  fetch(url: string): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly body: ReadableStream<Uint8Array> | null;
    text(): Promise<string>;
  }>;
}

async function streamToFileWithDigest(
  body: ReadableStream<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  const sink = createWriteStream(destPath);
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("artifact exceeds maximum size");
      hash.update(value);
      await new Promise<void>((resolve, reject) => {
        sink.write(value, (error) => (error ? reject(error) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    sink.destroy();
    await rm(destPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { sha256: hash.digest("hex"), size };
}

/**
 * The production {@link DesktopUpdaterIo}. Fetches manifests and downloads
 * artifacts through Electron `net` (proxy/cert-store aware), streams to a private
 * temp dir with a byte cap and streamed SHA-256, and stages verified payloads
 * beside the marker.
 */
export function createUpdaterIo(input: {
  readonly stateDir: string;
  readonly net: UpdaterNet;
  readonly logger?: (message: string, detail?: Record<string, unknown>) => void;
}): DesktopUpdaterIo {
  const stagingDir = join(input.stateDir, "staged");
  const downloadsDir = join(input.stateDir, "downloads");
  const log = input.logger ?? (() => undefined);
  return {
    now: () => Date.now(),
    log,
    fetchManifest: async (url) => {
      try {
        const response = await input.net.fetch(url);
        if (!response.ok) return null;
        return await response.text();
      } catch {
        return null;
      }
    },
    downloadArtifact: async ({ url, maxBytes }) => {
      const response = await input.net.fetch(url);
      if (!response.ok || !response.body) {
        throw new Error(`artifact fetch failed with status ${response.status}`);
      }
      await mkdir(downloadsDir, { recursive: true });
      const scratch = await mkdtemp(join(downloadsDir, "dl-"));
      const path = join(scratch, "artifact.bin");
      const { sha256, size } = await streamToFileWithDigest(response.body, path, maxBytes);
      return { path, sha256, size };
    },
    stageArtifact: async ({ downloadedPath, version }) => {
      await mkdir(stagingDir, { recursive: true });
      const stagedPath = join(stagingDir, `tmux-ide-${version}.payload`);
      await rm(stagedPath, { force: true }).catch(() => undefined);
      await rename(downloadedPath, stagedPath);
      return stagedPath;
    },
    writeMarker: async (marker) => {
      await mkdir(input.stateDir, { recursive: true });
      const path = pendingMarkerPath(input.stateDir);
      const tempPath = `${path}.tmp`;
      await new Promise<void>((resolve, reject) => {
        const sink = createWriteStream(tempPath);
        sink.end(serializePendingUpdateMarker(marker), (error?: Error | null) =>
          error ? reject(error) : resolve(),
        );
      });
      await rename(tempPath, path);
    },
    discard: async (path) => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** io — read the durable pending-update marker, or null when absent/corrupt. */
export async function readPendingMarker(stateDir: string): Promise<PendingUpdateMarker | null> {
  try {
    const raw = await readFile(pendingMarkerPath(stateDir), "utf8");
    return parsePendingUpdateMarker(raw);
  } catch {
    return null;
  }
}

/** io — remove the pending-update marker (after apply, or when discarded). */
export async function clearPendingMarker(stateDir: string): Promise<void> {
  await rm(pendingMarkerPath(stateDir), { force: true }).catch(() => undefined);
}

/**
 * The launch-time {@link StagedUpdateFilesystem}. `swapIntoPlace` is a
 * rename-aside-then-rename-in dance (the closest POSIX gets to atomic for a
 * directory bundle): move the old install aside, move the staged payload into
 * place, then best-effort delete the old copy. If the second rename fails the old
 * install is restored, so a launch never ends up with no app. Real notarized
 * distribution refines this; the seam is stable.
 */
export function createStagedUpdateFilesystem(): StagedUpdateFilesystem {
  return {
    pathExists: async (path) => {
      try {
        await stat(path);
        return true;
      } catch {
        return false;
      }
    },
    digestFile: async (path) => {
      const hash = createHash("sha256");
      hash.update(await readFile(path));
      return hash.digest("hex");
    },
    swapIntoPlace: async (stagedPath, installPath) => {
      const asidePath = `${installPath}.previous-${Date.now()}`;
      let movedAside = false;
      try {
        await rename(installPath, asidePath);
        movedAside = true;
      } catch {
        // No current install at the target (fresh location): proceed to place.
      }
      try {
        await rename(stagedPath, installPath);
      } catch (error) {
        if (movedAside) await rename(asidePath, installPath).catch(() => undefined);
        throw error;
      }
      if (movedAside) await rm(asidePath, { recursive: true, force: true }).catch(() => undefined);
    },
    discard: async (path) => {
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** Fallback state dir when Electron `userData` is unavailable (never in prod). */
export function fallbackUserDataDir(): string {
  return join(homedir(), ".tmux-ide-desktop");
}

/** A scratch temp dir for the updater's own use outside the state tree. */
export function updaterScratchDir(): string {
  return join(tmpdir(), "tmux-ide-updates");
}
