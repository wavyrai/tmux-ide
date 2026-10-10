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

## Packaged local preview, 2026-10-10

Release-profile build completed from source digest
`4a299edd89346c626149de528c7223432ef7eeaa2cf7df087e8ec26ff8a103e3`
at Git HEAD `68ca149636d5429b149132b52dac3bc7673eb5f3` (includes uncommitted GPUI sources).
Native binary SHA-256:
`44eecb7b421614117b8c6f82a35ece84ef8671aba7c761664a66d9f98b7f208e`.
The maintained assembly script produced `/tmp/Tmux IDE Canonical Resize.app`.
All five local-app and compatibility-process tests passed; none skipped.
See `preview-assembly.json` and `packaged-app-tests.txt`. This is a local,
nonhermetic, unsigned/unnotarized development build, not distribution qualification.

Native UI inspection opened the isolated session and its Side by side window;
both LEFT and RIGHT terminal shells and scrollback visibly rendered. The Stacked
window is also available. The demo is reserved for the user: no physical drag
pass is claimed. Prior demo controller was stopped at the user's request, with
no prior preview processes remaining. Production sessions were not used.

Shipping gaps remain: split patch is absent from native provenance; native
observation remains opt-in; split handle issuance needs an exact-server capability
check before it may advertise the new operation. GP05 remains open.
