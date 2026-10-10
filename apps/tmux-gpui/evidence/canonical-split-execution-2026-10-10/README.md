# Canonical split handle to native effect

MirrorService and SessionRuntimeRegistry expose an internal retained-channel execution
seam. It parses and detaches the request before awaiting startup, requires a previously
issued opaque split handle, resolves through the channel-owned authority, and calls the
guarded native runner. The final native callback rechecks exact entry/lifetime and
canonical target before invoking mandatory caller authorization. No channel acquisition,
extra retention, fallback, raw renderer native addresses or new wire commands.

The maintained fixture `native/tmux/tests/split-canonical-runner.mjs` runs against a
real isolated prototype tmux and real control channel. It reads an opaque resource,
moves the divider to column 83 via the guarded wrapper, verifies native layout and
pane lifetimes, waits for canonical control publication to rotate the resource,
refuses the stale handle without another native command, refuses revoked admission,
and refuses a released channel. Independent cleanup attempts preserve original and
cleanup errors. `live.json` records the binary SHA and successful server cleanup.

Validation: 44 focused mirror/read/execution tests passed. Agent daemon typecheck and
affected lint/format passed. Live final fixture passed on binary SHA256
`6a3aae46a9bfbd8519c78489c35b779b1f20401046188b0ce17964105db0bb73`.
Independent review approved product seam; its cleanup finding was fixed and rerun.

Limits: the live observer capabilities come from the actual native capability reply,
not the daemon observer lifecycle. Its caller authorization is an injected assertion;
this is not full transport geometry admission. Live revocation occurs before initial
runner admission; deferred execution unit tests and earlier guarded-runner fixture
cover later boundaries separately. No HTTP/stream mutation, semantic receipt mapping,
GPUI wiring or packaged-native promotion is included yet. No release or parity claim.
