import { describe, expect, it } from "vitest";

import {
  pinnedKeyManifestVerifier,
  unsignedFeedManifestVerifier,
  verifyArtifactChecksum,
  verifyManifestSignature,
} from "./update-verify.ts";

describe("verifyManifestSignature", () => {
  it("verifies a valid signature under a pinned key", () => {
    const verifier = pinnedKeyManifestVerifier({
      keyVerify: (body, sig) => sig === `signed(${body})`,
    });
    expect(
      verifyManifestSignature(verifier, { signedBody: "BODY", signature: "signed(BODY)" }),
    ).toBe("verified");
  });

  it("rejects an invalid signature under a pinned key", () => {
    const verifier = pinnedKeyManifestVerifier({ keyVerify: () => false });
    expect(verifyManifestSignature(verifier, { signedBody: "BODY", signature: "nope" })).toBe(
      "rejected",
    );
  });

  it("rejects a missing signature under a pinned key", () => {
    const verifier = pinnedKeyManifestVerifier({ keyVerify: () => true });
    expect(verifyManifestSignature(verifier, { signedBody: "BODY", signature: null })).toBe(
      "rejected",
    );
  });

  it("treats a verifier that throws as a hard failure, never a pass", () => {
    const verifier = pinnedKeyManifestVerifier({
      keyVerify: () => {
        throw new Error("boom");
      },
    });
    expect(verifyManifestSignature(verifier, { signedBody: "BODY", signature: "x" })).toBe(
      "verifier-error",
    );
  });

  it("unsigned-feed verifier accepts absent signatures but rejects present ones", () => {
    const verifier = unsignedFeedManifestVerifier();
    expect(verifyManifestSignature(verifier, { signedBody: "BODY", signature: null })).toBe(
      "verified",
    );
    // A signature this build cannot check must not be silently honored.
    expect(verifyManifestSignature(verifier, { signedBody: "BODY", signature: "anything" })).toBe(
      "rejected",
    );
  });
});

describe("verifyArtifactChecksum", () => {
  it("matches identical digests case- and whitespace-insensitively", () => {
    expect(verifyArtifactChecksum("ABC123", "  abc123 ")).toBe("match");
  });

  it("rejects a mismatch", () => {
    expect(verifyArtifactChecksum("abc123", "def456")).toBe("mismatch");
  });

  it("rejects an empty computed digest", () => {
    expect(verifyArtifactChecksum("", "")).toBe("mismatch");
    expect(verifyArtifactChecksum("   ", "abc")).toBe("mismatch");
  });
});
