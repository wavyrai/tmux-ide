# Canonical split ancestry and opt-in resource foundation

The existing canonical channel now retains the exact unzoomed layout string
inside its staged/notification layout objects. Existing ordering rules preserve
newer ancestry when an older list-windows reply completes. The new daemon-internal
`describeSplitLayout` resolves an existing window-link target and checks attached
session/window identity, semantic pane mapping and positive native birth IDs.
Disposed/degraded/zoomed/pending/incomplete observations refuse. Native addresses
remain internal; existing layout frames and stream schemas are unchanged.

Standalone strict contracts describe semantic pane rectangles, opaque layout and
split UUIDs, window-link target, dimensions and boundary axis/extent. Unknown raw
fields, duplicate identities and out-of-root geometry are rejected. Resize target
endpoints permit native clamping. These schemas do not themselves grant access or
register any resource route or semantic mutation verb.

WindowSplitAuthority projects every native ancestor boundary rather than guessing
from leaf geometry. It retains at most32windows, returns detached resources and
rechecks the complete canonical snapshot, epoch and window link on resolution.
Geometry/native session/window/pane birth/semantic changes invalidate handles.
Forged IDs do not evict another viewer's valid handle; cache eviction/disposal
retires old resources. Native4096grid/256publicpane and8192conservative serializer
admission bounds apply. A valid256pane serialized layout under8192bytes is refused
when its conservative511node budget exceeds the native bound.

Validation:215daemon tests across canonical channel, new canonical getter, layout
parser and opaque authority;5contract tests. Daemon/contracts typechecks, lint and
formatting pass. Simulated-control tests exercise stage/notification ordering,
pending geometry, zoom/malformed ancestry, missing births and replacement
membership. Nested8pane projection resolves the root split and deeper child paths
without exposing them publicly. These are source/unit/control-simulator results,
not an authenticated HTTP or GPUI integration claim. Independent reviewer approved
all source and final budget control (full hashes in source-identity.json).

Only the new contracts index export is staged in this increment. The preexisting
visual palette export and other user/GPUI changes remain untouched.

Next: instantiate the bounded authority under canonical owner lifetime, expose an
authenticated opt-in read route, admit the split mutation with exact per-operation
geometry authority, pass final authorization into the guarded native runner, and
connect the GPUI to result/canonical-layout settlement. No new split capability
is activated in native provenance, running daemon or user demo; no merge/release.
