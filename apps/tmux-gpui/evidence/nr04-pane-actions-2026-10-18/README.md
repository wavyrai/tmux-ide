# NR04 matched pane actions — 2026-10-18

At source HEADe5b85427, three isolated stock tmux3.8 lanes pass split right → zoom original → restore → close new pane → fresh input on original. Source window132×41 and top headers are matched; initial content132×40 splits into66×40/65×40, original zoom expands to132×40, restore returns exact split geometry, and closing only the new pane restores initial geometry. Root independently compared all five shape stages across final receipts. Each lane asserts original physical ID/PID continuity and observes the newly closed PID exit.

## Actual paths

- Plain reference uses explicit private tmux commands; it does not test UI confirmation.
- Actual source OpenTUI uses F5 palette actions, real terminal mouse selection and rendered readiness. First Close activation displays confirmation and leaves both panes alive; second activation closes only the selected new pane. Fresh TUI input reaches original.
- Source GPUI bridge uses supported pane-action messages with offered tokens and explicit pane selection followed by native-equivalent viewport resize. Published grid markers and exact source output verify input. Native confirmation UI and physical pointer/paint are not exercised.

Daemon lanes use genuine installed CLI2.9.7 SHA7e7a6945cc350da7f41e6ab6b124ad6d94f3a487106b1a2658cc5789c01f740c. Current clients are source, not installed full applications. Original zoom geometry is asserted explicitly, not just the window zoom flag. Plain/TUI/GPUI verify3/6/5 captured owned PIDs exit, protected CLI unchanged and no cleanup errors. Stock3.8 lacks native pane birth identity; PID continuity is not substituted for that stronger proof.

## Retained failed attempts and UX follow-up

TUI first immediate Zoom attempt selected a visibly disabled command while topology was reconciling: captured palette said “Open a live session first.” application-home-agents-owner.ts returns that reason when sessionOwner is not live; application-palette-command-owner.ts refuses dispatch when disabled. This is not evidence of a lost dispatched action. Final test requires rendered two-pane readiness and absence of disabled reasons before activation; an intermediate sleep-based pass is preserved but is not acceptance. The transient wording is misleading and remains an NR05 UX follow-up; fast action availability has not been qualified.

GPUI fixture corrections are preserved: split preserves original selection instead of auto-selecting new; a new viewer needs native-equivalent viewport sizing; right-pane text shares a composed grid row with left content, so exact line equality belongs to the source pane, not the full grid. Final tests send marker input through the bridge, not direct tmux. These corrections are not product fixes. All earlier and weaker-gate receipts remain distinct.

## Reproduction and scope

Per-lane READMEs and source scripts are retained. Run scripts from worktree root with recorded local toolchain/installed artifacts; they write ignored nr04-actions output. Plain uses the recorded Node executable; source clients also use --import tsx. artifact-sha256.json binds retained files. These are local qualification recipes, not portable CI jobs.

Independent review covers assertions, action ownership and bounded evidence. This is one quiet horizontal lifecycle, not all pane layouts, repeated mutation races, arbitrary terminal byte/mode fidelity, bundled tmux/SSH, native GPUI confirmation/paint, installed onboarding or performance. Those mission gates remain open. No production resources, product source, merge, signing or release changed.
