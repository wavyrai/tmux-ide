# Split command composed with native lifetime guards

The maintained `native/tmux/tests/split-owned-guards.py` runs only against a
private socket and HOME. The recorded run uses native prototype SHA256
6a3aae46a9bfbd8519c78489c35b779b1f20401046188b0ce17964105db0bb73.
It exits 0 with owned cleanup true. Independent review approved fixture
2c4d202812fe073bce4f086e276b69103cc2e2728a363c6717eec833444c3621.

Four mismatched guards (server epoch, pane birth, selected session creation and
session ID) refuse before wrapper acknowledgement and leave layout unchanged.
A valid wrapper moves the boundary to 83, with a receipt matching readback.
Reusing the stale layout emits the wrapper acknowledgement but then rejects the
child command and leaves the applied layout unchanged. Acknowledgement is thus
admission evidence, not successful resize evidence.

No journal record for the successful split operation appears in this short
isolated observed run. Source inspection agrees: native command outcomes cover
send-keys, capture-pane, paste-buffer and send-prefix, not this new command.
Do not cast resize as one of those kinds or treat an empty successful-input
fallback as a valid resize receipt. No daemon/GUI integration is proven here.

## Implementation handoff

The independent ownership trace identifies these required integration points:

- Keep the serialized semantic mutation lane. Add an operation-specific exact
  geometry lease fence in transport binding; current submitIntent checks input
  controller authority only. Reuse the ownership rules of fitViewport, including
  newest same-host geometry transport. Do not cache the operation lease inside
  general execution handles.
- Forward final authorization into the owner and recheck immediately before
  dispatch after asynchronous capability/inventory reads. The executor currently
  calls authorizeBeforeEffect before awaiting execute, which cannot fence later
  asynchronous work by itself.
- Resolve semantic window/split identity through an authenticated opt-in resource.
  Keep raw native targets/layout/path daemon-owned. Wire a dedicated resize branch
  in both daemon-embed and tmux-server-owner without changing legacy pane.resize.
- Use a narrowly typed native transport with nativeOperationWrapperArgs and strict
  decodeNativeOperationInvocation acknowledgement validation. Use identical session
  IDs in outer guard and split command. Validate the split receipt independently;
  malformed post-effect replies stay uncertain with no automatic retry.
- Verify held capability/inventory reads followed by geometry revocation,
  background/disconnect, generation replacement or window unlink. No mutation may
  dispatch after authority loss. Separately verify clamping, deduplication and
  canonical layout convergence before settling the GUI gesture.

This evidence narrows the next implementation; it does not enable provenance,
runtime routes, GUI behavior, production operations or a release.
