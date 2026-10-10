# Exact session-name admission — 2026-10-10

The narrow native Home Open test reproduced HTTP503 for a95-character session name ending in a space. Through the real scoped HTTP API, removing only the trailing session space made the same session open with two panes; window/pane trailing spaces were retained. Isolated daemon/fleet cleanup completed in both runs.

The canonical session opener called `records.trim()` on `list-sessions` output whose last field is the exact session name. That modified the name before computing the promotion identity. The focused regression found an additional consequence: when the trimmed-name neighbor exists, admission can return that neighbor's workspace. The old code failed the exact registered session assertion (six tests passed, one failed).

Fix removes only terminal newline record separators. No native PID/session ID/creation-time fences, admission serialization, capacity, or disposal behavior changed. Both embedded and native server owners use this opener. No wire or GPUI Rust code changed.

Seven live tests now pass, including exact selected session identity, repeated stable stamps/live ID, and no stamps on the trimmed-name neighbor. The same scoped HTTP reproduction now opens the trailing-space session and the trimmed control with two panes each. Daemon TypeScript check, focused lint/format and diff checks passed. Independent reviewer approved source SHA3c63d2b91b19d46b78c781554300a17284d3f63d6676ee6cb9e3f7aa6b55ea8f and test SHA f7dd6f200783b4c2055542a9d17400254699970a8da28e566ee93ddc2cd75584.

Native same-path rerun now opens the long-name session and lists both windows, but no pane automatically selects. This remains a separate incomplete navigation qualification; no full narrow-layout/input pass or release claim. User demos93795 and54706 remain untouched. Native artifact was reused; daemon fixture rebuilt CLI from the corrected source.

Further read-only observation of the same isolated daemon found two canonical layouts, exactly one current window, and one active pane in each window. `canonical-selection-observation.json` retains only counts/booleans from that separate packaged live-helper observation. This rules out missing canonical active flags, but it does not prove what the original native browser publication contained. Native source hashes match the packaged build receipt. Backgrounding intentionally clears pending automatic selection; a second product defect remains unproven pending a redacted command/publication trace.
