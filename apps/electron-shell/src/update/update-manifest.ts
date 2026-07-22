/**
 * The update feed manifest — its wire format, and the PURE, adversarial-safe
 * parser that turns an untrusted feed body into a trusted, actionable release.
 *
 * ## Feed format
 *
 * The feed is a per-channel JSON document fetched by Electron main from a URL it
 * owns (never renderer input). One document describes the latest release on one
 * channel and where to get the platform artifacts:
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "channel": "stable",                  // must equal the channel we asked for
 *   "version": "2.8.0",                   // semver of the release
 *   "artifacts": [
 *     {
 *       "platform": "darwin-arm64",       // `${process.platform}-${process.arch}`
 *       "url": "https://dl.example/2.8.0/tmux-ide-darwin-arm64.zip",
 *       "size": 12345678,                 // exact byte length; enforced on download
 *       "sha256": "<64 lowercase hex>"    // artifact digest; enforced on download
 *     }
 *   ],
 *   "signature": "<base64 detached signature over the signed body>"
 * }
 * ```
 *
 * ## Trust chain
 *
 * 1. The manifest `signature` is a detached signature over the manifest's
 *    canonical body (every field EXCEPT `signature`). Verifying it against a
 *    pinned public key establishes that the manifest itself is authentic — see
 *    {@link ./update-verify.ts}. Without a pinned key the signature is advisory
 *    (dev builds); the {@link canonicalSignedBody} bytes are always produced so
 *    the seam has something to check.
 * 2. Only once the manifest is trusted do we trust the per-artifact `sha256`,
 *    which then guards the downloaded bytes against corruption AND tampering.
 *
 * This module is PURE: it never fetches, never touches disk, never throws. It
 * validates structure, channel, semver ordering (no downgrades), platform
 * availability, artifact size bounds, digest shape, and URL trust — returning a
 * discriminated verdict the io layer acts on.
 */
import { compareVersions } from "./semver.ts";

/** Bump only on a breaking change to the manifest shape. */
export const UPDATE_MANIFEST_SCHEMA_VERSION = 1 as const;

/** A single platform artifact, after validation. */
export interface UpdateArtifact {
  readonly platform: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

/** A fully validated, trusted-shape release manifest for one platform. */
export interface ResolvedUpdateManifest {
  readonly version: string;
  readonly channel: string;
  readonly artifact: UpdateArtifact;
  /**
   * The exact bytes the detached {@link signature} is expected to cover: the
   * manifest's canonical body with the `signature` field removed. Stable and
   * deterministic so a verifier can reproduce it.
   */
  readonly signedBody: string;
  /** The detached signature string as published, or null when absent. */
  readonly signature: string | null;
}

export type UpdateManifestRejectionReason =
  | "malformed-json"
  | "schema-unsupported"
  | "schema-invalid"
  | "channel-mismatch"
  | "not-newer"
  | "platform-unsupported"
  | "artifact-invalid"
  | "artifact-too-large"
  | "artifact-url-untrusted";

export type UpdateManifestVerdict =
  | { readonly ok: true; readonly manifest: ResolvedUpdateManifest }
  | { readonly ok: false; readonly reason: UpdateManifestRejectionReason };

export interface ParseUpdateManifestContext {
  /** The running version — a release must be strictly newer to be accepted. */
  readonly currentVersion: string;
  /** The channel we requested; a mismatched manifest is rejected. */
  readonly channel: string;
  /** `${process.platform}-${process.arch}` of the running app. */
  readonly platformKey: string;
  /** Hard ceiling on an artifact's declared size (bytes). */
  readonly maxArtifactBytes: number;
  /**
   * URL trust policy. Production pins https-only; tests may allow loopback http.
   * A URL that does not parse, or that this predicate rejects, fails closed.
   */
  readonly trustArtifactUrl: (url: URL) => boolean;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * PURE — the canonical bytes a manifest signature must cover: a stable
 * JSON serialization of the body with `signature` stripped. Keys are emitted in
 * a fixed order so the same logical manifest always yields identical bytes,
 * independent of how the publisher happened to order fields.
 */
export function canonicalSignedBody(body: {
  schemaVersion: number;
  channel: string;
  version: string;
  artifacts: readonly UpdateArtifact[];
}): string {
  const artifacts = body.artifacts.map((artifact) => ({
    platform: artifact.platform,
    url: artifact.url,
    size: artifact.size,
    sha256: artifact.sha256,
  }));
  return JSON.stringify({
    schemaVersion: body.schemaVersion,
    channel: body.channel,
    version: body.version,
    artifacts,
  });
}

function validateArtifact(
  value: unknown,
  context: ParseUpdateManifestContext,
): UpdateArtifact | UpdateManifestRejectionReason {
  if (!isPlainObject(value)) return "artifact-invalid";
  const { platform, url, size, sha256 } = value;
  if (typeof platform !== "string" || platform.length === 0) return "artifact-invalid";
  if (typeof url !== "string" || url.length === 0) return "artifact-invalid";
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0)
    return "artifact-invalid";
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) return "artifact-invalid";
  if (size > context.maxArtifactBytes) return "artifact-too-large";
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return "artifact-url-untrusted";
  }
  if (!context.trustArtifactUrl(parsedUrl)) return "artifact-url-untrusted";
  return { platform, url, size, sha256 };
}

/**
 * PURE — validate an untrusted feed body into a {@link UpdateManifestVerdict}.
 * Never throws. Rejects (in order): non-JSON, unsupported/invalid schema, a
 * channel that does not match the request, a version that is not strictly newer
 * than the running one (blocks downgrades and re-applies), an absent artifact
 * for this platform, and any artifact that is malformed, oversized, or points at
 * an untrusted URL.
 */
export function parseUpdateManifest(
  raw: string,
  context: ParseUpdateManifestContext,
): UpdateManifestVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "schema-invalid" };

  const { schemaVersion, channel, version, artifacts, signature } = parsed;
  if (schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) {
    return { ok: false, reason: "schema-unsupported" };
  }
  if (typeof channel !== "string" || channel.length === 0) {
    return { ok: false, reason: "schema-invalid" };
  }
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, reason: "schema-invalid" };
  }
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { ok: false, reason: "schema-invalid" };
  }
  if (signature !== undefined && (typeof signature !== "string" || signature.length === 0)) {
    return { ok: false, reason: "schema-invalid" };
  }
  if (channel !== context.channel) return { ok: false, reason: "channel-mismatch" };
  if (compareVersions(version, context.currentVersion) <= 0) {
    return { ok: false, reason: "not-newer" };
  }

  const validated: UpdateArtifact[] = [];
  for (const entry of artifacts) {
    const result = validateArtifact(entry, context);
    if (typeof result === "string") {
      // A structurally broken or untrusted artifact anywhere in the list is a
      // hard reject: a tampered manifest must never be partially trusted.
      return { ok: false, reason: result };
    }
    validated.push(result);
  }

  const artifact = validated.find((candidate) => candidate.platform === context.platformKey);
  if (!artifact) return { ok: false, reason: "platform-unsupported" };

  const signedBody = canonicalSignedBody({
    schemaVersion: UPDATE_MANIFEST_SCHEMA_VERSION,
    channel,
    version,
    artifacts: validated,
  });
  return {
    ok: true,
    manifest: {
      version,
      channel,
      artifact,
      signedBody,
      signature: signature ?? null,
    },
  };
}

/** PURE — production URL trust: https only, no credentials, no fragment tricks. */
export function httpsOnlyArtifactUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hostname.length > 0
  );
}

/** PURE — test/dev URL trust: https OR loopback http (local feed servers). */
export function loopbackOrHttpsArtifactUrl(url: URL): boolean {
  if (httpsOnlyArtifactUrl(url)) return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    url.username.length === 0 &&
    url.password.length === 0
  );
}
