/**
 * The verification seam between an untrusted download and an applied update.
 *
 * Two independent gates, both of which must pass before any staged bytes are
 * ever swapped into place:
 *
 * 1. **Manifest signature** — a detached signature over the manifest body
 *    ({@link ./update-manifest.ts} `signedBody`), checked against a pinned
 *    public key. This is the ROOT of trust: it is what makes the per-artifact
 *    digest meaningful. Real signing infrastructure (key management, Ed25519 /
 *    minisign, notarization) is deliberately OUT OF SCOPE for this card, so the
 *    concrete algorithm lives behind the {@link ManifestSignatureVerifier}
 *    interface. The default {@link pinnedKeyManifestVerifier} enforces the
 *    policy correctly the moment a verifier is supplied; the stub used until
 *    then is documented and explicit, never silent.
 *
 * 2. **Artifact checksum** — a SHA-256 of the downloaded bytes compared to the
 *    (now-trusted) manifest digest. This is fully implemented; it is a pure
 *    comparison over a hash the caller computes with node:crypto.
 *
 * The whole module is synchronous and side-effect free. It computes verdicts; it
 * does not read the network or disk.
 */

/**
 * The pluggable manifest-authenticity check. An implementation returns true iff
 * `signature` is a valid detached signature over `signedBody` for a key the
 * implementation trusts. Implementations MUST fail closed (return false) on any
 * malformed input rather than throwing.
 */
export interface ManifestSignatureVerifier {
  verify(input: { readonly signedBody: string; readonly signature: string | null }): boolean;
}

export type ManifestSignatureOutcome = "verified" | "rejected" | "verifier-error";

/**
 * Run the manifest signature gate. The verifier owns the policy for BOTH a
 * present signature (valid vs invalid) and a missing one (tolerated on a dev feed,
 * rejected under a pinned key). A verifier that throws is a hard failure
 * (`verifier-error`), never a pass.
 */
export function verifyManifestSignature(
  verifier: ManifestSignatureVerifier,
  input: { readonly signedBody: string; readonly signature: string | null },
): ManifestSignatureOutcome {
  try {
    return verifier.verify(input) ? "verified" : "rejected";
  } catch {
    return "verifier-error";
  }
}

/**
 * A verifier that trusts a manifest signed by a pinned key. Until real signing
 * lands, `keyVerify` is injected — production wiring supplies an Ed25519/minisign
 * check; tests supply a fixture. When constructed with `requireSignature: false`
 * (dev feeds), a missing signature is tolerated but a PRESENT-and-INVALID
 * signature is still rejected: downgrading trust is never silent.
 */
export function pinnedKeyManifestVerifier(options: {
  readonly keyVerify: (signedBody: string, signature: string) => boolean;
}): ManifestSignatureVerifier {
  return {
    verify: ({ signedBody, signature }) => {
      if (signature === null) return false;
      return options.keyVerify(signedBody, signature);
    },
  };
}

/**
 * The explicit no-signing-infrastructure stub. It ACCEPTS an unsigned manifest
 * and REJECTS any manifest that carries a signature — because this build has no
 * key to check it against, and honoring an unverifiable signature would be a
 * silent trust downgrade. Swap this for {@link pinnedKeyManifestVerifier} the
 * moment a pinned key exists.
 */
export function unsignedFeedManifestVerifier(): ManifestSignatureVerifier {
  return {
    verify: ({ signature }) => signature === null,
  };
}

export type ArtifactChecksumOutcome = "match" | "mismatch";

/**
 * PURE — compare a computed digest against the trusted manifest digest. Case- and
 * whitespace-insensitive on the hex, constant-shape (both normalized before the
 * compare). The caller computes `computedSha256` from the exact bytes it wrote.
 */
export function verifyArtifactChecksum(
  computedSha256: string,
  expectedSha256: string,
): ArtifactChecksumOutcome {
  const computed = computedSha256.trim().toLowerCase();
  const expected = expectedSha256.trim().toLowerCase();
  return computed.length > 0 && computed === expected ? "match" : "mismatch";
}
