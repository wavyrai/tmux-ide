# Experimental split-level resize prototype

This additive patch is **not included in native provenance, build manifests or
release artifacts**. Apply it after the three existing patches to tmux commit
`e476c1230b958df0cb12977517d24b3dc931375b`. It adds a command without changing stock
commands. It is not a qualified native extension or daemon capability yet.

```text
tmux-ide-resize-split -V
tmux-ide-resize-split -s $SESSION_ID -t @WINDOW -E FULL_LAYOUT -p 0.1 -a cols -c BORDER
```

`-V` is exclusive and returns schemaVersion 1, capability `split-resize-v1`, and
`sessionMembership: "exact-session-link-v1"` plus maxDepth/maxLeaves/maxGrid. Mutation requires each flag exactly once, no
positional arguments. `-s` accepts only an explicit numeric session ID (`$N`);
the window must currently be linked into that exact session. A link elsewhere
is insufficient. This is an existence check; daemon owners separately enforce
any exclusive-window policy. Old capabilities without the sessionMembership
field are unsupported by the adapter. `-t` accepts only an explicit numeric window ID. `-p` is a
zero-based child-index path from the tiled layout root, selecting the **leading
child** of the desired boundary. It must have a next sibling; its parent's axis
must match `cols` or `rows`. `-c` is an absolute window-cell border coordinate,
not a pane content width or height. Decimal values are canonical unsigned
integers without whitespace, signs or leading zeroes (except zero itself).

Before mutation, the command resolves `session_find_by_id` and checks
`winlink_find_by_window` synchronously, then rejects zoom and any floating pane in the window,
checks bounded native tree traversal, and compares `layout_dump` byte-for-byte
with `-E`. The comparison, path resolution and mutation run synchronously in
one command execution, with no asynchronous shell, queue continuation or yield
between them. A stale layout fails without changing the window.

The mutation reuses `layout_resize_layout(window, leadingChild, axis, delta, 0)`:
exactly the operation used by native tmux mouse resizing in `cmd-resize-pane.c`.
Native recursive minimum sizes and sibling redistribution apply. The returned
JSON contains `schemaVersion: 1`, the **actual** `boundary`, and resulting
`layout`; the requested boundary can clamp. There is no optimistic geometry,
leaf-target heuristic, pane remapping, or generated `select-layout` replacement.
A zero delta succeeds without a size change (native notifications may still run).

Limits: layout argument 64 KiB, path 256 bytes, tree depth 64 including root,
512 leaves, 1023 nodes, and coordinates/extents within a 4096-by-4096 grid. These
are internal prototype limits, not permission to exceed smaller daemon wire
limits. A further pre-mutation serialization budget must fit the pinned
`layout_dump` 8192-byte buffer. Geometry headers cost at most 19 bytes per node;
a leaf adds one comma plus its unchanged runtime ID's decimal digits; a split
adds two delimiters and one separator between children. Including the five-byte
checksum prefix and NUL yields `21 * nodes + sum(idDigits) + 5` bytes. Rejecting
budgets above 8192 conservatively includes even the prefix allocated separately
by tmux. Thus not every tree within the 512-leaf ceiling is admitted. Geometry
stays within 4096 and native resizing preserves IDs/tree shape, so this bound
holds after mutation too. Defensive post-dump failure reports that resizing has
already occurred; it does not substitute for the preflight bound.

Only tiled windows are supported. JSON layout text comes from tmux's
numeric/bracket layout serializer, never from an untrusted echoed argument.

## Ownership and remaining qualification

The expected layout is a geometry/membership compare-and-mutate fence, **not an
authentication or lifetime credential**. Runtime session/window/pane IDs and the tmux
layout checksum alone are insufficient across server replacement. Future daemon
integration must additionally bind its authenticated generation, exact session,
window and pane lifetimes (using the same expected session as the outer guard), geometry authority, and operation identity. Existing
journal epoch/pane/session guards provide patterns; this patch does not silently
enable the experimental journal or claim those checks are already integrated.

Capability must be positively probed with `-V` on the selected server/binary;
stock tmux or a missing/malformed capability must not fall back to an arbitrary
leaf resize. An optional native command wrapper should correlate successful
readback with canonical layout publication before settling client gestures.

The local prototype build is not hermetic and links local Homebrew libraries.
Native private-server correctness tests, sanitizer checks, regression tests,
platform builds, provenance updates and release qualification remain separate.
No GUI, user session, production daemon or installation is changed by this patch.
