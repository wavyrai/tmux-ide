# NR02: layout supersession must not exhaust snapshot failure attempts

Base: 1cae0ca8479ef0641e752fc3a93f142f12962bef. Local macOS arm64, Node 24.21.0, stock tmux 3.8. No production servers or settings changed.

## Reproduction and mechanism

The isolated browser-smoke journey failed during its twenty-resize burst. Buffered bridge traces showed a valid session-restarted tombstone, a null canonical snapshot, and subsequent resize requests skipped because no snapshot remained. Runtime observability reported terminal-mirror-flow-nonconverged, attempts-exhausted, approximately 95 ms into recovery. The upstream fault retired the replica owner. Retry stack instrumentation mapped layout-change notifications to SessionChannel.retrySnapshot. Legitimate cancellation of obsolete captures was consuming the same four-attempt budget as malformed captures.

The new twenty-supersession regression failed before the fix with native-recovery-failed. It now commits one current seed without a fault. A second regression interleaves three malformed captures, repeated notifications for one obsolete capture, and a final malformed capture: genuine failure accounting still exhausts correctly.

## Change and verification

Each started capture marks its lease as charged. Parsed layout supersession refunds only that active lease once. Earlier failures, absolute deadline, ownership checks and collector retirement fences remain intact. Temporary tracing was removed before verification.

- Relevant Vitest invocation: 507 tests passed across three projects.
- Six consecutive stock tmux 3.8 browser-smoke journeys passed, including resize burst, background/foreground restoration and subsequent resize/input checks.
- Daemon tsc --noEmit, changed-file ESLint and Prettier checks passed.
- Independent read-only review found no blocker.

Local raw evidence is retained in .tasks/nr02-recovery: regression-before.log, regression-full.log, browser-fixed-{1..6}.log, owner-1-daemon.jsonl, tombstone-3.jsonl, retry-{1..5}.jsonl and all-diagnostics.patch. These traces contain diagnostic metadata rather than production terminal payloads.

## Limits

This verifies the isolated bridge journey, not physical GPUI input or Linux qualification. The earlier foreground-only timeout may have a separate mechanism and remains open until broader same-path checks pass. NR02 and the release gate remain open. No published artifact is changed by this source increment.
