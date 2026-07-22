import { describe, expect, it } from "vitest";

import {
  canonicalSignedBody,
  httpsOnlyArtifactUrl,
  loopbackOrHttpsArtifactUrl,
  parseUpdateManifest,
  type ParseUpdateManifestContext,
} from "./update-manifest.ts";

const SHA = "a".repeat(64);

function context(overrides: Partial<ParseUpdateManifestContext> = {}): ParseUpdateManifestContext {
  return {
    currentVersion: "2.7.0",
    channel: "stable",
    platformKey: "darwin-arm64",
    maxArtifactBytes: 100_000,
    trustArtifactUrl: loopbackOrHttpsArtifactUrl,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    channel: "stable",
    version: "2.8.0",
    artifacts: [
      {
        platform: "darwin-arm64",
        url: "https://dl.example/2.8.0/darwin-arm64.zip",
        size: 2048,
        sha256: SHA,
      },
    ],
    signature: "sig-base64",
    ...overrides,
  });
}

describe("parseUpdateManifest", () => {
  it("accepts a well-formed, newer, on-channel manifest for this platform", () => {
    const verdict = parseUpdateManifest(manifest(), context());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.manifest.version).toBe("2.8.0");
    expect(verdict.manifest.artifact.platform).toBe("darwin-arm64");
    expect(verdict.manifest.artifact.sha256).toBe(SHA);
    expect(verdict.manifest.signature).toBe("sig-base64");
    expect(verdict.manifest.signedBody).not.toContain("sig-base64");
  });

  it("selects the artifact matching the running platform", () => {
    const raw = manifest({
      artifacts: [
        { platform: "linux-x64", url: "https://dl.example/l.zip", size: 10, sha256: SHA },
        { platform: "darwin-arm64", url: "https://dl.example/m.zip", size: 20, sha256: SHA },
      ],
    });
    const verdict = parseUpdateManifest(raw, context());
    expect(verdict.ok && verdict.manifest.artifact.url).toBe("https://dl.example/m.zip");
  });

  it("rejects non-JSON", () => {
    expect(parseUpdateManifest("{not json", context())).toEqual({
      ok: false,
      reason: "malformed-json",
    });
  });

  it("rejects a non-object body", () => {
    expect(parseUpdateManifest("[]", context())).toEqual({ ok: false, reason: "schema-invalid" });
    expect(parseUpdateManifest("42", context())).toEqual({ ok: false, reason: "schema-invalid" });
  });

  it("rejects an unsupported schema version", () => {
    expect(parseUpdateManifest(manifest({ schemaVersion: 2 }), context())).toEqual({
      ok: false,
      reason: "schema-unsupported",
    });
  });

  it("rejects a channel mismatch", () => {
    expect(parseUpdateManifest(manifest({ channel: "beta" }), context())).toEqual({
      ok: false,
      reason: "channel-mismatch",
    });
  });

  it("rejects a downgrade and an equal version (no re-apply)", () => {
    expect(parseUpdateManifest(manifest({ version: "2.6.0" }), context())).toEqual({
      ok: false,
      reason: "not-newer",
    });
    expect(parseUpdateManifest(manifest({ version: "2.7.0" }), context())).toEqual({
      ok: false,
      reason: "not-newer",
    });
  });

  it("compares versions numerically, not lexically", () => {
    const verdict = parseUpdateManifest(
      manifest({ version: "2.10.0" }),
      context({ currentVersion: "2.9.0" }),
    );
    expect(verdict.ok).toBe(true);
  });

  it("rejects an empty or missing artifacts list", () => {
    expect(parseUpdateManifest(manifest({ artifacts: [] }), context())).toEqual({
      ok: false,
      reason: "schema-invalid",
    });
    expect(parseUpdateManifest(manifest({ artifacts: undefined }), context())).toEqual({
      ok: false,
      reason: "schema-invalid",
    });
  });

  it("rejects when no artifact matches this platform", () => {
    const raw = manifest({
      artifacts: [
        { platform: "win32-x64", url: "https://dl.example/w.zip", size: 10, sha256: SHA },
      ],
    });
    expect(parseUpdateManifest(raw, context())).toEqual({
      ok: false,
      reason: "platform-unsupported",
    });
  });

  it("rejects a malformed digest, non-positive size, or missing fields", () => {
    for (const artifact of [
      { platform: "darwin-arm64", url: "https://dl.example/a.zip", size: 10, sha256: "short" },
      { platform: "darwin-arm64", url: "https://dl.example/a.zip", size: 0, sha256: SHA },
      { platform: "darwin-arm64", url: "https://dl.example/a.zip", size: -5, sha256: SHA },
      { platform: "darwin-arm64", url: "", size: 10, sha256: SHA },
      { platform: "", url: "https://dl.example/a.zip", size: 10, sha256: SHA },
    ]) {
      expect(parseUpdateManifest(manifest({ artifacts: [artifact] }), context())).toEqual({
        ok: false,
        reason: "artifact-invalid",
      });
    }
  });

  it("rejects an oversized artifact", () => {
    const raw = manifest({
      artifacts: [
        { platform: "darwin-arm64", url: "https://dl.example/a.zip", size: 999999, sha256: SHA },
      ],
    });
    expect(parseUpdateManifest(raw, context({ maxArtifactBytes: 1000 }))).toEqual({
      ok: false,
      reason: "artifact-too-large",
    });
  });

  it("rejects an untrusted artifact URL under the https-only policy", () => {
    const raw = manifest({
      artifacts: [
        { platform: "darwin-arm64", url: "http://evil.example/a.zip", size: 10, sha256: SHA },
      ],
    });
    expect(parseUpdateManifest(raw, context({ trustArtifactUrl: httpsOnlyArtifactUrl }))).toEqual({
      ok: false,
      reason: "artifact-url-untrusted",
    });
  });

  it("rejects a URL carrying credentials even over https", () => {
    const raw = manifest({
      artifacts: [
        {
          platform: "darwin-arm64",
          url: "https://user:pw@dl.example/a.zip",
          size: 10,
          sha256: SHA,
        },
      ],
    });
    expect(parseUpdateManifest(raw, context({ trustArtifactUrl: httpsOnlyArtifactUrl }))).toEqual({
      ok: false,
      reason: "artifact-url-untrusted",
    });
  });

  it("rejects a present-but-empty signature", () => {
    expect(parseUpdateManifest(manifest({ signature: "" }), context())).toEqual({
      ok: false,
      reason: "schema-invalid",
    });
  });

  it("treats an absent signature as null (dev feed)", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      version: "2.8.0",
      artifacts: [
        { platform: "darwin-arm64", url: "https://dl.example/a.zip", size: 10, sha256: SHA },
      ],
    });
    const verdict = parseUpdateManifest(raw, context());
    expect(verdict.ok && verdict.manifest.signature).toBeNull();
  });
});

describe("canonicalSignedBody", () => {
  it("is stable across artifact field ordering", () => {
    const a = canonicalSignedBody({
      schemaVersion: 1,
      channel: "stable",
      version: "2.8.0",
      artifacts: [{ platform: "darwin-arm64", url: "https://x/a", size: 1, sha256: SHA }],
    });
    const b = canonicalSignedBody({
      schemaVersion: 1,
      channel: "stable",
      version: "2.8.0",
      // Same logical artifact, different key order.
      artifacts: [{ sha256: SHA, size: 1, url: "https://x/a", platform: "darwin-arm64" } as never],
    });
    expect(a).toBe(b);
  });
});
