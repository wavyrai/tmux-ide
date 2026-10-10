# Per-connection terminal delivery address

Raw tmux names containing spaces/Unicode were used as schema-constrained public workspace addresses before the socket could translate them. Admission succeeded but stream validation failed. The delivery hub now captures the trusted validated public address per connection before allocating a subscriber. Native session identity stays exact; ACK/NACK use the same immutable address.

The identical long-session source smoke failed before the change and passed afterward. Packaged Node/browser with a source-built isolated daemon also passed, as did the ordinary-name source route. These tests require actual frame delivery and input readiness, preserve the exact trailing-space native name, and clean up their private fixtures. They do not qualify native GUI typed input or a published release.

162 focused daemon tests passed, daemon typechecks and scoped lint/format passed. Independent reviewer approved all six source/test hashes in the freeze manifest and the smoke fixture.


Native follow-up: the separately identified Navigation Trace QA app (unchanged native/Node/live bytes; metadata-only browser relay) opened the exact long-label session, automatically selected its pane with active presence revision 2, rendered frames and accepted `echo WINDOW_ONE_OK`, then tab selection plus `echo WINDOW_TWO_OK`. The fixture verified both exact source outputs and no crossed targets. Screenshot and redacted metadata trace are included. No narrow-size checkpoint was written: CUA drag gestures left the screenshot at 2002×1300 pixels. Operator closed QA normally; the fixture correctly exits1 with App closed before narrow observation and runs isolated cleanup. This is positive native stream/input/routing evidence, not full narrow-layout or source-survives-close qualification. The user's three demo controllers were untouched.

Full bridge gate: 263 passed, 0 failed, 5 optional-app skips.


A fresh narrow retry before activation also left the native window at2002×1300 screenshot pixels. No session was opened and no marker/checkpoint was sent in this retry. Cmd-Q closed only QA; the owned fixture exited1 before input proof and completed its cleanup path. This narrows the automation limitation: activation order alone did not make edge dragging resize. It does not establish a product resizing defect or qualify narrow layout.
