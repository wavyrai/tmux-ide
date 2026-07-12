/**
 * Remote agent-detection manifest packs — `tmux-ide update --manifests` (M25.4).
 *
 * Detection breadth shouldn't wait for an npm release: agent TUIs change their
 * chrome between our versions, and a re-tuned manifest is pure data. This
 * module fetches a versioned MANIFEST PACK from a static URL and installs it
 * where the manifest loader already hot-merges from.
 *
 * ## The pack format (publish contract)
 *
 * A single JSON document:
 *
 * ```json
 * {
 *   "schema": 1,                       // this format's version — reject others
 *   "pack": "2026.07.12",              // pack version (informational, any string)
 *   "manifests": [                     // one AgentManifest per entry, exactly the
 *     {                                //   override-file shape manifest-loader.ts
 *       "id": "claude",                //   documents (id, commands[], states,
 *       "commands": ["claude"],        //   optional confidence)
 *       "confidence": "tuned",
 *       "states": { "working": { "any": [{ "contains": "esc to interrupt" }] } }
 *     }
 *   ]
 * }
 * ```
 *
 * Publishing: attach the document as the `agent-manifests.json` asset on a
 * GitHub release — {@link manifestPackUrl} constructs the same
 * `releases/download/v<version>/<asset>` URL the TUI-binary download uses, so
 * a pack rides every release and a NEWER pack can be re-attached to the
 * CURRENT release tag at any time (the fetch always re-downloads; the pane
 * option cache never pins it).
 *
 * ## Precedence (verified by tests)
 *
 * The pack installs into `<agent-detection>/pack/manifest-pack.json` — a
 * SUBDIRECTORY of the user-override dir, so `readOverrideManifests` (which
 * lists only `*.json` FILES in the top level) never sees it. The loader merges
 * `bundled → pack → user`: a pack manifest replaces a bundled id or appends a
 * new one, and a user's own `<agent-detection>/*.json` file ALWAYS beats both.
 *
 * ## Safety
 *
 * - Https only for remote URLs. `file://` and loopback `http://` are accepted
 *   ONLY so tests/dev can exercise the flow without the network — anything
 *   else is rejected before a byte is fetched.
 * - The pack is schema-validated ({@link validateManifestPack}) BEFORE being
 *   written; an invalid pack fails loudly and leaves the previous one intact.
 * - The gated periodic refresh ({@link maybeRefreshManifestPack}) rides the
 *   existing daily update check (see {@link ./update-check.ts}) — no timers or
 *   daemons of its own — and is double-gated on `updates.check` (the caller)
 *   and `updates.manifests` (read here, default false).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentManifest } from "../tui/detect/manifest.ts";
import { overrideDir, validateManifestShape } from "../tui/detect/manifest-loader.ts";
import { getAppConfig } from "./app-config.ts";
import { getCurrentVersion } from "./update-check.ts";
import { RELEASE_REPO } from "./tui-binary.ts";

/** The pack-format version this build understands. */
export const MANIFEST_PACK_SCHEMA = 1;

/** The release asset name a pack is published under. */
export const MANIFEST_PACK_ASSET = "agent-manifests.json";

/** Env override for the pack URL (tests/dev; may be `file://` or loopback http). */
export const MANIFEST_PACK_URL_ENV = "TMUX_IDE_MANIFEST_PACK_URL";

/** A fetched/validated manifest pack. */
export interface ManifestPack {
  schema: number;
  /** Pack version — informational (surfaced in logs), any non-empty string. */
  pack: string;
  manifests: AgentManifest[];
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * PURE — the default pack URL for a version:
 * `https://github.com/<repo>/releases/download/v<version>/agent-manifests.json`
 * (the same asset-URL construction as the TUI binary download).
 */
export function manifestPackUrl(version: string = getCurrentVersion()): string {
  const v = version.startsWith("v") ? version.slice(1) : version;
  return `https://github.com/${RELEASE_REPO}/releases/download/v${v}/${MANIFEST_PACK_ASSET}`;
}

/**
 * PURE — is `url` an acceptable pack source? `https:` always; `file:` and
 * LOOPBACK `http:` (127.0.0.1 / localhost / [::1]) only so tests and local
 * fixtures can drive the flow. Any other scheme/host is rejected.
 */
export function isAllowedPackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "file:") return true;
  if (parsed.protocol === "http:") {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  }
  return false;
}

/**
 * PURE — validate an untrusted pack document. Returns the typed pack or a
 * human-readable reason. Every manifest entry must pass the SAME structural
 * validation user override files do ({@link validateManifestShape}) — one bad
 * entry rejects the whole pack (a partial install would be harder to reason
 * about than a loud failure). Never throws.
 */
export function validateManifestPack(
  value: unknown,
): { ok: true; pack: ManifestPack } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "not an object" };
  const v = value as Record<string, unknown>;
  if (v.schema !== MANIFEST_PACK_SCHEMA) {
    return {
      ok: false,
      reason: `unsupported schema ${JSON.stringify(v.schema)} (want ${MANIFEST_PACK_SCHEMA})`,
    };
  }
  if (typeof v.pack !== "string" || v.pack.trim().length === 0) {
    return { ok: false, reason: "missing pack version string" };
  }
  if (!Array.isArray(v.manifests) || v.manifests.length === 0) {
    return { ok: false, reason: "manifests must be a non-empty array" };
  }
  for (let i = 0; i < v.manifests.length; i++) {
    if (!validateManifestShape(v.manifests[i])) {
      return {
        ok: false,
        reason: `manifests[${i}] is not a valid AgentManifest (need id, commands[], states)`,
      };
    }
  }
  return {
    ok: true,
    pack: { schema: MANIFEST_PACK_SCHEMA, pack: v.pack, manifests: v.manifests as AgentManifest[] },
  };
}

// ---------------------------------------------------------------------------
// io
// ---------------------------------------------------------------------------

/** The installed pack's directory: `<agent-detection>/pack/`. */
export function packDir(): string {
  return join(overrideDir(), "pack");
}

/** The installed pack's path: `<agent-detection>/pack/manifest-pack.json`. */
export function packPath(): string {
  return join(packDir(), "manifest-pack.json");
}

/**
 * io — fetch and validate a pack. `file://` URLs are read from disk (Node's
 * fetch does not speak file:); everything else goes through fetch with a
 * timeout. THROWS with an actionable message on a disallowed URL, a failed
 * fetch, malformed JSON, or a schema-invalid pack — the caller decides whether
 * that is loud (CLI) or swallowed (the background refresh).
 */
export async function fetchManifestPack(url: string, timeoutMs = 5000): Promise<ManifestPack> {
  if (!isAllowedPackUrl(url)) {
    throw new Error(
      `refusing manifest-pack URL ${url} — https only (file:// and loopback http are allowed for local testing)`,
    );
  }
  let body: string;
  if (url.startsWith("file:")) {
    body = readFileSync(fileURLToPath(url), "utf8");
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(
          `manifest-pack download failed (${url} → HTTP ${res.status} ${res.statusText})`,
        );
      }
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`manifest pack at ${url} is not valid JSON`);
  }
  const verdict = validateManifestPack(parsed);
  if (!verdict.ok) {
    throw new Error(`manifest pack at ${url} rejected: ${verdict.reason}`);
  }
  return verdict.pack;
}

/**
 * io — write a validated pack into place atomically (temp-in-same-dir →
 * rename, so a crash never leaves a half-written pack the loader would then
 * warn about every run). Returns the installed path.
 */
export function installManifestPack(pack: ManifestPack, dest: string = packPath()): string {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pack, null, 2));
  renameSync(tmp, dest);
  return dest;
}

/**
 * io — the `tmux-ide update --manifests` flow: resolve the URL (env override →
 * the release-asset default), fetch, validate, install. Throws loudly on any
 * failure (the CLI surfaces it); returns what was installed for reporting.
 */
export async function updateManifestPack(
  opts: { url?: string; log?: (msg: string) => void } = {},
): Promise<{ path: string; packVersion: string; count: number }> {
  const log = opts.log ?? (() => {});
  const url = opts.url ?? process.env[MANIFEST_PACK_URL_ENV] ?? manifestPackUrl();
  log(`fetching manifest pack from ${url}`);
  const pack = await fetchManifestPack(url);
  const path = installManifestPack(pack);
  log(`installed pack ${pack.pack} (${pack.manifests.length} manifests) → ${path}`);
  return { path, packVersion: pack.pack, count: pack.manifests.length };
}

/**
 * io — the GATED background refresh the daily update check invokes (see
 * `runUpdateCheck` in {@link ./update-check.ts}). Opt-in via
 * `updates.manifests: true` (default false); NEVER throws — a failed refresh
 * just keeps the previous pack, exactly like a failed version check keeps the
 * previous `latest`.
 */
export async function maybeRefreshManifestPack(): Promise<void> {
  try {
    if (!getAppConfig().updates.manifests) return;
    await updateManifestPack();
  } catch {
    // Offline, a missing release asset, or an invalid pack — all degrade to
    // "keep what we have"; the explicit CLI path reports errors loudly instead.
  }
}
