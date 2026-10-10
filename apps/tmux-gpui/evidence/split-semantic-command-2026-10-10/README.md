# Authenticated split-resize semantic command — 10 October 2026

This increment adds `workspace.window.split.resize` to the existing semantic
intent lane. It uses canonical opaque window/layout/split handles, explicit
geometry authorization rechecked after asynchronous preparation, the existing
serialized operation-ID executor, and the guarded native split runner.
Both daemon owner adapters use the same implementation. Generic action/backend,
input-only execution and automation paths cannot authorize the operation.

Successful structural receipts echo the requested target and report the actual
boundary (which may clamp). A native uncertain result surfaces as
`mutation_unverified` with fixed safe wording. Repeating an operation ID within
the existing process-local retention does not dispatch again. This is not a
claim of durable exactly-once execution across daemon restarts.

## Verification

- Five focused daemon files: 101 tests pass (adapter, geometry ownership,
  executor ordering/deduplication, transport ACK and existing socket regressions).
- Split contract tests: 6 pass; interaction-receipt regression tests: see `contracts-receipts.log`.
- Daemon and contracts TypeScript checks pass.
- ESLint and Prettier pass for all 18 changed source/test files.
- Independent read-only review approved the geometry, routing, contracts and
  uncertainty mapping. Source hashes are in `source-sha256.json`.

## Remaining scope

This is branch-only work. The new verb has not yet been exercised through a
real owner/observer/transport/native-binary integration fixture, wired into the
GPUI drag controller, promoted into bundled tmux provenance, or packaged.
The live demo still uses the previous resize path. Physical drag/DPI/font and
multi-viewer qualification remain open. No merge, release, performance or full
GP05 completion claim is made.
