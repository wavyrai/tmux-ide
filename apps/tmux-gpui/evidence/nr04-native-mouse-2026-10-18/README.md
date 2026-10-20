# NR04 — GPUI application mouse routing

This increment adds a semantic application-mouse path to GPUI. The original reference in `../nr04-mouse-reporting-2026-10-18` passed through plain stock tmux 3.8 and the compiled TUI, while GPUI had no click/drag/release route. This is local implementation and bounded verification, not a release or physical GUI acceptance claim.

## Ownership and routing

The native view projects the selected snapshot's mouse modes for display routing. It uses the existing validated `copyRegion` for content coordinates, excluding tmux status/header cells. Shift retains local selection; links, dividers and dialogs keep precedence. A gesture is tied to its original pane, request, content geometry, mode and presence. The view cancels rather than replaying after those change.

The bridge accepts strict semantic mouse commands and independently checks current canonical modes, dimensions and input authority. It uses the shared terminal mouse encoder. A bridge-owned gesture ID admits a press before drag/release, retires on cancellation or attachment changes, and rejects old events. Ordinary content updates do not retire valid gestures. Failed encoding cannot leave a press active; X10 release retires without emitting an unsupported report.

## Runtime evidence

The private raw receiver uses stock tmux 3.8 and the genuinely installed CLI/daemon 2.9.7 artifact. No production process or setting is used. The final bridge test sends commands derived from published `copyRegion`, not raw escape strings. Its exact 22-byte result matches the reference press/release plus disable/fresh-input markers. A second 32-byte sequence adds one valid press that is cancelled; unmatched releases, stale requests, wrong panes, cancelled releases and reporting-disabled clicks add no bytes. Both runs retain final source markers, original pane identity/geometry, unchanged protected artifacts and complete owned-process cleanup.

The baseline semantic command delivered no bytes before integration. The first implementation also rejected commands because the full pane region included a header row (41 rows versus 40 content rows). Diagnostic metadata proved the mismatch. Both the fixture and proposed native path incorrectly used that region; both now use the existing content rectangle. Passing raw-source-coordinate trials are retained as intermediate evidence, not substituted for the advertised-coordinate final runs.

Final runtime source hashes were identical before and after both runs. Earlier attempts, diagnostics and cleanup receipts remain under `runtime/`. A missing-module test-first failure and native compilation/fixture failures are retained separately; they are not presented as customer runtime defects.

## Checks

The related TypeScript gate passed 32 tests across mouse, wheel, history, input, window presentation and canvas. The final focused native `tmux_snapshot` gate passed 420 tests with one ignored (publication-trace replay requires a separate isolated trace fixture). The interruption diagnostic records Down, Cancel, then an independent Resize command; no late Up is emitted. Earlier fixture failures are retained rather than counted as product failures. Final lint and format receipts accompany the passing test logs.

## Independent review

The final source review found no remaining blockers, contingent on current checks. It verified that only an already-admitted unchanged gesture continues across content repaint; new presses and hover still require a painted frame. Non-left releases cannot finish a left-button divider drag. Content rectangles must be contained within the selected pane. Physical native pointer acceptance remains separate.

## Remaining acceptance

Physical native pointer tests are still required: current-build clicks, dragging and hover in mouse-aware apps; Shift selection; pane/header/divider distinction; focus, modal, resize and tab-change cancellation. Native tests and bridge receiver checks do not replace those checks. Broader protocols, workload combinations, SSH, bundled tmux and platform qualification remain within NR04. The mission and application-mouse follow-up card remain open. Nothing is signed, merged or published by this increment.

Raw captured terminal frames retain cell-padding spaces and blank rows. Full evidence whitespace checks therefore report trailing whitespace; product-source diff checks pass. These raw frames are intentionally not reformatted.
