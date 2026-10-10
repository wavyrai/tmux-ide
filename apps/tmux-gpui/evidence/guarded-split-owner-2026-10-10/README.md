# Guarded split execution and final authorization

Internal daemon runner now composes the split adapter with strict same-connection
identity, native wrapper acknowledgement, epoch/session/pane lifetime guards and
mandatory exact-session membership. Both capability probe and mutation use the
strict wrapper, preventing ordinary command aliases from rewriting their bodies.
The capability probe gets a separate operation UUID. The effect uses the caller's
operation UUID and validates its split receipt independently of the wrapper ACK.
No native journal completion record is fabricated.

The runner snapshots identities, path and authorizer before awaiting capability.
It requires the same live observer and epoch, all required native guards and final
authorization immediately before the synchronous pinned dispatch. Retirement
before effect is a refusal. A thrown command, malformed identity/ack or invalid
receipt after dispatch remains uncertain with no retry or stock fallback.
The caller must provide a bounded synchronous raw pinned runner and a callback
which actually revalidates semantic lifetimes, generation and exact geometry
lease. Raw identities are internal daemon input, not a renderer contract.

The semantic executor now forwards that final authorization closure as the fifth
execute argument for every intent, preserving existing initial checks. It rechecks
captured interaction context when present and the original authorizer. Disposal
or completion/failure of execute retires the closure. Resize gets no fabricated
journal context. Existing owners do not yet consume this argument for a new split
verb; admission and public routing are still required.

Validation on the exact source hashes in source-identity.json:

- Six focused files, 72 tests pass: guarded runner, existing wrapper command/reply,
  split adapter, executor and final authorization controls.
- Daemon typecheck, ESLint and formatting pass.
- Real native prototype6a3aae46: eight-pane ancestor move, stale refusal, native
  clamp/repeat and authority revoked after capability all pass. The revocation
  dispatches no mutation; pane birth/PID identities stay unchanged. Private socket
  and HOME cleanup true. This fixture invokes internal code, not a product daemon.
- Independent review approved runnerd9a5d55c and executorb89e66b7/test3604c255.
  Full hashes recorded. Reviewer found the missing disposal check in the new
  closure; fixed before commit with new lifecycle controls. No failing-before
  lifecycle run was captured, so this is not a reproduced released defect claim.
- Earlier failed test runs are preserved: adding a fifth callback required updating
  an existing call-shape assertion; the new read fixture also needed its normal
  observation completion signal. The final results use the repaired fixtures.

Commands: `pnpm exec vitest run` with the six source paths represented in the
combined test log, daemon `pnpm exec tsc --noEmit`, focused `pnpm exec eslint`,
and `node --import tsx native/tmux/tests/split-guarded-runner.mjs
/private/tmp/tmux-split-membership-ccxveo/source/tmux`.

Still required: authenticated semantic layout/split resource, canonical owner
and transport geometry-lease admission, operation deduplication/result mapping,
GUI divider integration and canonical publication/physical verification. Native
provenance remains unchanged. No merge, release, production or demo modification.
