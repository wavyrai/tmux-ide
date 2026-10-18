# Quiet ready-state footer and persistent Developer mode

Bounded NR05/NR06 implementation slice, based on 0fbaef5b.

Normal mode removes only the known ready guidance footer when bridge input authority is ready. The duplicate selected-pane title is shown only in Developer mode. Selection guidance, interrupted input, unknown statuses and errors remain visible. The zero-height relative wrapper stays in the layout to anchor pane-action popovers. No terminal authority decision is changed.

F5 offers Enable/Disable Developer mode. The preference is off by default and saved independently of Herdr settings in the tmux-ide native config directory. Reads are bounded and schema/version checked; writes use atomic replacement. Work happens off the UI thread. The mode changes only after a successful save; failure retains the previous setting and shows feedback. The command is unavailable while loading/saving. It does not reconnect or send terminal commands.

Tests cover routine/error visibility, regained terminal height, developer footer restoration, no terminal text/navigation side effects, persistence both directions, malformed/missing/oversized settings and failed-save preservation. Raw check output lives in .tasks/nr05-quiet-status.

## Verification

`cargo test --locked -p herdr-gpui tmux_snapshot::`: **393 passed, 0 failed, 1 ignored** (2,422 filtered). Formatting and diff checks passed. Package clippy and workspace clippy with all features and with default features disabled passed; the dependency `block 0.1.6` emitted a future-compatibility notice. Full default workspace tests passed (3,073 passed, 11 ignored); all-feature workspace tests passed (3,107 passed, 18 ignored). Both had zero failures. These are aggregate counts across workspace suites, not unique tests. The `just ci` commands were run directly because `just` is unavailable. Independent source review covered persistence, failure preservation and presentation-only ownership. The initial new geometry test incorrectly counted fixture startup commands; its receiver is now drained before exercising the toggle. Failed and passing logs remain under `.tasks/nr05-quiet-status/`. Native checks are pending because UI control reported the Mac locked.

## Acceptance still open

This is not complete NR05/NR06 or release acceptance. Contextual plain-language error actions, bounded redacted diagnostic export, versions/details, retained disconnected content and brief-transition presentation are subsequent slices. Actual native light/dark/narrow-window, keyboard and pane-action popup checks remain required. Unit/GPUI test harness results are not physical GUI evidence.
