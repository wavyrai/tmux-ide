/**
 * The built-in update check — "you're on an old tmux-ide" surfaced where
 * everyone already looks: the dock.
 *
 * Once a day the chrome updater asks npm for the latest published version, caches
 * the answer in `~/.tmux-ide/update-check.json` (overridable via `TMUX_IDE_HOME`,
 * consistent with {@link ../tui/chrome/welcome.ts}), and — when the cached latest
 * is newer than what's running — every surface reads that ONE cache to decide
 * whether to nudge: the dock's `⬆ v<latest>` segment, a one-time toast per
 * version, `tmux-ide doctor`, the actions menu, and the `tmux-ide` start hint.
 *
 * The split, as elsewhere: {@link compareSemver} / {@link isNewer} /
 * {@link shouldCheck} / {@link parseRegistryResponse} are PURE (unit-tested, never
 * throw); {@link fetchLatestVersion}, the cache read/write, and the throttled
 * {@link runUpdateCheck} are the thin — and strictly OFFLINE-SAFE — io wrappers.
 * Nothing here ever throws into the updater loop: a failed fetch, an unreadable
 * cache, or a garbage registry body all degrade to "no update known".
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm dist-tag endpoint that returns `{ "version": "x.y.z", … }`. */
export const REGISTRY_URL = "https://registry.npmjs.org/tmux-ide/latest";

/** Re-check no more than once per this window (24h). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The cheap, cache-derived answer every surface reads. */
export interface UpdateStatus {
  /** The latest published version the last check saw, or null when unknown. */
  latest: string | null;
  /** True when {@link latest} is strictly newer than the running version. */
  updateAvailable: boolean;
}

/** The on-disk cache shape (`~/.tmux-ide/update-check.json`). */
export interface UpdateCache {
  /** Epoch ms of the last network check (throttles {@link shouldCheck}). */
  lastCheckedAt: number | null;
  /** The latest version that check saw, or null. */
  latest: string | null;
  /** Versions we've already toasted about (one-time-per-version debounce). */
  notified?: string[];
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

interface ParsedSemver {
  nums: [number, number, number];
  /** The prerelease tag (`1.0.0-rc.1` → `rc.1`), or "" for a release. */
  pre: string;
}

/**
 * PURE — split `[v]MAJOR.MINOR.PATCH[-prerelease][+build]` into its numeric core
 * and prerelease tag. Lenient: a leading `v`, build metadata (`+…`), and missing
 * or non-numeric core parts are all tolerated (coerced to 0), so a malformed
 * version compares as `0.0.0` instead of throwing.
 */
function parseSemver(version: string): ParsedSemver {
  const core = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dash = core.indexOf("-");
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? "" : core.slice(dash + 1);
  const parts = main.split(".");
  const num = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { nums: [num(0), num(1), num(2)], pre };
}

/**
 * PURE — order two semver strings: `-1` if `a < b`, `1` if `a > b`, else `0`.
 *
 * Numeric core (major, minor, patch) compares field-by-field, so `2.10.0` sorts
 * ABOVE `2.6.0` (numeric, not lexical). Prerelease follows semver's rule: a
 * release outranks a prerelease of the same core (`1.0.0` > `1.0.0-rc`); two
 * prereleases fall back to a plain lexical compare of their tags (a simple, good-
 * enough ordering — we never need to rank `rc.2` vs `rc.10` precisely).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i]! !== pb.nums[i]!) return pa.nums[i]! < pb.nums[i]! ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1; // release > prerelease of same core
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** PURE — is `latest` strictly newer than `current`? */
export function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) === 1;
}

/**
 * PURE — should we hit the network again? True when we've never checked
 * (`lastCheckedAt` null) or the last check was at least {@link CHECK_INTERVAL_MS}
 * ago. A future `lastCheckedAt` (clock skew) reads as "recent" and skips — the
 * daily tick self-heals once the clock passes it.
 */
export function shouldCheck(lastCheckedAt: number | null, nowMs: number): boolean {
  if (lastCheckedAt === null) return true;
  return nowMs - lastCheckedAt >= CHECK_INTERVAL_MS;
}

/**
 * PURE — pull the `version` string out of a raw npm dist-tag response body.
 * Returns null (never throws) for malformed JSON, a non-object, or a
 * missing/empty/non-string `version`.
 */
export function parseRegistryResponse(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/**
 * PURE — derive the {@link UpdateStatus} for a running version from a (possibly
 * null) cached latest. The single place "is there an update?" is decided, so
 * every surface agrees.
 */
export function deriveStatus(latest: string | null, currentVersion: string): UpdateStatus {
  return {
    latest,
    updateAvailable: latest !== null && isNewer(latest, currentVersion),
  };
}

// ---------------------------------------------------------------------------
// io — cache + network (all offline-safe, never throw)
// ---------------------------------------------------------------------------

/**
 * Absolute path to the cache file: `<home>/update-check.json`, where `<home>` is
 * `TMUX_IDE_HOME` when set (tests / per-run overrides), else `~/.tmux-ide` — the
 * same home resolution the welcome marker uses.
 */
export function updateCachePath(): string {
  const home = process.env.TMUX_IDE_HOME ?? join(homedir(), ".tmux-ide");
  return join(home, "update-check.json");
}

/** io — read + parse the cache, or null when absent/unreadable/malformed. */
export function readUpdateCache(): UpdateCache | null {
  const path = updateCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const lastCheckedAt = typeof obj.lastCheckedAt === "number" ? obj.lastCheckedAt : null;
    const latest = typeof obj.latest === "string" && obj.latest.length > 0 ? obj.latest : null;
    const notified = Array.isArray(obj.notified)
      ? obj.notified.filter((v): v is string => typeof v === "string")
      : undefined;
    return { lastCheckedAt, latest, ...(notified ? { notified } : {}) };
  } catch {
    return null;
  }
}

/** io — write the cache (creating `<home>` if needed). Best-effort, never throws. */
export function writeUpdateCache(cache: UpdateCache): void {
  const path = updateCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    // an unwritable cache just means we re-check next tick — never fatal
  }
}

/**
 * io — ask npm for the latest published version, or null on ANY failure (offline,
 * timeout, non-200, garbage body). Aborts after `timeoutMs` so a slow registry
 * can never stall the updater tick. This is the ONLY network call in the module.
 */
export async function fetchLatestVersion(timeoutMs = 3000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return parseRegistryResponse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The running tmux-ide version, read from the nearest `package.json`. Handles
 * BOTH the bundled CLI (`bin/cli.js`, so the repo-root package.json is one level
 * up) AND the dev source tree (this file at `packages/daemon/src/lib/`, so the
 * root is four levels up). The workspace `packages/daemon/package.json` is
 * deliberately NOT a candidate — it carries a placeholder version. Falls back to
 * `"0.0.0"` when nothing is readable (so an unknown version simply never shows an
 * update rather than crashing).
 */
export function getCurrentVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../package.json"), // bundled bin/cli.js → repo root
    join(here, "../../../../package.json"), // dev src/lib → repo root
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

/**
 * The cheap, network-FREE status read every surface uses: derive
 * {@link UpdateStatus} from the cache against the current version. `now`/
 * `currentVersion` are injectable for tests; the defaults read the live clock +
 * package version.
 */
export function getUpdateStatus({
  currentVersion = getCurrentVersion(),
}: { now?: number; currentVersion?: string } = {}): UpdateStatus {
  const cache = readUpdateCache();
  return deriveStatus(cache?.latest ?? null, currentVersion);
}

/**
 * io — the throttled network refresh (called fire-and-forget from the updater
 * tick). Does nothing if the last check was inside {@link CHECK_INTERVAL_MS};
 * otherwise fetches the latest version and rewrites the cache with a fresh
 * `lastCheckedAt`. On a failed fetch it still stamps `lastCheckedAt` (so we don't
 * hammer a flaky/offline registry every tick) while KEEPING the previously known
 * `latest`. Never throws.
 */
export async function runUpdateCheck({ now = Date.now() }: { now?: number } = {}): Promise<void> {
  const cache = readUpdateCache();
  if (!shouldCheck(cache?.lastCheckedAt ?? null, now)) return;
  // The agent-detection manifest-pack refresh RIDES this same daily throttle
  // (M25.4) — no timer of its own, gated again inside on `updates.manifests`
  // (default false) and never throwing. Dynamic import: manifest-pack imports
  // this module for getCurrentVersion, so a static import would be a cycle.
  void import("./manifest-pack.ts").then((m) => m.maybeRefreshManifestPack()).catch(() => {});
  const fetched = await fetchLatestVersion();
  writeUpdateCache({
    lastCheckedAt: now,
    latest: fetched ?? cache?.latest ?? null,
    ...(cache?.notified ? { notified: cache.notified } : {}),
  });
}

/**
 * The tick's entry point: return the cheap cache-derived {@link UpdateStatus} NOW,
 * and (when `enabled`) kick off the throttled network refresh in the background so
 * the NEXT tick sees a fresh answer. Disabled (`updates.check: false`) → always
 * "no update", no network. The background refresh is deliberately un-awaited: the
 * tick must never block on the registry.
 */
export function maybeCheckForUpdate({
  enabled,
  now = Date.now(),
  currentVersion = getCurrentVersion(),
}: {
  enabled: boolean;
  now?: number;
  currentVersion?: string;
}): UpdateStatus {
  if (!enabled) return { latest: null, updateAvailable: false };
  const status = getUpdateStatus({ now, currentVersion });
  void runUpdateCheck({ now }).catch(() => {});
  return status;
}

/**
 * io — record that we've toasted about `version` and report whether this is the
 * FIRST time (so the caller should actually toast). Persisted in the cache file's
 * `notified` list so the one-time guarantee survives updater restarts — the old
 * in-memory notify debounce would re-fire on every respawn. Best-effort: if the
 * cache can't be written we still return the in-memory verdict.
 */
export function markUpdateNotified(version: string): boolean {
  const cache = readUpdateCache() ?? { lastCheckedAt: null, latest: null };
  const notified = cache.notified ?? [];
  if (notified.includes(version)) return false;
  writeUpdateCache({ ...cache, notified: [...notified, version] });
  return true;
}
