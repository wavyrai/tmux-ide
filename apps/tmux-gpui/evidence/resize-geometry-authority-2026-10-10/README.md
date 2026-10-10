# Per-operation resize geometry authority

Existing transport pane-resize semantic intents now capture geometry authority for
each operation, rather than reuse cached input-only execution handles. Authorization
rechecks the exact lease, latest same-host geometry transport, consumer/client/kind,
shared-window refusal and disposal. Explicit transports must already own geometry;
legacy transports retain implicit acquisition at admission. Viewport fitting reuses
the same runtime exact-lease assertion without adding a claim to the assertion itself.

Independent review found synchronous admission failures could escape the pane-stream
socket handler. Preserved before log reproduces that failure (1 failed / 57 passed).
An async IIFE starts submission immediately while routing synchronous exceptions to
the existing rejected-ACK path. The same socket regression now passes and verifies
that the socket stays open; following input checks still pass.

Validation: 125 tests across registry, transport and socket suites passed; daemon
TypeScript noEmit, affected ESLint and formatting passed. Independent review approved.
Tests cover revocation during asynchronous execution preparation, replacement by a
same-host transport, close, legacy release, wrong client/authority, native yield,
shared-window refusal and disposal. One initial test-harness run timed out because
its deliberately held execution promise was not rejected during teardown; teardown
was corrected before the recorded passing run.

Limit: the executor's final authorization callback is verified by the fixture. The
current legacy native dispatch does not necessarily call it at the actual effect;
guarded native split-command integration must consume it. This is not proof of
end-to-end authoritative dragging or release qualification. User demo unchanged.
