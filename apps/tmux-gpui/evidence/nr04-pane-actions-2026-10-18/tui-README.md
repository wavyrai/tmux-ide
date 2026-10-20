# NR04 actual TUI split, zoom, restore and confirmed close

```sh
.tasks/tmux38-release-20261018/TmuxIDE.app/Contents/Resources/node --import tsx .tasks/native-reliability-mission/nr04-actions/tui-actions.mjs > .tasks/native-reliability-mission/nr04-actions/tui-actions.stdout 2> .tasks/native-reliability-mission/nr04-actions/tui-actions.stderr
```

Current source OpenTUI, genuine installed2.9.7 canonical daemon, stock3.8; fixture-private host/source selectors. Start one original shell at source132×41 with marker. All tested operations use actual TUI: F5 filtered Split right then Enter; observe fleet2p and two rendered pane-header menus plus source41-row geometry; click original content and F5 Zoom pane then Enter; repeat to restore; click new-pane content, F5 Close pane, first Enter arms confirmation, assert two panes remain, second Enter confirms. No direct tmux mutations perform these actions. Palette captures must contain action label and neither live-session nor live-pane disabled reason.

Passing geometry: original132×40 at top1; split66/65; original zoom132; unzoom66/65; close returns original132. Original ID/PID preserved, newly split PID exits after confirmed close, exact original geometry restored, fresh TUI input produces exact standalone output line. Six observed owned processes exited during cleanup, no errors, protectedCLI unchanged. Pane_birth_id unsupported on stock3.8. Rendered captures include menus, confirmation, split/zoom/unzoom/closed and fresh input. Legacy receipt field renderedBothMarkers checks original marker only in this single-pane fixture.

First immediate zoom failure remains preserved. Mechanism verified: its actual palette showed `Open a live session first`; application-home-agents-owner.ts disabledReason returns this while sessionOwner is not live. application-palette-command-owner.ts refuses before dispatch when disabledReason is non-null. Initial harness incorrectly checked label presence only. Thus it did not demonstrate rejection/loss of a dispatched zoom request. Potential wording improvement during transient reconciliation remains separate; fast action availability is not asserted. Sleep-based calibration pass retained separately and superseded by observed rendered two-pane readiness plus disabled-footer checks, not arbitrary delay.

Close confirmation owner in application-palette-command-owner.ts requires second activation with same targetKey; fixture verifies first activation retains both panes before confirming. This is actual source-TUI qualification, not installedTUI or native physical GPUI. No performance claims.

Harness SHA256 `5bcab7e3464c7ed206c042cbd477f5b1b1bff4cfea199e5ad786e022ba825ab0`.

Final retained rerun additionally asserts exact splitshape (left0/top1/width66/height40, right67/top1/width65/height40, source132×41/unzoomed) and the zoomed original pane ID/PID/birth/geometry equals initial single pane excluding zoomflag. Previous passing receipt retained as tui-actions-before-shape-assertions-pass.json.
