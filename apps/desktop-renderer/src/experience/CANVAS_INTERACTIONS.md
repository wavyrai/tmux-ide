# Native canvas interactions

The desktop canvas is implemented directly in Solid. `AppWindowDocumentV1`
remains the authority for window identity, focus order, and durable geometry;
tmux only supplies terminal bytes. The viewport transform is deliberately a
renderer-local value in this phase because the current AppWindow contract has
no versioned viewport field. Persisting it requires a future contract revision
and migration rather than browser storage or an unversioned side channel.

Ordinary terminal pointer and wheel input always stays terminal-owned. Holding
Space enables panning from the blank canvas, window chrome, or non-input window
content, but deliberately does not override a terminal surface or an
interactive header control.

Pane chrome exposes dock/float and floating maximize/restore only when the host
provides a durable AppWindow mutation callback. Close stays explicitly disabled
because the AppWindow command contract has no close operation. Persisting the
viewport requires one reviewed change spanning an AppWindow V2 migration, a
viewport command, and the daemon/Electron host mutation bridge; it must not be
approximated with renderer storage.

Interaction behavior was informed by the MIT-licensed Solid Flow and XYFlow
projects, especially their separation of viewport state from node state. No
Solid Flow or XYFlow source code, runtime, or package is included here.
