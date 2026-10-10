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
