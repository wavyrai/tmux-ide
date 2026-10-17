# tmux 3.8 capture and split compatibility — 2026-10-17

Stock tmux 3.8 accepts capture-pane -R but emits a G/L/C textual grid dump rather than the bundled extension JSON. The daemon previously treated this as malformed native capture and closed the stream with 1011. Recognize the stock grid and first-row headers as unsupported extension capability, using the existing atomic stock fallback. Arbitrary malformed JSON remains an error.

Real stock 3.8 splitting then exposed a second failure: PaneStreamOperationError(topology-changed) became a generic fatal runtime diagnostic, preventing verified same-pane recovery. Classify only that typed error as recoverable and use existing authority refresh; do not replay the split or input.

## Evidence

- Before: native capture regressions failed; maintained recovery harness observed 1011. The topology diagnostic regression also failed before implementation.
- After: 212 daemon capture/channel tests passed; 10 focused bridge tests passed.
- Full bridge typecheck and tests: 555 passed, 5 skipped, zero failures.
- Real stock 3.8: same-browser/same-pane automatic recovery and restored input passed. Horizontal and vertical splits passed, with original selection retained and duplicate/stale requests refused.
- Bundled patched tmux control: recovery and split journeys passed.
- Independent review: np01_review found no blockers in either fix.

The real tmux was built from the official 3.8 release source into .tasks/tmux38-compat. Harnesses used private HOME, daemons, sockets and sessions with cleanup. No production server or settings were changed.

## Remaining release gates

These are source bridge journeys, not native GUI or real SSH acceptance. Full terminal release qualification, native packaging/signing/notarization, packaged GUI verification and publication remain outstanding. This evidence does not claim release readiness. User confirmed bundled tmux works on their other Mac; reported failure was stock 3.8.
