# NR03 retained preview verification — 2026-10-18

Status: local working-tree implementation; not released. NR03 remains open.

## Trigger and ownership
The retained-tab A/B/A baseline in `../nr03-tab-continuity-2026-10-18/` observed empty bridge publications while each new attachment regained readiness. The bridge now retains bounded last-coherent snapshots by verified route incarnation and appearance. Native preview decoding grants no live authority. Preview expiry is five seconds; Home, background, route retirement and appearance changes clear presentation/cache as appropriate.

## Evidence
`bridge-pass.json`: Node 24.21, macOS ARM64, stock tmux 3.8, explicit private CLI, isolated HOME/socket/canonical daemon. A/B/A observed 19/14/14 retained publications and zero empty publications, followed by fresh live readiness. Every preview publication was checked for absence of input, pane selection, copy, regions, resize, split and pane-action authority. Withheld pane continuation verified expiry. Home cancellation verified no resurrection through the timer interval. Source pane births/processes survived; owned cleanup passed. No native UI, input or resize was exercised. Timings include polling and are not a performance benchmark.

Five focused native headless retained-preview tests passed: parsing/rejection, connection/request fencing, hostile stale input geometry/capabilities, and exact catalog continuation. Cache/fleet tests: 26 passed. Bridge TypeScript and affected ESLint checks passed. Both Rust clippy configurations and file-size check passed. Default workspace tests: 3,090 passed / 11 ignored / zero failures. All-features workspace tests: 3,124 passed / 18 ignored / zero failures. Formatting and diff checks passed.

`bridge-reviewed.json` repeats the same real path with 93 in-memory target-frame fingerprint comparisons and theme invalidation during withheld continuation. All passed; A/B/A still had zero empty publications. No hashes or terminal contents are logged.

## Review and limits
Independent review caught residual gesture publications before child retirement; preview publication now suppresses them. This isolated run does not inject old gesture metadata. Native GUI is unavailable because the Mac is locked. Scroll anchor/selection/focus restoration, rapid switching, recreated targets, remote interruptions, physical visual checks and performance acceptance remain incomplete. Cached content is stale presentation, never evidence of connection health. New bridge/native protocol fields must ship as a paired candidate.
