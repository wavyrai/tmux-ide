# Signing producer implementation checkpoint

Adds an explicit local signing/notarization producer using an existing Developer ID
identity and notarytool keychain profile. Source app stays untouched; output is a
new private directory. Nested native/Node signing precedes outer bundle signing;
notary Accepted and staple validation precede real policy verification and archive
packaging. Historical build/assembly receipts stay unchanged; external receipt
binds their hashes, source inventory, before/after executable hashes, Node
entitlements and archive hash. No credentials imported or signing tools executed
against the real preview in this implementation slice.

Independent review found a dropped verifier timeout option. The final implementation
preserves that verifier's per-call timeout, pins validated options before awaits,
and rejects non-string trusted policy values before staging. Final focused tests:
10 passed; lint and formatting pass. Full bridge gate: types plus 239 passed,
zero failures, five explicit optional artifact skips. Injected tools establish
control flow and failure handling, not Apple signing acceptance.

Reviewed source SHA256: 92eb828429e0199a2e158e5f215cc58fd31c03333b68d3da88e54ab4cbb4f891.
Test SHA256: d662355bd3bda43891a65c301f480e06bad69acbaa2ad28592f1b3c053deabf6.

Read-only host inventory still reports zero valid code-signing identities and no
repository secret names. Positive Developer ID/notarization, final archive
round-trip, signed launch/install, clean-machine tests and publication remain
open. SIGNING.md documents the exact command and limits. The existing user's
isolated demo remains running; no production sessions touched.

## Mandatory archive roundtrip follow-up

Independent review approved source 05555a5daa2305f81f400a7f21ed1131363d221bdf633f44fb53c2b896d19b8f and tests b36d332085f15168f2f7750e5671a798aa252ef152064c6ed6f83a495ab6458e. The producer now invokes the actual installer extractor on its generated archive, compares all normalized paths/modes/content hashes, and independently applies Apple policy verification to the extracted app before finalizing. Ephemeral authentication exists only in memory to enter the production extraction boundary; it is not public release authentication.

Twelve focused tests pass with the actual Python packager and production extractor (Apple tools mocked), including altered content and second-verification denial. Full bridge gate241passed/0failed/5optional artifact skips; types/lint/format/diff checks pass. npm boundary check passes3886files/4329480bytes, no native preview leakage. Neither check rebuilds or qualifies the production CLI binary.

The extractor has its own120s cancellation budget; the signing wrapper tool-admission deadline is not a hard overall filesystem wall-clock bound. Actual Apple signing, final signed archive validation and clean-machine installed launch remain unproven.
