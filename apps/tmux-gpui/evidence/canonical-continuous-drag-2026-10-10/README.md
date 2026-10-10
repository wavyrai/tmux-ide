# Canonical continuous divider integration — 10 October 2026

The split gesture owner holds one pending mutation and the latest pointer
boundary. Continuation requires the operation's exact full canonical successor,
a coherent frame and current geometry ownership. Cancelled or refused begins
receive an explicit terminal acknowledgement; late completions cannot overwrite
a newer gesture. Window identity compares fields rather than JSON key order.

The source browser/live helpers now route canonical gestures, retain the scoped
HTTP client until helper shutdown, and gate split metadata against composed
canvas regions. Rust uses daemon-provided split spans for hit testing and emits
absolute boundaries; active canonical gestures never fall back to pane resizing.
New drags may still use the existing conservative path when metadata is absent.

Verification: 41 bridge tests, 15 Rust divider tests, and all 122 tmux_snapshot
library tests pass. Bridge TypeScript/lint and independent source review pass.
The isolated source smoke exercises real HTTP issue + WebSocket redemption,
daemon/observer and patched tmux: native width moves before release, then a
second movement/release settles boundary 49 with pane identities unchanged.
Cleanup passes. Binary/source hashes and logs are retained.

Initial failures: fixture host configuration included unsupported extra fields;
then live begin was refused because equal window identities had different JSON
key ordering. Fixed at the gesture owner and covered by a regression. Rust test
compilation also caught a denied unnecessary qualification; corrected. The first
bin-target Cargo run had zero tests and is not counted as testing evidence.

Commit scope is the three new gesture owner/test/smoke files and evidence.
The broader preexisting untracked live/browser/Rust preview files remain in the
working tree, with exact checked hashes recorded. No claim that this checkpoint
alone forms a self-contained packaged preview. Native physical drag, refreshed
app package and full preview release acceptance remain. User demo untouched.
