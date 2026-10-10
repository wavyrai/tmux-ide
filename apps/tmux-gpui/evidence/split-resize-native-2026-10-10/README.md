# Native split-level resize prototype — 2026-10-10

Uncommitted branch work on codex/tmux-gpui-bootstrap, base fc3b7869c3cd1699fe5c82fcdab09aae18f5141f. Additive patch is intentionally not enabled in native provenance or any shipped/runtime bundle. User demo and production sessions were untouched.

The prototype command targets an explicit leading child path inside the canonical tmux layout. It compares the exact full layout synchronously before invoking the same layout_resize_layout operation used by native mouse dragging, then returns actual boundary and layout. It refuses zoom, floating windows, stale layouts, malformed targets and unsupported bounds. Runtime IDs and layout comparison are not authentication or lifetime credentials.

## Runtime evidence

Final normal binary713991dc7d0cd85ea61376883caae8d915da3cede6ed80fba408ee6b85685395: fixture exit0,4cases,cleanup true. Tested eight-leaf no-descendant tree and five-pane non-origin middle subtree, both orientations; actual intended boundary moved, pane birth IDs/PIDs stayed stable. Also deeper split targeting with unchanged ancestor, direction and saturation at both extremes, repeated/reverse requests, malformed/stale structural targets and refusal without unzooming.

Review found unchecked post-mutation serialization failure possible because tmux layout_dump uses8192bytes. Before mutation the corrected command computes a conservative serialization bound21\*nodes+sum(actual pane-ID decimal digits)+5 and rejects any tree that could exceed8192. Independent reviewer verified the formula and frozen patch67584709/fixturee5872f66. The400pane test uses399empty panes and one shell process; its actual layout5945bytes fits, but conservative admission refuses unchanged. This proves budget enforcement, NOT an observed actual serializer overflow. Old binary fails that new admission test with unexpected success. Earlier new-window-empty fixture setup failures are preserved separately; empty new-window exited, repaired fixture uses one sleep anchor plus split-window -E.

ASan+UBSan binary6c38fa0ac965a7036461ea32f42d0fba83799639874ceba381e9e248c2e5b924: same expanded fixture exit0,cleanup true, no reports at explicit sanitizer log paths. Sanitized identity receipt records pinned archive,patches,flags and hashes. Leak detection disabled on macOS; dependencies not sanitized, local Homebrew linkage not hermetic. This qualifies only this bounded path, not all native tmux behavior or platforms.

## Remaining integration

Add authenticated opt-in layout read resource and scoped daemon split mutation, positively probe actual server capability, enforce geometry authority and generation/session/window/pane lifetimes and topology fences at mutation owner. Feed authoritative canonical readback into native divider gestures. Keep strict existing v2 frames and legacy pane-resize semantics unchanged. Then rebuild and verify real GPUI paths, bundled build/provenance, native regressions/platforms and distribution. GP05 remains open; no release claim.
