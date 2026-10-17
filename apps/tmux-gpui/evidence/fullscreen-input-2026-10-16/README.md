# Pane targeting after unresolved clicks

The earlier full-screen native run put a marker in the previous pane. Its precise cause is still unproven. A fresh instrumented native run on source 656f128b passed entering full screen, selecting both split panes and typing distinct markers, then opening a second session and closing the app. Recorded click coordinates, geometry, painted-frame match and target identity were correct. See native-diagnostic.log. No terminal input contents were instrumented; harness test markers are synthetic.

A separate deterministic runtime regression confirms an input safety defect: while pane A is ready, a click intended for B with an unpainted current frame or unavailable input geometry returns silently. Text and Enter still target A. Both tests failed before the fix with the actual unexpected target pane-a; see regression-before.log.

Narrow fix: interrupt terminal input on those two early-return branches. The existing gate blocks typing/paste until a subsequent verified ready click, without replay. Other click branches and daemon contracts are unchanged. Independent review found no source blocker. This closes the proven rejection gap; it is not proof that the earlier full-screen failure had this cause.

Temporary diagnostic instrumentation has been removed from source. Full checks and new native candidate qualification are recorded after completion. No release readiness claim.

## Latest validation

Local full-check.sh exited 0: formatting, file size, Clippy all-features and no-default-features, workspace default and all-features tests. GPUI suites: 2,791 passed / 7 ignored and 2,822 passed / 8 ignored. See full-check.log.

The first uninstrumented run expired before markers were entered after the QA window lost activation; see native-uninstrumented-incomplete.log. This is incomplete GUI verification, not a passing proof or established product regression. Fresh native acceptance remains pending.
