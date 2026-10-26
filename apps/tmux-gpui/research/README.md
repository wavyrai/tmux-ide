# GUI research follow-ups — 2026-10-24

This batch follows the Sfora daemon-efficiency and pane-pixel-surface reports.
It builds on the direct Rust terminal path already present in 2.9.12; it is not a
claim that every recommendation in either report is complete.

## Current checkpoint — 2026-10-26

The sections below this checkpoint retain the chronological investigation. Their
earlier remaining-work lists are historical, not the current implementation status.

- Implemented: direct Rust terminal/control/catalog/discovery/SSH ownership on
  the normal native path; sparse changed-row application and cached row hashes;
  remote lossless graphics compression; authenticated macOS native-surface
  registration, transfer, import and GPU retirement. The legacy helper remains
  available only through explicit compatibility/development entries.
- Fixed and automatically tested: native Home presence publication and local
  image-reader backpressure. The latter has a confirmed failing GUI reproduction,
  passing regression/client/GUI tests, and a completed 191-second visible
  background/foreground HD-image check against the rebuilt app.
- Implemented and qualified locally: terminal-browser's complete canvas through
  the authenticated native-surface SDK, automatic launch discovery, late startup,
  process replacement, bounded retirement and Kitty fallback/recovery. This uses
  an owned CPU copy into IOSurface; it is not direct Chromium texture sharing.
- Not implemented: generic Kitty shared-memory ingestion, hardware video/adaptive
  codec selection, and the separate embedded browser/SSH-proxy feature from the
  browser report. The terminal-browser integration does not replace that roadmap.
- Qualification still outstanding: physical typing latency, congested SSH,
  long-running memory, Windows coverage, and final release packaging/publication.
  One complete visible image/history run and the Linux checks below do not
  establish performance parity or leak freedom.

## Initial implementation (historical)

- Sparse grid commits retain the cached row-sequence digest and replace only the
  contributions of changed rows. The digest and wire contracts remain unchanged.
  Dense, cold, mutable and resized grids retain the full-fold path. See
  [measurement scope and samples](daemon-hashing/README.md).
- Newly assembled macOS apps execute Rust directly. Rust owns the remaining Node
  metadata helper through pipes, removing the second Node supervisor process.
  The existing development preview launcher remains supported.

The helper spawn occurs before entering the UI loop. Dropping its owner asks a
worker to terminate and reap the exact child, with a bounded grace period before
escalation. Normal application return joins that worker after the UI has stopped.
If the native process exits abruptly, its pipe closes; the real helper's existing
EOF handler disposes its resources. Process tests cover EOF, signals, a helper
that ignores TERM, missing executables, and launch identity across install/update
pointer changes. No production daemon or pane is intentionally stopped.

The launcher continues to pin both executables and helper payload to the same
physical app bundle, and clears inherited Node loading hooks. No capability,
owner token, terminal sequence or input authority changes are involved. The
remaining broker still owns discovery, catalog actions and SSH setup: removing
its supervisor is not a migration of those responsibilities to Rust.

## Research prototype

The [shared pixel storage experiment](pixel-surfaces/README.md) successfully
passes frames between two processes and verifies them using Metal without sending
the pixel payload over their pipe. It is deliberately outside the production path.
The pinned GPUI video surface requires NV12; it does not accept this RGBA texture.

## Remaining work

- Migrate discovery/catalog/SSH ownership into Rust with the same authentication,
  route-generation and reconnect guarantees, then retire the metadata helper.
- Integrate an appropriate native pixel renderer and authenticated surface channel,
  with allocation limits, GPU retirement acknowledgments and fallback behavior.
- Compare remote lossless damage compression with hardware video using actual
  workloads before choosing a codec or applying lossy encoding to terminal text.
- Run physical input-to-paint, long-running memory, multiple-image and congested
  remote workloads against the final packaged path. Microbenchmarks and headless
  correctness tests do not establish GUI/TUI performance parity.

This branch is development work. Signing, publication, physical GUI qualification,
and Linux/Windows qualification of the new process owner are separate from the
local macOS checks. Do not advertise the research prototype as a shipped feature.

## Local validation

- Core tests: 325 passed, including sparse/full digest equivalence.
- Bridge suite: 902 passed, five opt-in cases skipped; the three packaged-app
  artifact tests were subsequently run against the assembled app and passed.
- Rust workspace: 3,489 default-feature tests and 3,523 all-feature tests passed;
  ignored counts were 11 and 18 respectively. Both Clippy configurations passed.
- Release CLI: four executable integration tests passed.
- Assembled app startup: Rust parent and exactly one Node broker observed; the
  isolated source pane was unchanged and both owned processes retired cleanly.
- Full `pnpm release:opentui:check`: passed with Node 24.22.0, Bun 1.4.2 and the
  bundled tmux, including installed-package journeys.

An earlier installed-package stress run lacked the daemon's tmux identity proof
for one election contender. The isolated retry passed election; the final full
run also passed. Initial environment failures (missing `sysctl` on PATH and an
older Bun) were corrected before the final checks. Those retries do not establish
that the election timing issue cannot recur under load.

## Native owner client — in progress

`herdr-client::tmux_daemon` now implements private daemon-record inspection,
credential-free identity verification and authenticated server-catalog reads in
Rust. The proof is not constructible from a URL or deserialized host file. Record
reads pin the parent directory and file, reject symlinks, unsafe ownership/modes,
multiple links and oversized data, and detect changes while reading. Probes and
owner reads have body/time limits, disable proxies and redirects, and reject
record replacement before accepting responses. Server registration generations
reuse the native `ServerScope` type and malformed or duplicate registrations fail.

This module is not yet wired into the GUI's broker loop. It is a foundation for
removing the remaining Node broker, not a claim that migration is complete. Next:
native session catalog, capability issuance and fenced actions, then discovery
path selection, saved machines/SSH and native browser integration.

The client test suite passed (425 unit tests, two existing integration tests and
one documentation test; opt-in tests excluded), and client all-feature Clippy
passed. `bridge/native-discovery-smoke.mjs` starts an isolated daemon and runs the
explicit opt-in Rust test against its private record. That real-daemon test passed:
Rust performed both discovery and authenticated catalog access, and the source
pane was unchanged. The new work still needs full workspace and platform gates
as it is integrated; the earlier packaged-app receipt predates this module.

## Native selected-server catalog and actions — in progress

The native owner client now selects an exact advertised online `ServerScope`,
reads incarnation-bearing sessions, and creates sessions with caller-retained
operation IDs. It never substitutes a new server generation. Retiring the
selected client is atomic and does not wait for network IO; responses are checked
again after IO and parsing, so a retired selection cannot accept delayed results.
UI application will still need its own current-selection check when these methods
are wired into the broker.

Creation sends one request, carries the server generation in the route and body,
and validates the response operation/generation and opaque session identities.
A failure after attempting the operation is conservatively reported as an
unconfirmed outcome with its operation ID; it is not automatically retried.
Session names are validated before any mutation is sent.

The current client suite passes 431 unit tests, two existing integration tests
and one documentation test. Client all-feature Clippy passes. The explicit native
smoke harness also ran both opt-in tests: discovery plus session enumeration, and
session creation/receipt verification against its own isolated daemon. It checked
that the original pane remained unchanged and cleaned up its owned resources.
A coordinated fake peer verifies that retiring a selection while a response is
held rejects that response and prevents later reads/creates. Another verifies that
an invalid creation receipt remains uncertain and only one POST was sent.

These operations are not yet the GUI's catalog path. Capability issuance,
remaining catalog/actions, saved-machine/SSH ownership and browser integration
remain part of the active migration; pixel integration and physical performance
qualification remain open as described above.

## Native admission and capability issuance — in progress

The owner client now admits an exact observed live session, reads its pane
inventory between session-incarnation checks, and issues a terminal capability.
Admission sends one request and validates the returned session and server scope;
its result is accepted only while that selection remains current. The native
issuer validates endpoint origin/path, request ID, generation, mode, exact pane
set and expiry. Local image access is derived from the verified private daemon
record, never inferred from a loopback URL. Credentials and redemption tickets
are not included in diagnostics.

The isolated daemon harness now exercises native creation, admission, inventory,
issuance and WebSocket redemption through the existing Rust stream client. It
passed with the original fixture pane unchanged. An initial run correctly exposed
that creation alone does not admit panes; the harness now follows the actual
open-session protocol before reading inventory. The client suite passes 437 unit
tests, two existing integration tests and one documentation test, with explicit
live tests run separately by the owned harness. Evidence is in
`native-capability-client-tests.log` and `native-capability-real-daemon.log` under
the local research evidence directory.

These are native client foundations, not yet the GUI catalog implementation.
Remaining browser wiring, catalog actions, SSH ownership, pixel integration and
packaged physical performance qualification are still open. No interactive
latency or parity claim follows from the protocol smoke test.

## Native catalog worker — in progress

`tmux_daemon::CatalogWorker` runs private-record discovery, server selection,
session listing/creation/admission and capability issuance off the UI thread.
It has one outstanding request, one bounded queued job and one result slot.
Cancellation invalidates queued work and delayed replies. Dropping the worker
invalidates its work without waiting for HTTP; it never retries a mutation.
An already-sent mutation may have committed, so callers must retain the operation
ID and reconcile explicitly. The worker retains the verified daemon identity;
it does not silently switch to a replacement daemon generation.

The owned-daemon creation/admission/redemption smoke test now uses this worker.
It passes with the original fixture pane unchanged. Coordinated fake peers prove
that a cancelled delayed response cannot restore the previous selection, a busy
mutation is never sent, and worker drop returns before a held HTTP response is
released. The client suite passes 439 unit tests, two existing integration tests
and one documentation test. Logs are `native-worker-tests.log` and
`native-worker-real-daemon.log` in the local evidence directory.

The worker is not yet wired into the GUI. Full workspace/platform gates and final
packaged GUI qualification remain required after browser integration.

## Typed browser transport boundary — in progress

The GUI terminal loop now consumes typed catalog, handoff and owner-response
events, and transfers owned commands to its backend callback. Pipe encoding and
JSON serialization are confined to the existing helper adapter. The native
catalog backend can therefore join this same terminal loop without cloning or
serializing commands through an internal pipe. Existing controller ownership,
input barriers, presence handling and coalesced state publication remain in the
shared loop.

A disconnected typed event source now closes the authoritative UI mailbox and
retires the active controller, even without an explicit pipe EOF event. New
coordinated transport tests exercise ordered command transfer, catalog delivery,
backend disconnect and command-send failure. The full GPUI library run passes
3,030 tests (eight opt-in tests remain ignored), including the new typed-backend
tests and existing selection/focus-loss checks. All-feature GPUI Clippy and the
workspace source-size check pass. Evidence is in
`native-transport-events-tests.log` in the local evidence directory. This boundary
alone does not remove the production helper or prove packaged GUI performance.

## Local native browser integration — in progress

The explicit development entry `--tmux-native-daemon /absolute/path/daemon.json`
connects the native catalog worker directly to the shared terminal controller
loop. It discovers online local server generations, enumerates their sessions,
admits the selected incarnation and redeems an interactive capability. Returning
Home retires that controller and reloads discovery; it never replays a mutation
across owner replacement. Backgrounding cancels pending capability issuance.
Catalog sizes and event/command queues are bounded.

This entry does not launch Node. The normal packaged launcher still uses the
helper, because native saved machines/SSH, session-history UI,
appearance persistence and remaining catalog actions are not
yet integrated. Unsupported actions in this development path retire the route
with an explicit unavailable status; they must not silently wait for a helper.
This is not the final supported release path.

The owned-daemon harness accepts an optional GPUI library-test binary and runs
`native_local_catalog_opens_owned_session_without_helper`. It checks Home session
selection, a canonical terminal frame with native input authority, and return to
Home with terminal authority cleared. This exercises the GUI engine headlessly;
it does not measure physical input, OS rendering or perceived smoothness.

The native local integration passed the owned-daemon harness, including canonical
frame delivery with input authority and Home retirement. The original fixture
pane remained unchanged. The full GPUI library run passed 3,031 tests (nine
explicit opt-in tests ignored), and all-feature GPUI Clippy passed. Evidence:
`native-local-tests.log`, `native-local-real-daemon.log`, and
`native-local-clippy.log` in the local evidence directory. Idle catalog ownership
now blocks on its command channel; only outstanding HTTP jobs poll the result
mailbox. Focused transport tests (15 passed, one explicit live test ignored), the
owned-daemon GUI-engine check, and all-feature Clippy passed again after that
scheduling change; see `native-local-idle-tests.log` and the updated daemon/Clippy
logs. This remains a development route, not a packaged release qualification.

## Native canonical split-layout reads — in progress

The native local backend now reads canonical split ancestry directly from the
scoped daemon endpoint. The client validates the complete window link, server
generation, resource geometry and response size. The existing controller retains
geometry authority and drag/commit semantics; this metadata read never acquires
a lease or performs a resize. The endpoint's existing 45-second lazy-readiness
budget runs on a separate bounded worker, so it cannot block catalog navigation.
The GUI accepts the reply only for the same terminal route and request epoch.

Explicit refresh now resets discovery on the existing workers rather than
spawning replacements while old HTTP calls finish. Cancellation is also bound to
the selected client during each job, so cancelling during an admission preflight
prevents its later POST. Coordinated peer tests cover owner-record replacement
requiring explicit reset and cancellation while session validation is held.
The owned GUI-engine test now waits for canonical split metadata as well as a
terminal frame and input authority. Validation passed after these lifecycle
changes: 443 client unit tests, two existing client integration tests, one client
documentation test, 15 focused GUI transport tests, the owned-daemon GUI check,
and all-feature client/GPUI Clippy. The normal opt-in live tests remain isolated.
Evidence is in `native-split-client-tests.log`, `native-split-gui-tests.log`,
`native-split-real-daemon.log` and `native-split-clippy.log` in the local evidence
directory. This proves metadata delivery, not physical divider dragging; the
native development entry remains separate from the normal launcher.

## Native scrollback anchor capture and restoration — in progress

History-anchor HTTP ownership now runs through the Rust catalog worker. Requests
have bounded, strict capture/resolve shapes; the native client validates the
server generation, response operation and echoed pane incarnation. The local
backend also checks the current route, workspace, live session and selected pane.
Responses return as typed Rust results to the existing restoration owner, without
a Node response envelope. Unsupported endpoints and failed reads retain the
existing history fallback behavior without retiring the terminal connection.

The isolated GUI-engine fixture now has a dedicated interactive input session.
It sends a bounded shell program through native input, waits for its canonical
output, scrolls up, returns Home, then reopens the same live session. Restoration
must recover the historical content, not merely an offset from a changing tail.
The original untouched fixture pane is still checked after the run. The first
live attempt failed before sending input because a generated display name was
not the tmux session name; the harness now passes the exact owned input-session
name explicitly. The corrected live run passed with the stronger historical-row
assertion, as did 445 client unit tests, two existing client integration tests,
one documentation test, 609 tmux GUI tests and all-feature client/GPUI Clippy.
Opt-in tests were run only against the owned harness. Evidence is in
`native-history-client-tests.log`, `native-history-gui-tests.log`,
`native-history-real-daemon.log` and `native-history-clippy.log` in the local
evidence directory. These are programmatic input and headless presentation checks,
not physical input-to-paint measurements.

## Native local Home creation — in progress

The development backend now publishes bounded local fleet metadata and opaque
server selections. Selection tokens expire with catalog refresh; creation uses
the selected advertised generation. Session creation runs once through the Rust
worker and opens the returned live identity. Cancellation after submission and
uncertain responses retain the operation UUID, disable further creation in that
backend lifetime and require inspecting the resulting sessions. There is no
automatic mutation replay. Cold daemon bootstrap and explicit reconciliation
of uncertain outcomes remain future work.

The owned GUI-engine fixture now also selects a server, creates a session and
waits for its canonical frame and input authority. This is still headless;
physical dialog interaction and packaged release qualification remain pending.

Validation passed: 612 focused tmux GUI tests (two opt-in tests ignored), the
owned-daemon end-to-end GUI-engine check including session creation, and
all-feature client/GPUI Clippy. Regression tests cover expired server selections,
cancellation before submission and retention of uncertain submitted operations
across refresh. Formatting, source-size and bridge lint checks passed. Evidence:
`native-create-gui-tests.log`, `native-create-real-daemon.log` and
`native-create-clippy.log` in the local evidence directory.

## Native editor-context reads — in progress

The Rust catalog worker now reads the scoped pane-editor-context endpoint using
its verified private daemon record. It rechecks owner identity before and after
the request and rejects cancellation before accepting the result. Responses must
match every selected server/session/pane identity, have a bounded absolute host
path, and contain a consistent absolute or contained project-relative cwd.
Directory observations are neither Debug nor Serialize and are not launch
capabilities. The native launcher and click/focus integration described below
consume fresh observations; the normal packaged helper path remains in place.

Validation: 449 client unit tests, two existing integration tests, one doctest,
and the isolated real-daemon client test passed. The latter now reads an actual
pane directory through the worker and checks that it is an existing directory;
it does not launch an editor. Tests also cover stale response identities,
malformed/oversized paths and retiring a held HTTP response. Evidence:
`native-editor-client-tests.log` and `native-editor-real-daemon.log` in the local
evidence directory. No physical UI claim follows from these tests.
All-feature client/GPUI Clippy and formatting/source-size checks also passed;
see `native-editor-clippy.log`.

## Native editor launcher — in progress

The catalog worker now exposes a native editor-open operation. On macOS it reads
fresh authenticated pane context, checks that the observed absolute path is a
directory, re-verifies the daemon, then invokes only `/usr/bin/open -b
com.microsoft.VSCode <directory>` with separate arguments and null standard IO.
There is no shell and no caller-provided executable. Cancellation and an action
deadline stop and reap the short-lived launcher; they do not terminate VS Code.
Non-macOS launches return unsupported. Filesystem inspection and HTTP remain on
the worker, not the UI thread. Blocking OS operations may finish after the nominal
action deadline, but the deadline and cancellation are checked before launching.

GUI click/presence integration follows below. Process tests use isolated
commands and do not open VS Code or establish physical GUI qualification.
Validation passed: 453 client unit tests, two existing integration tests, one
doctest and all-feature client/GPUI Clippy. New tests cover cancellation before
spawn, expiry before/after spawn, nonzero exit and cancellation reaping the owned
process. Formatting and source-size checks passed. Evidence:
`native-editor-launch-tests.log` and `native-editor-launch-clippy.log` in the local
evidence directory.

## Native GUI editor action — in progress

The development backend now routes controller-validated editor clicks to the
Rust owner worker. It checks route ID, request epoch, selected pane, generation
and foreground revision, and retains at most 128 one-use operation IDs per
terminal selection. Busy actions return a typed result. Focus loss, a new presence
revision, explicit cancellation, navigation and pane selection cancel pending
editor work. Old foreground notifications cannot revive it. Typed results return
to the existing editor owner without a Node envelope or directory publication.
The terminal stays connected when an editor action fails or is cancelled.

Unit coverage exercises replay and bound enforcement plus focus and pane-change
cancellation. Actual VS Code launch through a physical GUI click remains
unqualified; these tests never open an editor on the user's desktop.

Validation passed: 615 focused tmux GUI tests (two explicit opt-in tests ignored)
and the isolated daemon/GUI-engine test for input, history restoration, split
metadata and session creation. The untouched fixture pane remained unchanged.
That live test deliberately does not launch VS Code. Evidence:
`native-editor-gui-tests.log` and `native-editor-gui-real-daemon.log` in the local
evidence directory.
All-feature client/GPUI Clippy, formatting and source-size checks also passed;
see `native-editor-gui-clippy.log`.

## Native terminal/agent creation client — in progress

The Rust worker now supports semantic window creation for terminals and the
existing Claude/Codex agent intents. It sends one scoped request with the retained
operation UUID, validates the complete returned resource against the requested
workspace/kind/title/harness/role, and rejects a receipt naming the source pane.
Nullable resource fields are required; credentials, argv, cwd and environment are
not response fields. Uncertain results retain their operation ID and never cause
an automatic mutation replay. Controller authority and GUI routing are handled by the native integration
below; this client does not grant itself input or geometry authority.

The real-daemon fixture created a terminal window. Its first immediate inventory
assertion failed because the new pane was not in that read. A bounded sequence of
fresh read-only inventory observations passed with the exact returned pane ID;
the creation request was not repeated. The GUI integration must therefore await
confirmed inventory before selecting a created pane, not treat the mutation
receipt alone as attachability. Agent response matching is covered by fixtures;
these checks do not start paid agent CLIs. The original untouched fixture pane
remained unchanged.

Validation passed: 457 client unit tests, two existing integration tests, one
doctest and the updated isolated daemon client check. Evidence:
`native-create-pane-tests.log` and `native-create-pane-real-daemon.log` in the local
evidence directory.
All-feature client/GPUI Clippy, formatting and source-size checks also passed;
see `native-create-pane-clippy.log`.

## Native GUI window/agent owner actions — in progress

Controller-authorized window and agent requests now reach the native catalog
worker directly. Route, generation, live session, source pane and sequence checks
precede submission, with a bounded one-use operation ledger per selection. A
duplicate does not settle or cancel its original pending action. The same rule
now applies to editor requests. The existing controller still acquires input and
geometry authority and owns its submission barrier.

The worker sends the mutation once, then performs bounded, cancellable inventory
reads until the returned pane is attachable. Only then does it return a typed
creation result to the existing owner completion logic, which refreshes the
terminal connection with the new pane preference. No Node response envelope or
JSON round trip is used for this native result. Errors retain the existing
unconfirmed-action behavior; they do not replay creation. The normal packaged
launcher remains on the helper until remaining native features are qualified.

The isolated GUI fixture now invokes New Window through its displayed action
token, waits for a ready frame/input target on a different pane in the same
session, and checks that the pane count increased by exactly one. Agent wire
validation remains fixture-tested rather than launching agent CLIs.

The first end-to-end New Window run timed out: the terminal stream was interrupted
and the transport discarded the pending owner before its receipt arrived. The
transport now retires terminal IO while retaining an already-dispatched owner
operation until its exact receipt or original deadline. Unsent actions cannot
survive interruption. Presence changes do not send commands to the retired
controller. A receipt or timeout triggers read-only inventory reconciliation,
never mutation replay. This also preserves correlation on the helper transport.

The corrected same-path live run passed: one additional window, selected new
pane with a ready frame/input target, history restoration and the untouched
fixture pane check. Validation passed: 458 client unit tests, two existing client
integration tests, one doctest and 617 focused tmux GUI tests. Opt-in checks ran
only against the isolated daemon. Evidence: `native-owner-client-tests.log`,
`native-owner-gui-tests.log` and `native-owner-real-daemon.log` in the local evidence
directory. This is GUI-engine qualification, not physical input-to-paint or a
packaged release claim.
All-feature client/GPUI Clippy and formatting/source-size checks passed as well;
see `native-owner-clippy.log`.

## Native SSH discovery foundation — in progress

The Rust client now validates the remote daemon descriptor and saved SSH target,
constructs the fixed read-only discovery and independently owned tunnel commands,
and runs discovery on a background worker with cancellation and a deadline.
Nonblocking pipe reads have per-iteration budgets: stdout is limited to 32 KiB,
stderr retains at most a 4 KiB classification tail, and neither pipe can block
cancellation. Host-key, authentication, missing-CLI and general failures remain
typed; remote diagnostics and credentials are not included in errors. Exiting an
operation kills and reaps only its exact owned discovery child.

Descriptor parsing does not grant local filesystem authority or authenticate a
future forwarded socket. Per-connection identity verification, tunnel lifecycle,
remote catalog integration and reconnect remain to implement. The production
launcher still uses the existing SSH helper. No real remote connection or physical
SSH latency measurement was performed for this foundation.

Validation: `native-ssh-process-tests.log` records the client suite, including
bounded stdout, busy stderr cancellation, timeouts, SSH failure redaction and
command/descriptor validation. `native-ssh-contract-tests.log` records the earlier
six descriptor/command checks. These tests launch only local fixture commands;
they do not change saved SSH configuration or contact personal machines.
Client validation passed: 468 unit tests, two integration tests and one doctest.
All-target/all-feature client and GPUI Clippy passed; formatting, source-size and
whitespace checks passed. Full packaged and cross-platform qualification remains
pending.

## Native SSH HTTP identity gate — in progress

`tmux_ssh::VerifiedConnection` verifies the complete discovery identity using an
unauthenticated `/identity` request, then permits the fixed authenticated
capabilities request on that same pooled TCP connection. Its custom ureq connector
is single-use and pinned to the exact loopback forward port. HTTP connection
closure, redirects or pool replacement cannot redial with credentials: a new
connection requires a new identity proof. The standard HTTP parser and bounded
response reads remain in use. This does not establish local image/editor
provenance and does not yet own the SSH tunnel or its generation.

Thirteen focused SSH tests passed, including mock TCP peers that check the first
request contains no Authorization header, authenticated traffic uses the same
socket, an identity mismatch receives no credentials, and a closed verified
socket produces no second connection. Evidence: `native-ssh-identity-tests.log`.
Tunnel ownership, WebSocket identity gating and remote catalog integration are
still pending; the normal launcher remains on the helper.
The full client suite also passed (471 unit tests, two integration tests and one
doctest), as did all-target/all-feature client and GPUI Clippy, formatting and
source-size checks. Evidence: `native-ssh-identity-client-tests.log` and
`native-ssh-identity-clippy.log`. Final platform and packaged GUI gates are pending.

## Rust-owned SSH tunnel and route — in progress

`tmux_ssh::Tunnel` now owns the independently spawned SSH forward, bounded stderr
classification and off-UI process cleanup. Retirement changes its state
immediately and signals a bounded channel. The worker attempts SIGTERM, then
kills/reaps only its owned child after a 250 ms grace period. Dropping the guard
also retires the worker through channel disconnection. No remote daemon or shared
SSH control master is stopped. A reserved/released loopback port remains an
untrusted routing hint, never proof of ownership.

`RemoteTransport` composes bounded SSH discovery, tunnel ownership and the
single-connection HTTP identity gate. It creates a fresh route generation,
checks tunnel liveness before and after authenticated reads, and rejects results
after cancellation or retirement. Startup retry is limited to credential-free
identity probes until the caller's deadline; it does not replay actions. The
native GUI catalog still needs to use this route, and WebSocket credential gating
and reconnect behavior remain to implement.

The fixture tests exercise immediate retirement, busy stderr, child cleanup,
redacted host-key/authentication failures, pre-cancelled/expired startup, and the
composed route's identity/capabilities sequence plus rejection after retirement.
The composed fixture uses a loopback mock peer and an owned sleep process, not a
real SSH server. Evidence: `native-ssh-tunnel-tests.log` in the local evidence
directory. No live SSH or packaged GUI qualification is claimed here.
Validation passed: 476 client unit tests, two integration tests and one doctest;
all-target/all-feature client and GPUI Clippy (`native-ssh-tunnel-clippy.log`),
formatting, source-size and whitespace checks. Full platform/package gates and
physical GUI/SSH measurements remain pending.

## Shared native catalog owner — in progress

The native catalog worker now accepts an explicit SSH source through
`CatalogWorker::spawn_remote`. A typed local/remote owner beneath `ServerClient`
reuses the existing server/session validation, selected-generation checks,
request cancellation and operation receipts. The remote owner routes HTTP reads
and mutations through the Rust-owned tunnel and connection identity gate. A failed
request is never replayed; a later explicit operation can establish a new,
identity-verified connection on the retained tunnel generation.

Local editor and image access still require the private local daemon record.
Remote terminal issuance currently fails that local-only gate intentionally:
WebSocket identity verification and remote capability URL rewriting must be
integrated before enabling it. The GUI's remote terminal path and normal launcher
have not been switched over.

The mock remote owner test lists servers, selects an exact server generation,
reads typed sessions and rejects retired selections/local authority. It verifies
unauthenticated identity followed by authenticated catalog reads on the same
socket. The full client suite passed: 477 unit tests, two integration tests and
one doctest (`native-remote-catalog-tests.log`). This is not live SSH, remote
mutation or packaged GUI qualification.
All-target/all-feature client/GPUI Clippy passed, along with the 617 focused
`tmux_snapshot` GUI tests (two opt-in tests ignored). Evidence:
`native-remote-catalog-clippy.log` and `native-remote-catalog-gui-tests.log`.
Formatting, source-size and whitespace checks passed. These remain engine tests,
not physical input, live SSH or final packaged qualification.

## Remote terminal socket identity — in progress

`PaneStream::spawn_remote` now verifies a credential-free `PeerIdentity` on its
actual TCP socket before WebSocket upgrade and capability redemption. The verifier
uses ureq's HTTP framing, including chunked responses, with a single-use connector
that cannot replace the supplied socket. Response bodies are bounded to 64 KiB,
buffered trailing bytes are rejected, and the same socket returns to nonblocking
mode for the existing terminal worker. Cancellation can interrupt the proof by
shutting down the worker's existing socket clone. No reusable daemon token enters
the expected peer identity.

The full client suite passed, including an actual WebSocket fixture after a valid
identity response and a mismatched peer that receives neither an upgrade nor a
redemption ticket. Chunked-body/socket reuse and identity/trailing-data rejection
are also covered. Evidence: `native-ssh-websocket-tests.log` and the focused
`native-ssh-socket-tests.log`. This worker entry still needs native handoff and
remote issuance integration; it is not yet the GUI's remote terminal path.
Validation passed: 480 client unit tests, two integration tests and one doctest;
all-target/all-feature client and GPUI Clippy (`native-ssh-websocket-clippy.log`),
formatting, source-size and whitespace checks. Live SSH, GUI handoff integration,
physical latency and final packaged qualification remain pending.

## Native remote capability handoff — in progress

Remote `ServerClient::issue_terminal` now validates the issued descriptor against
the SSH-discovered daemon's canonical origin, then rewrites only the address to
the owned local forward. It carries a credential-free peer identity in memory
through the native handoff, connection options and terminal worker. Broker JSON
cannot populate that field. Remote handoffs have no local-image access, and the
native session rejects combining remote identity with local-image provenance.

An end-to-end fixture exercises native remote server selection, capability
issuance, URL rewriting, socket identity proof, WebSocket redemption and Ready.
It uses a loopback mock daemon and owned process fixture; no Node helper is
involved, but this is not a real SSH or desktop test. The native GUI still needs
the remote source entry and saved-machine/reconnect integration before its normal
remote route can be switched. Evidence: `native-remote-handoff-tests.log`.
Validation passed: 482 client unit tests, two integration tests and one doctest;
617 focused `tmux_snapshot` GUI tests (two opt-in tests ignored); and all-target/
all-feature client/GPUI Clippy. Logs: `native-remote-handoff-tests.log`,
`native-remote-handoff-gui-tests.log`, `native-remote-handoff-clippy.log`.
Formatting/source-size/whitespace checks passed. Final platform/package and
physical GUI/SSH measurements remain pending.

## Native GUI SSH development entry — in progress

The native GUI now accepts `--tmux-native-ssh TARGET [--environment UUID]`. It uses
shared `CatalogSource` discovery and one Rust-owned SSH tunnel across foreground
catalog and slow split-layout workers. Each worker has its own identity-verified
HTTP lane. The initial proof connection is reused when idle; creating another
lane never waits for an in-flight request. Explicit worker refresh invalidates
only its known connection generation, so a late reset cannot retire a replacement.
The native fleet shows the selected SSH destination rather than a Local label.
The normal packaged launcher and saved-machine UI still use the helper.

Mock tests prove a foreground capabilities request completes while the slow lane
is held open, and that an old worker reset leaves a replacement generation usable.
The full client suite passed (484 unit tests, two integration tests, one doctest;
`native-shared-ssh-tests.log`). This is not live SSH or physical GUI evidence.
The existing `scripts/lib/owned-ssh-fixture.mjs` provides a private nonroot macOS
OpenSSH server for the next qualification step without personal configuration.
Validation also passed: 617 focused GUI tests (two opt-in tests ignored), five
product CLI tests including pre-GUI SSH validation, and all-target/all-feature
client/GPUI Clippy. Logs: `native-shared-ssh-gui-tests.log`,
`native-shared-ssh-cli-tests.log`, `native-shared-ssh-clippy.log`. Formatting,
source-size and whitespace checks passed. Live SSH, full platform/package gates
and physical measurements remain pending.

## Owned OpenSSH qualification — transport passed

`bridge/native-ssh-smoke.mjs` now runs an opt-in Rust test through the existing
private nonroot macOS OpenSSH fixture. Rust executes its production discovery
command, creates its owned SSH forward, verifies the actual forwarded HTTP
connection and performs an authenticated capabilities request. The SSH server,
keys, known-hosts file, client config and child processes are fixture-owned; no
personal SSH configuration or daemon is accessed. The HTTP peer is synthetic.

The real run passed with one identity request, one authenticated request and
successful process/listener/file cleanup. Only `qualification.json` and sanitized
`rust.log` remained in the private fixture root. Retained evidence:
`native-owned-ssh-receipt.json` and `native-owned-ssh-live.log` in the local evidence
directory. This proves real SSH discovery/forwarding for the native Rust route,
not a real tmux daemon, remote terminal rendering, desktop input or latency parity.

Run with the explicitly selected Rust client test binary:

```sh
node --import tsx apps/tmux-gpui/bridge/native-ssh-smoke.mjs /absolute/herdr_client-test-binary
```

The opt-in Rust test passed through actual OpenSSH; all-target/all-feature client
Clippy passed (`native-owned-ssh-clippy.log`). The new harness passed ESLint,
Prettier and syntax execution, with source-size/whitespace checks passing. No GUI
or full platform/package qualification was added by this transport-only run.

## Real daemon over owned SSH — client passed, GUI pending

The SSH harness accepts an explicit CLI path to start the existing isolated
scratch-fleet daemon. Its private discovery fixture returns that live daemon's
validated descriptor. The Rust client then selects the actual tmux server/session,
admits the designated scratch session, obtains a pane capability and reaches
terminal Ready through an identity-verified SSH-forwarded WebSocket.

The first real-daemon client run passed, preserved the untouched source pane and
completed cleanup. Evidence: `native-real-ssh-client-receipt.json` and
`native-real-ssh-client-live.log`. Its zero HTTP counter fields are uninstrumented
synthetic-server counters, not evidence of zero requests to the real daemon;
the harness now emits null for those counters in real-daemon mode.

The optional third argument runs the native GUI engine journey over SSH, covering
programmatic input, history restoration, session and window creation. This does
not exercise OS keyboard delivery or GPU painting:

```sh
node --import tsx apps/tmux-gpui/bridge/native-ssh-smoke.mjs /absolute/client-test-binary /absolute/bin/cli.js /absolute/gui-test-binary
```

### Real-daemon native GUI SSH journey

The full native GUI engine journey passed through actual owned OpenSSH and the
scratch daemon: session selection, frame/input readiness, split metadata,
programmatic input, history restoration, session creation, window creation and
selection of the new pane. The separate source pane stayed unchanged. This uses
the production native catalog/controller path without the metadata helper.

The first run passed the journey but returned `cleanup:false`; only evidence
logs remained afterward and no new fixture SSH processes were visible. The
harness then gained per-step cleanup diagnostics. Four subsequent runs passed
capture, process, file, daemon and fleet cleanup. The original flag's cause is
unresolved: these passes do not erase that lifecycle-audit anomaly.

Evidence index 0 is the flagged run; indices 1–4 are clean runs:
`native-real-ssh-gui-N-qualification.json`, `native-real-ssh-gui-N-rust-0.log` and
`native-real-ssh-gui-N-rust-1.log`. Physical input-to-paint, GPU painting, remote
compression, platform/package gates and final memory qualification remain open.

### Explicit native SSH shutdown ownership

The shared catalog source now stops discovery, cancels an opening route and
waits for its owned forwarding child to be reaped. Retired generations are
acknowledged before replacement, and failed connection startup synchronously
cleans its tunnel on the worker. Other daemon processes are untouched.

Normal native SSH Quit and last-window-close dispatch cleanup to a background
worker before requesting platform exit. This is needed because the pinned GPUI
macOS implementation uses NSApplication termination and its final shutdown
future budget is only 200 ms, shorter than the tunnel TERM grace period.
Window-open failure uses the same cleanup path. External forced termination and
OS-initiated shutdown still require separate qualification.

Client tests passed (486), as did the GUI engine tests (617). The owned real-SSH
GUI journey with explicit owner shutdown passed, preserving the source pane and
passing every cleanup audit step. Evidence: `native-shutdown-client-tests.log`,
`native-shutdown-gui-tests.log`, `native-shutdown-ssh-qualification.json` and
`native-shutdown-ssh-rust-{0,1}.log`. These verify the engine path, not the physical
macOS Quit interaction. The earlier unexplained cleanup flag remains recorded;
this change is not proof of its cause.

All-target/all-feature Clippy passed for herdr-client and herdr-gpui after the
window-open-failure cleanup and lint correction (`native-shutdown-clippy.log`).
The engine test binary predates those two UI-only edits; physical Quit and
window-open-failure validation remains outstanding.

### Native reconnect after an owned SSH tunnel interruption

The native catalog now recovers an interrupted terminal with up to three
rediscovery attempts, delayed by 250/500/1000 ms. Recovery defers in the
background and user navigation cancels it. Each attempt resets the old owner,
verifies the new connection, rebuilds the catalog and reopens only the exact
previous server generation and session. The preferred pane is restored when
still present. An absent or replacement identity requires explicit selection.
Creation actions are never automatically replayed. A matching coherent Ready
notice ends recovery; stale route/request/generation notices cannot do so.

The owned SSH harness records its forwarding process PID in its private evidence
directory and verifies both kernel identity and ancestry before sending TERM.
The native GUI engine then must observe input revocation and regain readiness
for the same session/pane with a new input token before continuing its typing,
scrolling, history and creation journey. This remains programmatic engine
qualification, not physical input-to-paint measurement.

An initial fault-injection run recovered successfully but cleanup rejected the
mutable PID file mistakenly registered as immutable. The PID file was moved to
the private evidence directory; the next run passed every cleanup step.
Retained receipts: `native-reconnect-initial-qualification.json` and
`native-reconnect-clean-qualification.json`. This explained harness error is
separate from the earlier unexplained lifecycle audit flag.

Final strengthened fault injection passed with input revocation, same-pane
recovery, the full journey and every cleanup step. Evidence:
`native-reconnect-final-qualification.json`, `native-reconnect-final-rust-1.log`.
All 623 GUI engine tests passed (`native-reconnect-gui-tests.log`).
All-target/all-feature Clippy also passed for herdr-client and herdr-gpui
(`native-reconnect-clippy.log`); the harness passed ESLint and Prettier.

### Native local saved-machine registry management

The Rust local owner now reads the canonical saved-machine resource and sends
single-attempt PATCH mutations for edit/enable/disable/remove. It verifies local
record provenance and the complete daemon identity, bounds responses, validates
profiles against the canonical schema (including UTF-16 length, Unicode control
and format characters, NFKC label uniqueness, SSH destination syntax and optional
environment pins), and re-reads the registry before writing. The daemon API does
not expose an atomic registry CAS; the stale-snapshot check matches the existing
helper behavior and is not an atomic cross-client lock.

The native local GUI publishes the existing registry model and handles its read
and mutation commands. Displayed revision, foreground state and pending work gate
writes. Cancellation after submission and a lost response mark the outcome
unconfirmed and require a fresh read; no automatic write replay occurs. HTTP
registry authority is available only on LocalDaemon, never a remote route.

Six new client tests cover validation, normalized labels, identity pins, stale
registry rejection and uncertain receipt handling. The complete client suite
previously passed 492 tests; final source verification is recorded in
`native-machines-client-tests.log`. All 625 GUI tests passed, including revision
fencing and cancellation. The real owned local-daemon GUI journey passed with an
explicit available-registry assertion (`native-machines-local-live.log`). No
personal registry was mutated. Live GUI mutation against the canonical route is
not yet qualified; mutation HTTP tests use an isolated server.

Remaining machine work: saved-profile connection and route invalidation, add/import,
external registry watching, fleet aggregation, and a separate local registry owner
while viewing SSH. The normal packaged launcher still uses the helper. This does
not complete the native catalog migration or the larger pixel/performance goal.

Final client verification passed: 492 unit tests, two integration tests and one
doctest. All-target/all-feature Clippy passed for both affected crates
(`native-machines-clippy.log`); harness ESLint, formatting and source-size gates
also passed.

### Saved-profile route selection and independent local authority

A native local entry now retains its registry worker while replacing the viewed
catalog/terminal source. A saved-profile selection rereads the registry and
requires the exact displayed snapshot and an enabled profile before constructing
the SSH source with its environment pin. Returning to Local reuses the explicit
local record. The SSH entry accepts `--local-daemon RECORD` (after any
`--environment UUID`) to supply independent local registry authority; it never
infers local authority from a remote URL or descriptor.

Registry responses that disable/remove/retarget the selected profile or change
its environment pin retire its owned route and return to Local. Label-only edits
update presentation without replacing the route. Registry failures also retire
a selected saved-profile route. External registry watching is still pending, so
this invalidation currently runs on explicit reads/mutations and catalog refresh.
The shutdown owner follows source replacements, preventing a tunnel opened after
startup from escaping the normal Quit cleanup boundary. Late adoption after
shutdown is rejected.

The owned real-SSH harness seeded one saved profile in the private scratch
registry through the canonical API. Its GUI journey selected that profile,
reconnected after the owned tunnel was terminated, completed the terminal/history/
creation journey, and returned to Local. All cleanup steps passed and the source
pane stayed unchanged. Evidence: `native-profile-qualification.json` and
`native-profile-rust-1.log`. All 628 GUI engine tests passed
(`native-profile-gui-tests.log`). The live binary predates only the subsequent
verification-error status correction; physical GUI and packaged checks remain
outstanding. No personal registry or SSH process was changed.

Final static checks passed: all-target/all-feature Clippy for both affected
crates, five product CLI tests (including relative local-record rejection),
source-size and diff checks, and harness ESLint/Prettier. Evidence:
`native-profile-clippy.log` and `native-profile-cli-tests.log`.

### Fresh saved-profile authority before rediscovery

Automatic recovery and manual Home/Refresh now re-read the local saved-machine
registry before the main worker can discover a replacement SSH connection.
Changed target/environment authority, disable/remove, or a registry read failure
retire the selected route and return to Local. The initial profile selection
reuses its immediately preceding verified snapshot instead of adding a duplicate
read. An unchanged profile keeps the original session/generation/pane recovery
intent. External changes during an otherwise healthy session still require the
pending registry-watch implementation.

All 631 GUI engine tests passed (`native-profile-recovery-tests.log`), including
saved-profile recovery, manual refresh fencing and disabled-profile cancellation.
Two owned real-SSH runs passed: unchanged-profile recovery completed the full
terminal/history/creation journey, while a profile disabled through the canonical
scratch API just before tunnel termination returned to Local. The private SSH
wrapper's append-only process journal showed no replacement forwarding process
in the revoked case. Both runs passed every cleanup step and preserved the source
pane. The revoked case is explicitly not counted as the full terminal journey.

Evidence: `native-profile-proof-normal-qualification.json` and
`native-profile-proof-revoked-qualification.json`, with matching rust logs.
These remain engine/authentication/lifecycle checks, not physical GUI latency
or packaged release qualification.
All-target/all-feature Clippy passed (`native-profile-proof-clippy.log`), as did
harness ESLint/Prettier, source-size and diff checks.

### Event-driven local registry notifications

The authenticated local daemon now serves a bounded saved-machine watch request.
It checks the expected daemon instance before subscribing, returns a SHA-256
snapshot revision, and holds an unchanged request for up to 20 seconds. Directory
notifications trigger reads; there is no timer that repeatedly reads the registry.
Each owner admits at most 32 pending requests. Abort, timeout, watch failure and
synchronous subscription callbacks all release the watcher. A second read after
subscription closes the read-before-watch race.

The focused terminal release gate passed, including its installed-package journey
(`native-registry-watch-terminal-gate.log`). Regression coverage includes real
atomic registry replacement and real HTTP socket disconnect cleanup. This is an
additive endpoint; the existing registry read/mutation payloads remain unchanged.

The Rust client has a bounded, cancellable watch request with strict identity,
revision and registry decoding. It pins the request to one owned loopback socket;
shutdown closes that exact socket instead of waiting for the 25-second network
timeout. Three focused tests passed, covering fragmented chunked responses,
malformed/generation-mismatched payloads, and cancellation during a stalled body
read (`native-registry-watch-rust.log`).

The first integrated SSH run exposed a startup selection race: an initial watch
notification scheduled a redundant registry read, changing the displayed revision
or marking the registry pending just as the profile selection arrived. The engine
stayed on Local (request 0), and the test timed out before opening SSH. Its cleanup
passed (`native-registry-watch-live.log`, first run evidence `nssh-sptU3l`).
Unchanged successful snapshots now retain their revision, and a verified profile
selection may supersede a read-only registry refresh. Pending mutations remain
protected. A regression test covers that exact overlap.

The integrated Rust watcher now wakes the private catalog actor through a
coalesced mailbox. Unchanged heartbeats produce no UI publication. Notifications
invalidate the local registry cache; after any foreground operation, a fresh
local-owner read supplies the authority to apply. The registry worker resets on
read failures so a replaced daemon record can be rediscovered. Shutdown owns and
cancels the watch alongside the currently selected source; idle actors park
without adding a registry polling timer.

The repaired GUI suite passed all 3,055 library tests (10 opt-in tests ignored).
A new real-SSH mode disabled the saved profile while its terminal was healthy,
without killing or interrupting the SSH process. It observed input revocation,
return to Local, no replacement forwarding process, and complete owned cleanup.
The normal interruption/reconnect mode also passed its full engine journey and
cleanup. Evidence: `native-registry-watch-healthy-qualification.json`,
`native-registry-watch-normal-qualification.json`, and their matching rust logs.
All-target/all-feature Clippy for both affected crates passed
(`native-registry-watch-clippy.log`). These tests exercise the native engine,
not physical keyboard-to-paint latency or the packaged default launcher.

Still outstanding: remaining native catalog/fleet parity, switching the packaged
launcher after qualification, production authenticated pixel transport and GPU
retirement, compression, cross-platform gates, physical GUI and memory evidence.

Final client checks passed: 495 unit tests, two integration tests and one doctest
(`native-registry-watch-client.log`). Source-size, harness/daemon lint and diff
checks passed. The generated CLI used by the isolated live tests was restored to
its prior clean state; source changes remain uncommitted and no release was made.

### Native Add machine and add-only imports

The client now prepares profiles with the canonical alias, label and identity
rules: a unique enabled target reuses its existing ID and environment pin;
disabled/ambiguous matches fail; generated labels avoid normalized collisions and
reserved Local names. Add-only imports validate capacity, IDs and labels, and
never overwrite a conflicting route. The existing authenticated local POST
endpoint performs the save, with a fresh registry read before it and exactly one
send. Cancellation is checked again before that send.

The Add machine command now schedules this work on the local catalog worker.
After a save receipt is lost, it reads back rather than replaying the write. A
matching saved profile retains its identity; a conflicting or disabled profile
cannot become an unpinned route. If a fresh authoritative read proves the save
absent, the helper's existing run-only connection behavior is preserved with a
visible message. Navigation cancels connection adoption; a submitted save remains
explicitly unconfirmed until refreshed.

Seven focused client tests passed (`native-machine-add-client.log`), including
real HTTP save-once, committed/absent lost receipts and concurrent disable. GUI
and owned-SSH qualification are being run separately; this section does not claim
packaged or physical-input qualification.

The complete GUI library suite passed 3,056 tests (10 opt-in tests ignored). The
owned OpenSSH Add mode started with an empty scratch registry, added the target
through the native GUI command, completed the terminal/history/creation journey,
recovered from an owned tunnel interruption, returned to Local, and confirmed
exactly one persisted profile through the canonical API. Every cleanup step
passed and the source pane was unchanged. Evidence: `native-machine-add-gui.log`,
`native-machine-add-qualification.json` and its matching rust logs. This is
engine-level evidence, not a physical GUI input or packaged-launcher claim.

A coordinated HTTP test additionally canceled during the preflight registry read
and observed zero save requests. The final client suite passed 503 unit tests,
two integration tests and one doctest (`native-machine-add-client-full.log`).
All-target/all-feature Clippy passed for both affected crates, with a final client
Clippy run after the additional cancellation test. Source-size, harness lint and
diff checks passed. The generated CLI test artifact was restored to its prior
clean state. No commit, default-launcher switch or release was made.

### Local fleet preference client contract

Rust now exposes typed local-only fleet state reads and one-shot preference
writes through the catalog worker. The schema mirrors the canonical favorite,
collapse, visit, cached-route and forget-route payloads, including UTF-16 string
limits, control/format character rejection, nullable versus optional fields,
server scopes, UUID constraints, safe timestamps and collection bounds. Cache
rows are display data and cannot establish live route authority.

Requests use the independently verified local daemon record, expected instance
ID, redirect refusal and before/after identity checks. The endpoint has its own
64 MiB response ceiling matching the existing helper contract; ordinary metadata
responses keep their smaller bounds. Writes enforce the daemon's 256 KiB request
limit. Cancellation after preflight prevents sending; a failure after submission
returns an uncertain outcome and does not retry. Remote catalog owners cannot
enter this local operation branch.

HTTP tests cover verified reads/writes, lost receipts, replaced response identity,
cancellation during identity proof, and a valid cache larger than 1 MiB. Decoder
tests cover the pinned Zod UUID rules, Unicode limits, nullable fields and
malformed scopes. The native GUI does not yet publish or mutate these preferences:
that requires stable fleet/session key projection and revision-bound UI actions.
Recent-visit acknowledgement and queue lifetime fencing also remain to be wired.

Final verification: 514 client unit tests, two integration tests and one doctest
passed (`native-fleet-preferences-full.log`). All-target/all-feature Clippy passed
for client and GUI, followed by a client Clippy pass after the final decoder tests
(`native-fleet-preferences-clippy.log`, `native-fleet-preferences-client-clippy.log`).
Source-size and diff checks passed. No native UI preference behavior, physical
input performance, packaged launcher switch or release is claimed by this step.

### Native catalog identity and stable session keys

The native catalog worker now returns the credential-free daemon instance and
verified environment identity with server discovery. Local snapshots verify the
private owner before and after the resource read; SSH snapshots use the captured,
socket-verified descriptor. Native Home retains this identity only for its current
catalog and clears it when refresh starts.

Fleet session display IDs now match the helper's persisted-key format. A known
unconflicted environment uses `[environment, "session", server, generation, live]`;
missing/conflicting identity uses the exact nested route-scoped fallback. The
selected route alias can change without changing an environment session's key,
while a new server generation changes it. Selection remains a separately generated
UUID token, never the persisted key. This prepares native favorite/visit wiring;
it does not enable preference writes or multi-route environment grouping yet.

Verification passed: 3,057 GUI library tests, 516 client unit tests, two client
integration tests and one doctest. The new engine test confirms refresh preserves
the stable row ID while rejecting both the previous selection token and the
stable key as selection authority. Pure tests cover alias-independent environment
keys, generation replacement and the exact nested fallback encoding. The owned
real-SSH journey also passed reconnect, return-to-Local and all cleanup checks.
Evidence: `native-catalog-identity-gui.log`, `native-catalog-identity-client.log`,
`native-catalog-identity-qualification.json` and matching rust logs. Both affected
crates passed all-target/all-feature Clippy (`native-catalog-identity-clippy.log`).
Source-size and diff checks passed. The generated CLI fixture was restored.
Preference UI, visit acknowledgement, fleet aggregation, pixels/compression and
packaged/physical qualification remain outstanding; the goal is not complete.

### Native favorite and collapse controls

The opt-in native catalog now reads and writes favorites and collapsed groups
through its independent local daemon worker, including while viewing SSH. Each
control carries a fresh opaque action token and exact UI revision. Consuming a
control invalidates all current tokens before scheduling the write. A private
owner stamp also fences writes against local record replacement, including an
authentication-token change with the same daemon instance ID. Preferences never
grant terminal selection authority.

Loading and uncertain writes disable controls. Failed receipts clear the
acknowledgement and require an explicit refresh; mutations are not replayed.
Foreground catalog work can preempt a read, and idle scheduling now starts the
pending preference read before parking. The current projection covers the viewed
group only. Accepted-live recent visits, navigation history and multi-route fleet
aggregation remain outstanding.

The GUI library suite passed 3,059 tests. The owned real-SSH journey verified
favorite persistence, duplicate/stale action rejection, collapse and expansion,
refresh, tunnel recovery and return to Local; every cleanup check passed. Evidence:
`native-preference-ui-gui.log`, `native-preference-ui-live.log`,
`native-preference-ui-qualification.json` and matching Rust logs. This is engine
qualification, not physical typing, packaged-app or performance evidence. The
normal packaged launcher still uses the metadata helper.

The first full client run found a cancellation test that required FIN/EOF while
macOS returned a connection reset. The assertion now accepts either closed-socket
outcome while still rejecting data, timeouts and other errors. The initial failure
is retained in `native-preference-ui-client.log`.

The final client run passed 517 unit tests, two integration tests and one doctest
(`native-preference-ui-client-final.log`), including the owner-stamp rejection test.
Rust formatting, source-size, harness ESLint and diff checks passed. The generated
CLI fixture was restored to its prior clean state. No release was made.

All-target/all-feature Clippy passed for both affected crates after replacing a
test's default-then-field-assignment initializer
(`native-preference-ui-clippy-final.log`). The goal remains active.

### Native accepted-session visits

Native readiness now admits a visit only for the current route ID, request,
server generation and live session, with coherent input readiness and matching
foreground-presence revision. Catalog discovery alone does not admit visits.
The active-row projection also uses the accepted attachment rather than a route
that is merely opening.

Accepted visits wait for the initial preference acknowledgement, then serialize
behind existing preference work. The bounded queue retains each local owner
stamp, deduplicates readiness for an attachment, and rejects replacement owners.
Uncertain writes and explicit preference invalidation retire queued work without
replay. Closing an attachment removes its pending readiness candidate; already
queued, acknowledged-owner visits can drain in order unless their preference
lifetime is invalidated. Full back/forward navigation remains to be migrated.

Foreground pane/editor/history/catalog actions can preempt a background visit
save. A submitted save is treated as uncertain and is not replayed; explicit
favorite/collapse saves keep their existing admission behavior. This keeps the
background history operation from rejecting a foreground action as busy.

The initial verification passed 3,063 GUI tests and the owned OpenSSH journey,
including persisted visits, reconnect, return to Local and every cleanup check.
Evidence: `native-visits-gui.log`, `native-visits-live.log` and its retained fixture
receipt. All-target/all-feature Clippy also passed (`native-visits-clippy.log`).
These results precede the final foreground-preemption adjustment; final checks
are recorded separately below. No physical-input or packaged-release claim follows
from this engine journey.

Final GUI verification passed all 3,063 tests after the preemption change
(`native-visits-gui-final.log`). The repeat owned-SSH journey also passed persisted
visits, preference controls, recovery, return to Local, source-pane preservation
and every cleanup step (`native-visits-live-final.log`,
`native-visits-final-qualification.json` and matching Rust logs). The generated
CLI fixture was restored. Back/forward navigation, multi-route fleet aggregation,
production pixels/compression and packaged/physical qualification remain open.

Final all-target/all-feature Clippy passed for both affected crates
(`native-visits-clippy-final.log`). Formatting, source-size, harness lint and diff
checks passed. The goal remains active; no release or launcher switch was made.

### Native session navigation

The native owner now maintains a bounded session-history ledger seeded once from
canonical recent keys. It publishes opaque back/forward capabilities bound to the
current request and revision. Admission resolves a stable key through the current
verified catalog into a separate selection token; normal daemon opening still
checks the exact server generation. Unknown destinations are rejected without
moving the history cursor. Cross-machine traversal remains dependent on fleet
aggregation and route resolution.

The cursor commits only after matching live readiness. Stale tokens, canceled
attempts, mismatched readiness and background commands cannot move it. Ordinary
visits truncate forward history only when they change the selected history key;
adjacent duplicates preserve it. The first GUI suite passed 3,066 tests
(`native-navigation-gui.log`). The expanded live journey and final checks are
recorded separately when completed.

The first expanded live test failed while returning to a session with restored
scrollback (`native-navigation-live.log`, fixture `nssh-0MyYKt`); all cleanup steps
passed. The native readiness notice was gated on UI typing readiness, which is
intentionally false in scrollback. Attachment acknowledgement now requires the
controller's coherent live input authority and a non-retained presented frame,
while leaving the UI typing gate unchanged. The live regression explicitly checks
that restored history remains visible and typing remains disabled before forward
navigation. Verification of this correction follows below.

After the readiness correction, 3,066 GUI tests and all-target/all-feature Clippy
passed (`native-navigation-history-gui.log`, `native-navigation-history-clippy.log`).
The first live retry reached the back destination but asserted history restoration
on its initial frame before asynchronous history loading finished. The regression
now waits for restored history before asserting that typing is disabled. That
failed run also reported a descendant-parent capture mismatch during cleanup
(`native-navigation-history-initial-qualification.json`, fixture `nssh-VrDdBK`);
process/file/daemon/fleet cleanup passed, but the capture failure remains recorded
and is not explained away by a later successful run.

The final real-SSH journey passed back traversal to restored history (typing
remained disabled), stale action rejection, forward traversal, visit/preference
persistence, reconnect, return to Local, source-pane preservation and all cleanup
steps. Evidence: `native-navigation-live-final.log`,
`native-navigation-final-qualification.json` and matching Rust logs. The corrected
live-test wait was rebuilt with `native-navigation-history-build.log`; production
code was unchanged after the 3,066-test and Clippy passes above. Generated CLI
output was restored. This does not resolve the earlier capture anomaly or establish
physical-input/packaged-app performance. Cross-machine navigation, full fleet
aggregation, pixels/compression and final qualification remain outstanding.

### Native cross-machine history resolution

The history ledger now retains at most 64 display-key-to-machine locators, pruned
with its entries. A locator carries no SSH target, credentials, daemon generation
or terminal capability. A history destination absent from the current catalog may
select Local or a currently enabled saved profile, using the existing fresh
registry equality check and environment pin verification before SSH discovery.
The resulting fresh catalog must resolve the exact stable session key before
opening; missing/replaced identities fail without moving the history cursor.

Internal source transitions preserve a pending traversal only for its exact
request and destination machine. User navigation, profile revocation or an
unexpected source change cancels it. This is a prerequisite for broader fleet
aggregation; it does not provide concurrent all-machine catalogs or persistent
route discovery for history entries seeded without an observed route.

The SSH harness has an opt-in `TMUX_IDE_NATIVE_TEST_DISTINCT_LOCAL=owned-fleet`
mode with separate owned local and remote daemons/fleets. Its journey returns to
Local, traverses history back to the saved SSH machine through fresh discovery,
then returns to Local again. Both owners have independent cleanup, and both auth
tokens are redacted from retained child logs. Results follow below.

Verification passed: 3,067 GUI tests (`native-cross-navigation-gui-final.log`) and
all-target/all-feature Clippy for both affected crates
(`native-cross-navigation-clippy.log`). The distinct-owner SSH journey verified
cross-machine navigation, ordinary back/forward navigation, persisted visits and
preferences, reconnect, return to Local, source-pane preservation and every cleanup
step (`native-cross-navigation-live-final.log`,
`native-cross-navigation-final-qualification.json` and matching Rust logs).

The initial fixture used the remote instance ID when saving to its new local
registry owner and was rejected before the Rust journey; its cleanly disposed
failure is retained in `native-cross-navigation-initial-qualification.json`.
Fixture writes now use the local registry owner's instance ID. Generated CLI
output was restored. No launcher switch, physical performance claim or release
was made. Concurrent fleet aggregation, alias/conflict handling, persistent cached
route discovery, pixels/compression and packaged/physical qualification remain.

### Packed CoreVideo renderer prerequisite

The application now patches its pinned Apple GPUI crate to a repository-owned
copy (see `../vendor/README.md` and its original-file provenance manifest).
The renderer accepts straight-alpha BGRA CoreVideo buffers alongside existing
NV12 surfaces, selects the pipeline for each draw, and holds submitted buffers
until GPU completion. The registry cache remains unchanged. Native build receipts
now include this sibling dependency's declared runtime source inputs; shader
mutation and redirected vendor roots invalidate verification.

Actual Metal tests exposed CoreVideo error -6680 when allocating IOSurface-backed
RGBA buffers on this host. BGRA is the implemented packed format. An initial
BGRA test fixture also drew only half of its readback width; that fixture was
corrected before qualification. Neither failure is evidence that the original
RGBA file-mapping prototype can be passed directly to this CoreVideo API.

Verification passed: 12 standalone Apple renderer tests, including adjacent-color
readback, mixed BGRA/NV12 rendering and buffer retention through GPU completion
(`native-bgra-surface-tests-qualified.log`); 3,067 application GUI tests, with ten
ignored (`native-bgra-gui.log`); all-target/all-feature Clippy for client and GUI
(`native-bgra-clippy.log`); nine native receipt tests; script lint and source-size
checks. The standalone renderer lockfile and application lockfile are separate.
A real source snapshot included 20 vendor inputs. Evidence logs remain under
`/Volumes/Samsung_T5/Developer/gui-main-integration-20261023`.

This is renderer integration, not production pixel transport. Authenticated offers,
pane-generation fencing, bounded storage, damage sequencing, GPU-retirement ACKs,
reconnect/fallback and remote compression remain. The GPU tests do not establish
physical input-to-paint latency or frame rate. No release or default metadata
launcher change was made.

### Surface alpha, failure recovery and retirement boundary

Further GPU coverage verifies straight-alpha blending against an opaque backdrop,
fully transparent colored pixels, content-mask clipping, and a successful draw
after rejecting an unsupported CoreVideo format. The NV12 import path now returns
texture-creation/null-texture errors rather than panicking, matching the new BGRA
path. All 14 standalone renderer tests passed (`native-bgra-recovery-tests.log`).

Inspection confirmed that existing local-image release means the file has been
read into client memory. It is not a GPU retirement event. The native surface
channel must use a distinct retirement contract: a producer cannot reuse a slot
while either the displayed scene or any submitted GPU frame retains it. The
renderer now retains the CoreVideo buffer across submission, but no producer ACK
is wired yet. Authentication and generation validation must precede any native
storage import; unsupported storage/format must retain the existing image fallback.
The RGBA file-mapping prototype remains incompatible with the BGRA CoreVideo path
without a deliberate import mechanism. These are remaining implementation tasks,
not capabilities advertised by the current app.

The follow-up client/GUI all-target/all-feature Clippy run also passed
(`native-bgra-recovery-clippy.log`), as did the nine build-receipt tests. The
existing `block` dependency still emits its future-Rust incompatibility warning.

### Native surface storage reservations

`herdr-client::tmux_graphics::surface_leases` now provides the storage reservation
and final-consumer retirement mechanism for the native surface channel. One pool
belongs to one authenticated connection; allocation/import must follow successful
reservation, and the caller must first validate pane generation/incarnation.
Packed BGRA geometry charges padded row bytes, rejects overflow and invalid
geometry, and caps a connection at 64 MiB and eight outstanding reservations.

A shared lease must follow actual backing storage through scene and GPU retention.
Only its final drop queues a retirement. The bounded queue has one slot for each
possible outstanding reservation, and final drops never block GPU completion.
Accounting is released when the owning worker drains the retirement. Disconnect
suppresses old events and does not claim retained storage has already been freed.
This is a per-connection bound, not yet a process-wide reconnect memory proof.

Five focused tests passed (`native-surface-leases.log`): final-consumer lifetime,
slot/byte bounds including padding and overflow, disconnect isolation, and stale
sequence rejection despite out-of-order completion. This module is not yet wired
to storage import, authenticated offers, renderer backing or socket ACK delivery;
it must not be described as an active native pixel transport. Those bindings and
process-wide lifetime qualification remain required.

Client all-target/all-feature Clippy passed after replacing a manual divisibility
check and explicitly scoping test-only unwrap allowances
(`native-surface-leases-clippy-qualified.log`). Source-size and whitespace checks
passed. No storage importer, offer decoder or producer API is enabled by this step.

### Cross-connection bounds and CoreVideo owner attachment

Default surface pools now share process-wide limits of 256 MiB and 32 frames,
in addition to their per-connection limits. Charges follow final lease lifetime,
even if the original pool has been destroyed. Reservations use atomic admission
and rollback, with no blocking mutex on final release. Eight tests passed,
including sixteen concurrent admission attempts, old connections retaining full
frames across reconnect, and many small frames across separate connections
(`native-surface-budget-qualified.log`). Client Clippy passed
(`native-surface-budget-clippy.log`). These tests reserve accounting only, not
actual pixel allocations; physical memory qualification is still outstanding.

The Apple renderer now exposes `surface_owner::retain_surface_owner` to attach a
thread-safe Rust owner directly to a CoreVideo buffer. A private non-propagating
CFArray attachment balances Arc retain/release callbacks, and duplicate attachment
is rejected. The GPU ownership test now also checks that this owner survives
submission and retires only when the final buffer reference is released. All
14 renderer tests passed (`native-surface-owner-gpu.log`). The narrowly scoped
unsafe callbacks use only their paired Arc pointers, not CFType interpretation of
Rust memory. Callers must attach before publication and must not remove/replace
this private attachment.

The native producer/storage importer still must bind an actual lease using this
API, after authenticated offer and pane-generation checks. No storage offers,
producer acknowledgments or pixel capability advertisement are enabled yet.

Final client/GUI all-target/all-feature Clippy passed
(`native-surface-owner-clippy.log`), alongside all nine build-receipt tests and the
source-size gate. An actual receipt snapshot includes `surface_owner.rs` among
1,757 source inputs. The existing `block` future-Rust warning remains unchanged.

### Native surface offer admission

`tmux_graphics::surface_offer` defines the Rust admission boundary for version-one
BGRA straight-alpha surface offers. It caps JSON metadata at 16 KiB, rejects unknown
fields and unsupported formats/versions, checks the exact committed pane generation,
incarnation, delivery nonce, canonical revision and state hash, then reserves the
bounded storage lease. Tombstones cannot authorize an import. An accepted offer
retains the committed identity and exposes a recheck for asynchronous import
completion; even structurally identical replacement owners cannot pass it.

Storage tickets are non-nil UUID capabilities for a separate native transfer, not
paths or numeric global IOSurface IDs. This decoder does not authenticate a socket
or resolve a ticket. The future resolver must consume each ticket once, validate
actual storage dimensions/format/size against the offer and retain the lease with
the CoreVideo backing. Offers must remain behind negotiated capability support;
no new wire message or producer endpoint is enabled by this module alone.

Twelve offer/lease tests passed (`native-surface-offer.log`), including mismatches
in every identity component, metadata/geometry bounds, stale sequences, unsupported
formats, tombstones, replaced commits during import and final storage-owner
retirement. The native import, authenticated connection wiring, publisher,
damage/resync, ACK transmission and existing-image fallback remain unfinished.

Client all-target/all-feature Clippy passed (`native-surface-offer-clippy.log`),
along with source-size and whitespace checks. No native-surface capability is
advertised yet; the decoder's tests are not an authenticated end-to-end proof.

### IOSurface capability import and allocation accounting

The Apple platform layer now owns imported IOSurface Mach send rights with RAII.
`SurfacePort::import` looks up the surface through the owned right, checks packed
BGRA format, non-planar layout, actual width/height/stride and full allocation
size against the admitted description, then creates a CoreVideo wrapper and binds
the Rust storage owner. The right is deallocated on success and rejection. Raw
right construction is unsafe and requires an actual owned receive result;
a JSON integer cannot be treated as that capability. The existing `mach2`
dependency supplies the task/right APIs; `objc2-io-surface` 0.3.2 is now an explicit
platform dependency. Both lockfiles updated dependency edges without changing
package versions.

The offer now includes `allocationBytes`, and reservation charges that full value,
not merely row-stride times height. Understated rows, overflow and oversized
allocations are rejected. This covers platform page/allocation padding that would
otherwise evade the process-wide budget.

Sixteen renderer tests passed (`native-surface-port-gpu-qualified.log`), including
import via a real Mach right, same-IOSurface identity, GPU color readback, storage
owner retirement, and rejection of mismatched dimensions/stride/allocation or
planar format. Thirteen offer/lease tests passed (`native-surface-allocation.log`).
Initial compilation exposed a missing IOSurfaceTypes feature in the test and a
deprecated libc task accessor; these were corrected using the existing mach2
API. The tests create/import the right within one process. They do not establish
cross-process authentication, right transfer/cancellation or producer ACK delivery.

Cross-process ticket handoff, negotiated stream wiring, actual lease binding from
the admitted offer, damage/resync, fallback and remote compression remain required.

Client/GUI all-target/all-feature Clippy passed (`native-surface-port-clippy.log`),
as did source-size and whitespace checks. A real native receipt snapshot contains
the importer among 1,760 inputs. No release or capability advertisement was made.

### One-use surface handoff join

`surface_handoff::Pending` joins an admitted offer to a separately received owned
native capability. It is scoped to one connection, bounded to eight entries,
rejects old sequences, matches the exact ticket, consumes a matching offer once,
and rechecks the committed pane before returning the offer/right to the importer.
A wrong ticket does not consume a legitimate pending offer. Replayed/unknown,
expired or replaced-pane handoffs drop their received rights; expired/replaced
offers also drop their storage reservation. Waiting offers expire after five
seconds on the existing transport worker tick.

Fifteen offer/lease/handoff tests passed (`native-surface-handoff.log`), including
wrong-ticket cleanup, one-use consumption, replay rejection, replacement during
handoff and timeout cleanup. The handoff tests use drop-observable Rust owners;
they do not prove native IPC receipt or authentication. The native receiver must
still supply genuinely owned OS rights through an authenticated endpoint, and the
result must be connected to `SurfacePort::import` and the producer ACK path.

Mach transport implementation must account for pseudo-receive ownership on failed
sends and destroy rejected received descriptors. A receive size bound alone does
not bound out-of-line payloads. The native transfer envelope must admit only the
intended capability and ensure all other rights/mappings are released. Relevant
platform reference: https://web.mit.edu/darwin/src/modules/xnu/osfmk/man/mach_msg.html
No Mach message receiver or capability advertisement is enabled yet.

Client all-target/all-feature Clippy passed (`native-surface-handoff-clippy.log`),
with source-size and whitespace checks passing as well. The authenticated native
receiver remains the next missing integration boundary, not a verified capability.

### Kernel surface-right receive boundary

The Apple platform layer now has a connection-scoped `surface_inbox::Inbox` with
one queued Mach message and nonblocking receive. It validates exact envelope size,
message ID, descriptor count/type/disposition, absence of reply/voucher rights,
ticket and advancing sequence. Rejected descriptors are destroyed through Mach;
partial-body errors also release any successfully received rights/mappings. Only
the selected send-right reference transfers into `SurfacePort`. Inbox destruction
releases the receive right and queued messages; the send reference has a separate
RAII owner. The endpoint is not published or discoverable by this module.

Seventeen platform/renderer tests passed (`native-surface-inbox-qualified.log`).
The new test sends real Mach messages between owned endpoints in one process and
checks empty polling, wrong-ticket rejection, one-use sequence and kernel send
reference counts before rejection, during accepted ownership and after release.
It uses an owned generic port to test right transfer; the separate IOSurface GPU
tests continue to verify actual surface import and drawing.

This does not yet prove authenticated cross-process setup. The test sender covers
only successful sends into an empty owned queue. Production send failures and
pseudo-receive cleanup, distribution of endpoint capabilities, joining received
rights to admitted offers, import/presentation and ACK transmission remain. The
fixed receive buffer and one-message queue do not by themselves bound hostile
out-of-line descriptors before rejection: endpoint capability distribution must
remain restricted, and that boundary requires qualification before enabling it.

Client/GUI all-target/all-feature Clippy passed (`native-surface-inbox-clippy.log`),
with source-size and whitespace checks. Native receipt enumeration includes the
receiver among 1,762 source inputs. No release or default launcher change occurred.

### Nonblocking native surface sender

`SendRight::try_send` now sends a copied surface capability with zero timeout and
interrupt reporting. It distinguishes kernel-queued, backpressured and interrupted
outcomes; none means producer retirement or presentation. Caller ownership remains
intact. Timeout/interruption pseudo-receive copies are destroyed, including the
returned destination reference. Other errors do not destroy the original send
buffer, because those cases either do nothing or destroy the kernel's copies.
The caller decides whether a superseded frame should be retried; the sender does
not automatically replay it. Native endpoint adoption requires explicit unsafe
ownership transfer from authenticated setup, not JSON port integers.

Nineteen platform/renderer tests passed (`native-surface-sender-gpu-qualified.log`).
They include 32 repeated queue-full attempts with unchanged kernel send reference
counts, receiver shutdown with a queued frame, repeated disconnected sends, and
successful sending after pressure clears. The GPU test now sends the actual
IOSurface right through the kernel inbox, drops the original outgoing right and
endpoint, imports the received right, verifies same-storage identity and pixels,
and retires its owner. This combined path still runs within one process.

The interruption cleanup branch follows the documented Mach ownership contract;
it was not independently fault-injected. Endpoint authentication/distribution,
cross-process qualification, admitted-lease binding, live stream negotiation,
producer ACK delivery, damage/resync and fallback remain unfinished. No native
surface capability has been advertised by the application.

Client/GUI all-target/all-feature Clippy passed (`native-surface-sender-clippy.log`),
with source-size and whitespace checks passing. Producers must keep submitted
storage immutable until its retirement ACK; a queued Mach message is not a reuse
fence. The current tests use immutable frames and do not qualify producer reuse.

### Cross-process IOSurface rendering qualification

The opt-in `native_surface_cross_process` platform test now spawns an owned
coordinator and a separate producer. The producer transfers an actual IOSurface
Mach right through `SendRight`; the coordinator receives it through `Inbox`,
imports it with the checked allocation geometry, renders it with Metal, and
compares every pixel. The producer keeps storage immutable until the coordinator
has dropped scene and renderer references and observed final storage-owner
release. Only then does the fixture send a retirement notice over its private
stdin pipe and require the producer to exit successfully.

The final opt-in run passed (`native-surface-cross-process-final-qualified.log`).
The default platform suite also passed: 19 passed, three opt-in/helper tests
ignored (`native-surface-cross-process-default-suite.log`). Helpers require their
coordinator environment marker, have bounded waits, and are killed/reaped by the
exact child handles owned by the fixture.

Earlier runs failed the cleanup assertion after successful rendering: the legacy
bootstrap API returned success with `MACH_PORT_NULL`, rather than an unknown
service. The final check requires either an absent name or a null endpoint after
coordinator exit. It does not claim that the name record was deleted. Because
legacy bootstrap registration leaves an inactive name record, this test is
explicitly opt-in and its registration mechanism must not become the production
endpoint setup. The default suite does not register these names.

This proves real cross-process capability transfer, pixel correctness and final
buffer-owner release on this host. The fixture's private pipe notice is not the
production daemon retirement protocol. Authenticated endpoint distribution,
admitted client-lease binding, live negotiation, producer ACK delivery,
damage/resync, fallback and remote compression remain unimplemented. No pixel
capability or new launcher default is enabled, and this run establishes neither
physical input latency nor packaged GUI performance.

### Live lossless raw-pixel compression

The daemon and Rust graphics path now negotiate bounded lossless compression for
raw RGB/RGBA chunks, with original-byte digest verification and raw fallback.
Both native capability issuance and the metadata helper offer bundles 113/114.
The [implementation and codec evidence](remote-compression/README.md) describe
compatibility, limits, the noisy-frame sampling decision and completed focused
checks. This is connected to the existing live graphics stream; it does not
enable the separate IOSurface transport or establish GUI/SSH performance parity.

### Native catalog persistence and cold history restoration

Completed Rust catalogs now persist bounded display metadata through the local
fleet preference owner. Cache records contain stable session keys and route
locators, never selection tokens, SSH targets, credentials or issued capabilities.
Invalid display records are skipped before submission. Timestamp-only changes do
not cause another write, and failed or cancelled writes are not replayed.

A fresh native actor can resolve recent history through these cached route
locators. It still rereads the saved machine registry, verifies the environment
pin, opens a fresh authenticated catalog and resolves the exact stable session
key before committing navigation. Conflicting cached aliases do not select an
arbitrary route. This does not implement concurrent fleet aggregation.

The owned real-SSH fixture passed with distinct local and remote daemons,
including reconnect, cross-machine navigation, preferences, visits, return to
Local, and a newly started actor restoring remote history from persistent data.
The source pane remained unchanged and all tracked cleanup checks passed.
Evidence: `native-cached-history-live-final.log` and
`native-cached-history-qualification.json` in the qualification directory.

The initial attempt stopped in cache preparation after its existing navigation
journey passed; it did not exercise the cold actor. The final fixture waits for
initial preference/cache acknowledgement and retains preparation diagnostics.
It passed the explicit `NATIVE_CACHED_HISTORY_VERIFIED` assertion.

The GUI default library suite passed with 3,073 tests and 11 ignored external
fixtures (`native-cached-history-full-suite.log`). GUI all-target/all-feature
Clippy, source-size checks and whitespace checks passed. These are actor and
protocol checks, not physical input or packaged GUI performance measurements.
The default launcher still uses the metadata helper. Concurrent fleet and alias
semantics, production native surfaces, and final packaged qualification remain.

### Rust environment alias grouping

Rust now implements the shared `fleet-environments.ts` display grouping rules:
verified environment and daemon generation join aliases, missing identity stays
route-scoped, and different generations remain separate conflicts even when one
route is offline. Selection of a display route prefers the ready current route,
then a ready preferred route, then another ready route, with deterministic offline
fallback. It does not transfer input authority or mutate route preference.

Native cached-history lookup uses this grouping. Equal verified aliases provide
one locator; a conflicting generation prevents a cached lookup even if the
conflicting alias has no matching session row. Registry reread, environment pin,
fresh catalog key resolution and live acceptance still precede history commit.
Observed live routes retain their existing precedence over cache hints.

This is not yet the concurrent fleet connection manager or its Home projection.
Those still require bounded concurrent catalog workers, saved-profile invalidation,
owned SSH teardown, and request-bound selection of another route. The packaged
launcher remains unchanged.

Validation: four client grouping tests, seven GUI navigation tests, the full
client library suite (540 passed, four ignored), and the full GUI library suite
(3,074 passed, 11 ignored) passed. Logs are `native-fleet-alias-client.log`,
`native-fleet-alias-navigation.log`, `native-fleet-alias-client-full.log` and
`native-fleet-alias-gui-full.log` in the qualification directory. These runs do
not exercise concurrent live alias connections or physical GUI input.
Client and GUI all-target/all-feature Clippy also passed
(`native-fleet-alias-clippy.log`), along with source-size and whitespace checks.

### Complete catalog results for native fleet workers

The native browser now requests one `FleetCatalog` result from its background
worker instead of sequencing individual session-list replies in the browser
actor. The result includes the captured identity, registrations and scoped
session rows. It gathers at most the first 32 server registrations and 4,096
sessions in total, matching the existing native limits. Offline registrations
remain display data and do not trigger session requests.

After gathering, the worker rereads the catalog and rejects changed owner identity
or registrations. Cancellation discards the operation and prevents subsequent
scan requests. Partial rows are not published. This is not a transaction across
session lists: each list remains an observation, and selecting/opening a session
still verifies its exact server scope. The extra final catalog verification is
metadata work outside the terminal input/render path; no latency improvement is
claimed from this change.

This operation is connected to the existing native GUI catalog path and supplies
the bounded per-machine result needed by the forthcoming concurrent fleet owner.
It does not itself introduce concurrent machine connections or change the
packaged launch default.

Validation passed: three new catalog worker tests (complete read-only result,
registration replacement during traversal, and cancellation), 543 client tests
(four ignored), and 3,074 GUI tests (11 ignored). The owned real-SSH journey also
passed with distinct real local/remote daemons, reconnect, saved-profile selection,
cross-machine navigation, preferences/visits, return to Local and cold cached
history restoration. Its source pane stayed unchanged and all tracked cleanup
steps passed. Evidence: `native-fleet-catalog-client-final.log`,
`native-fleet-catalog-client-full.log`, `native-fleet-catalog-gui-full.log`,
`native-fleet-catalog-live.log`, `native-fleet-catalog-qualification.json` and
`native-fleet-catalog-build-identity.json` in the qualification directory.
The first focused test run used an incorrect fixture response sequence and failed
identity parsing; the corrected fixture includes the existing identity requests.
These checks do not establish physical input latency or concurrent fleet behavior.
Client/GUI all-target/all-feature Clippy also passed
(`native-fleet-catalog-clippy.log`), with source-size and whitespace checks passing.

### Bounded Rust fleet catalog pool

The client now has a background-owner-only `FleetCatalogPool` for up to 65 routes
(Local plus 64 saved profiles), with at most four concurrent catalog operations.
Refreshes coalesce into one queued read per route, and queued work for a busy
route does not prevent another route using a free slot. Idle entries retain their
authenticated `CatalogSource` while dropping the catalog worker thread. No idle
poll starts network traffic, terminal streams or mutations.

Each insertion has a private incarnation UUID. Removal cancels the worker and
clears queued work before shutting down its exact source. Replacing a route gives
it a new incarnation; consumers must compare event incarnation with current
ownership before publishing selection tokens. Shutdown attempts every route and
retains failed shutdown ownership for an explicit retry. The pool must be called
and dropped on a background owner because SSH teardown may wait for its process.

This pool is not yet wired into the native browser's registry reconciliation,
Home groups or cross-route selection. It supplies bounded concurrent ownership;
it does not establish full fleet parity or justify changing the launch default.
Tests cover a held HTTP catalog alongside a completing peer, discarding the held
reply after removal, replacement incarnation, no idle IO, the four-operation
limit, the 65-route limit, and refresh queue coalescing.

Validation passed: three focused pool tests, the full client library suite
(546 passed, four ignored), all-target/all-feature client Clippy, source-size and
whitespace checks. Logs: `native-fleet-pool-tests-final.log`,
`native-fleet-pool-client-full.log` and `native-fleet-pool-clippy.log`. The pool's
concurrency tests use owned HTTP peers; concurrent real SSH lifecycle and GUI
publication remain to be exercised after integration.

### Registry reconciliation for background fleet catalogs

The Unix native client now wraps the catalog pool in `FleetRegistry`. It validates
saved registry data, includes Local while viewing a remote machine, excludes the
foreground route, and admits only enabled saved profiles. Label-only edits keep
the existing route incarnation. Target or expected-environment changes remove
the old source before creating a replacement. Disable/remove and invalid registry
data revoke background route visibility. Events are filtered against the current
route incarnation before delivery.

A failed source shutdown preserves pool ownership and marks cleanup pending;
reconciliation must retry that cleanup before adopting new routes. Invalidating
registry authority removes display ownership immediately, even if an OS cleanup
needs another attempt. This object remains background-owner-only, including drop.

Three focused lifecycle tests passed, covering label/target/pin changes,
disable/remove/foreground exclusion, invalid registry revocation and replacement
incarnations. These tests use lazily configured fixture sources and do not prove
live SSH shutdown failures. The pool's earlier HTTP concurrency tests remain the
network evidence for read/cancellation behavior. This registry layer is not yet
connected to the native browser's Home publication or cross-route selection.
Full client validation passed: 549 tests, four ignored; all-target/all-feature
Clippy, source-size and whitespace checks passed. Evidence:
`native-fleet-registry-tests.log`, `native-fleet-registry-client-full.log` and
`native-fleet-registry-clippy.log` in the qualification directory.

### Native Home background fleet integration

The native browser now reconciles the concurrent catalog registry with saved
machine changes and source switches. It polls only while catalog work is pending;
idle Home retains its existing notification-based wait. Home/Refresh requests also
refresh background catalogs. Registry loss invalidates those catalogs, and the
shared native app owner explicitly shuts down background sources before completing
quit, including when the foreground route has changed.

Home projection now includes background machine groups, authenticated alias
joining and generation conflicts. It enforces the combined publication limits
(64 groups, 512 session rows, 128 servers, plus existing per-group limits).
Disconnected rows carry no selection token. Tokens for unchanged rows remain
stable; changing a route incarnation, failing its catalog or removing its row
retires the corresponding tokens. Known conflicts disable new selection in the
current group as well as background groups.

Clicking a background session carries only its machine locator and stable key.
The actor rereads the current saved registry, opens a fresh catalog and resolves
that exact key before opening a terminal. Switching to Local likewise rediscovers
the private local owner. Background metadata never grants terminal input authority.

Remaining fleet work includes background preference controls and server creation,
retry/disconnect behavior, background route recovery and live catalog invalidation.
The default launcher still uses the metadata helper. This integration does not
establish physical input latency, native surface completion or packaged parity.

Validation: 47 focused native-browser tests passed (three external fixtures
ignored), followed by the full GUI library suite: 3,077 passed, 11 ignored.
The owned real-SSH journey passed with a new assertion that selects a remote
session directly from a background Home row and reaches an input-ready terminal.
Reconnect, cross-machine navigation, preference/visit persistence, return to Local
and cold history restoration also passed. Source-pane preservation and all tracked
cleanup checks passed. Evidence: `native-fleet-home-tests-final.log`,
`native-fleet-home-full.log`, `native-fleet-home-live.log`,
`native-fleet-home-qualification.json` and `native-fleet-home-build-identity.json`.
The live harness now requires `NATIVE_BACKGROUND_FLEET_SELECTION_VERIFIED` in this
mode; its receipt records `nativeBackgroundFleetSelection: true`.

The first compile caught the new error variant's missing test diagnostic arm and
unnecessary type qualifications. Those were fixed before qualification. A later
Clippy-only cleanup collapsed a nested `if` without changing its condition or
body and moved a method before the test module. The archived test-binary hashes
identify the qualified build before those style edits. No actual desktop input, render latency or memory plateau is claimed here.
Client/GUI all-target/all-feature Clippy passed after the style cleanup
(`native-fleet-home-clippy-qualified.log`). Source-size, whitespace and SSH harness
syntax checks passed. Linux/Windows cross-checks and actual desktop qualification
were not run for this integration yet.

### Explicit background route recovery

Home/Refresh now records intent and waits for the operation's fresh local saved
registry read before refreshing background catalogs. Failed routes are retired
and recreated under a new pool incarnation; healthy routes retain their sources.
A retry carries the expected old incarnation, so a delayed retry cannot reset a
replacement route. A machine disabled or retargeted in the reread registry is
handled by reconciliation before retry admission. This does not add idle polling
or automatic reconnection loops.

The client recovery tests cover stale retry rejection and failed local discovery
followed by a replacement owner. The first fixture incorrectly expected local
refresh to reuse a cached client; local workers already rediscover their owner.
It was corrected to exercise an invalid owned record followed by a valid new
endpoint. Cached SSH transport recovery requires the separate real-SSH test.

The SSH harness now has an explicit owned-background-tunnel interruption handshake.
It verifies process identity and child ancestry before signaling that tunnel,
waits for exit, and writes an owned acknowledgement file. The GUI test observes
Disconnected, requests another Home refresh, requires a selectable recovered row,
and then opens that session. It retains the existing foreground reconnect and
history checks. No unrelated process is signaled.

Recovery qualification passed: 26 focused client fleet tests, 551 client library
tests (four ignored) and 3,078 GUI library tests (11 ignored). The real-SSH harness
passed the new background tunnel interruption/recovery/selection check as well as
its foreground reconnect, cross-machine navigation, preference/visit and cold
history checks. Its receipt records `nativeBackgroundFleetRetry: true`. Source
pane preservation and all tracked cleanup checks passed. Evidence:
`native-fleet-retry-client-final.log`, `native-fleet-retry-client-full.log`,
`native-fleet-retry-gui-full.log`, `native-fleet-retry-live.log`,
`native-fleet-retry-qualification.json` and `native-fleet-retry-build-identity.json`.
Dedicated Retry/Disconnect controls, automatic background recovery, broader fleet
parity, native surfaces and physical/packaged performance qualification remain.
Client/GUI all-target/all-feature Clippy passed (`native-fleet-retry-clippy.log`),
as did source-size, formatting, harness syntax and whitespace checks. These are
macOS actor/protocol results; cross-platform and physical GUI checks remain open.

### Preferences on background Home groups

The native browser now projects favorites, active-session markers and collapse
controls over the final bounded fleet publication, including background groups.
Each group uses its own verified environment key (or route key when unavailable
or conflicted), instead of applying the active machine's key to every group.
Known conflicts do not expose preference mutation controls.

Published controls reuse opaque tokens for unchanged kind/key pairs within the
same preference revision. Controls absent from the final publication are removed
from the action table. Read/write transitions and owner loss still revoke tokens,
and all mutations continue through the separately verified local preference owner;
background SSH metadata does not become preference-write authority.

The owned live journey now exercises a background favorite, rejects a stale
pre-write token, collapses the remote group while Local remains expanded, then
restores both preferences before its tunnel recovery and session-selection checks.
It never attaches a terminal merely to edit these background preferences.

Validation passed: 3,080 GUI library tests (11 ignored), including independent
collapse-key projection and removal of unpublished controls. The owned real-SSH
journey passed its background preference assertions and all existing background
retry/selection, foreground reconnect, navigation and history checks. Its receipt
records `nativeBackgroundFleetPreferences: true`; source-pane preservation and all
tracked cleanup checks passed. Evidence: `native-fleet-preferences-gui-full.log`,
`native-fleet-preferences-live.log`, `native-fleet-preferences-qualification.json`
and `native-fleet-preferences-build-identity.json` in the qualification directory.
The live helper module is Unix-gated consistently with its SSH test caller.
Native surfaces, remaining fleet controls/invalidation and packaged/physical
qualification remain unfinished; no launch default changed.
Client/GUI all-target/all-feature Clippy passed
(`native-fleet-preferences-clippy.log`), along with source-size, formatting,
harness syntax and whitespace checks on this macOS host.

### Selecting background servers for session creation

Background online servers now publish opaque selection tokens bound to the route
incarnation and exact server generation, alongside session tokens. Server and
session destinations are distinct typed continuations, so a token cannot be used
as the other kind of operation. Missing, failed, conflicted or omitted rows do not
retain server-selection authority.

A background server click rereads the saved route and obtains a fresh catalog.
Only an online server with the same ID and generation becomes the creation target;
a generation change reports that the server must be selected again. Choosing a
server does not open a terminal or create a session. An explicit subsequent create
command uses the existing one-shot native operation path and uncertainty handling.

The owned live journey selects a background remote server, verifies the prepared
machine/server/generation, explicitly creates a scratch session there, and returns
to Local before the existing background retry/session-selection sequence. This
fixture is guarded by the owned-scratch mutation marker. Server token tests cover
generation changes, route replacement and disconnected-route revocation.

Validation passed: 3,081 GUI library tests (11 ignored), client/GUI
all-target/all-feature Clippy, and the owned real-SSH journey. The latter verified
background server creation, background preferences and recovery, foreground
reconnect, navigation, visits and cold history restoration. Source-pane
preservation and all tracked cleanup steps passed. Evidence is recorded in
`native-fleet-server-gui-full.log`, `native-fleet-server-clippy.log`,
`native-fleet-server-live.log`, `native-fleet-server-qualification.json` and
`native-fleet-server-build-identity.json` in the qualification directory.

The initial live run stopped at the deliberate background tunnel interruption;
its log and cleanup receipt are retained. A diagnostic rerun passed. Inspection
identified that the process tracker's coalesced periodic scan can predate a newly
created tunnel. Both interruption probes now await that scan and a fresh scan
before requiring exact ancestry and incarnation proof. The final live run passed
with this harness correction. The original failure had no detailed diagnostic,
so that race is not conclusively established as its cause.

These are macOS actor/protocol checks, not physical keyboard or GPU measurements.
Native surface production wiring, remaining fleet controls/invalidation,
cross-platform checks and packaged/physical qualification remain open. The
Node metadata helper remains the default launcher.

### Background connection controls in the native owner

The Rust catalog registry now supports explicit disconnect without changing a
saved profile or stopping a daemon/session. It retires only its own background
source, clears pending reads, and preserves an inert route with a new incarnation.
Ordinary catalog refresh and label-only registry edits leave that route stopped.
An explicit retry creates a fresh source/incarnation; removed, disabled or
retargeted profiles revoke the previous controls.

Home publishes typed opaque disconnect/retry controls for background routes.
Commands require the current Home request and foreground state, reread the local
saved-machine registry, then apply only to the captured incarnation after
reconciliation. Navigation cancels the pending control. No terminal is attached
as a side effect. Selected-route controls and automatic background invalidation
remain separate unfinished work.

The owned SSH journey now disconnects and retries a background machine after its
server-creation test, before exercising interruption recovery. Registry tests
cover inert refresh, rename, stale controls and retargeting; projection tests
cover typed controls and token revocation. Validation passed: 553 client tests (4 ignored), 3,082 GUI tests (11 ignored),
and the real-SSH journey including background disconnect/retry and all previous
recovery/navigation checks. Source-pane preservation and cleanup passed.
Evidence: `native-fleet-controls-full.log`, `native-fleet-controls-live.log`,
`native-fleet-controls-qualification.json` and
`native-fleet-controls-build-identity.json` in the qualification directory.
Physical GUI and cross-platform qualification have not been run for this change.
Client/GUI all-target/all-feature Clippy also passed
(`native-fleet-controls-clippy.log`), along with source-size, harness syntax,
formatting and whitespace checks.

### Disconnecting the selected remote machine from Home

The native Home catalog now exposes a selected-remote disconnect control, fenced
by a source epoch that changes on every successful source replacement. A command
rereads saved profiles before acting. Retargeting, disabling or removing the
selected profile cancels the pending control; fresh registry state is installed
before any source-switch reconciliation.

Disconnect replaces the foreground source with Local, retiring only the owned
SSH transport. The former remote is registered as an inert background route
before catalog polling resumes, so returning to Home cannot immediately reopen
its connection. Its background retry control provides the explicit reconnect
path. Remote daemon and terminal processes are not stopped by this operation.

Projection coverage checks source replacement revokes selected controls. The
private real-SSH journey now returns from its created remote session to Home,
disconnects the selected machine, retries it in the background, and then proceeds
through the existing background controls and interruption recovery checks.

Connection controls preempt background preference reads/visit-cache writes using
the existing no-replay cancellation path. They also retire an in-flight read-only
registry refresh before requesting their own fresh read. Explicit registry or
preference mutations are not preempted. Focused actor tests cover the read/read
preemption cases so connection clicks are not silently lost behind routine Home
maintenance.

Validation passed: 3,085 GUI library tests (11 ignored), client/GUI
all-target/all-feature Clippy, and the real-SSH journey with
`nativeSelectedDisconnect: true`. The source pane remained unchanged and every
tracked cleanup step passed. Logs/receipts are
`native-selected-disconnect-full.log`, `native-selected-disconnect-clippy.log`,
`native-selected-disconnect-live.log`,
`native-selected-disconnect-qualification.json` and
`native-selected-disconnect-build-identity.json` in the qualification directory.

The first SSH run verified the new controls, then failed confirming the deliberate
background tunnel exit: the kernel witness returned status 65 during teardown.
That failure and successful cleanup are retained in
`native-selected-disconnect-live-initial.log` (fixture `nssh-WIshkg`). The harness
now waits within its existing five-second exit budget through this refusal,
without treating refusal as death or sending another signal. Three deterministic
harness tests verify later positive death confirmation, persistent refusal/live
identity timeout, and propagation of other witness errors
(`native-selected-disconnect-exit-tests.log`). The final SSH run passed with this
correction. No production identity policy was weakened.

Physical GUI input, packaged release, cross-platform gates, remaining live catalog
invalidation and production native pixel surfaces remain unqualified or unfinished.
The default launcher still uses the Node metadata helper.

### Native catalog notification boundary and unchanged-publication suppression

The native client now has a bounded semantic catalog event reducer for the
existing `/ws/events?mode=semantic` protocol. Its expected daemon identity must
come from authenticated discovery. Hello comparison covers protocol, product,
instance, start time and environment; duplicate hello, malformed/oversized input
or unavailable subscription barriers retire the lane. The subscription requests
only the global workspace catalog, with legacy delivery disabled and no
session interests. Fleet-catalog interests would activate unnecessary agent polling. The initial installation barrier requests a fresh catalog to
close the catalog-read/subscription race. Duplicate/old events are ignored;
journal gaps and snapshot-required events invalidate for a new authenticated
read. Notification payloads never provide session-selection authority.

This reducer is not yet wired to a production socket. The remaining integration
must reuse same-socket identity proof before transmitting remote credentials,
close the owned socket on cancellation, fence notifications by route incarnation,
coalesce refresh work, and wake the parked browser actor. The existing TUI owner
also uses a five-second fallback for changes from other server owners; a native
fallback needs the same bounds without reconnecting explicitly stopped routes.

The current background catalog path now compares complete bounded results before
publishing. Identical reads and repeated failures do not repaint Home; a changed
catalog or recovery from a failed route still publishes. Stale-incarnation results
remain rejected. This is correctness/publication-count behavior, not a measured
GUI speedup.

Validation: 3,086 GUI tests passed (11 ignored), including unchanged-result,
rename, repeated-failure, recovery and stale-incarnation cases. The final client
run passed 560 tests (4 ignored), including seven catalog-event tests. The last
client-only adjustment enforces required nullable snapshot cursor fields and
rejects a present-null environment identity; the unwired reducer is not exercised
by the GUI suite. Logs: `native-catalog-events-full.log` and
`native-catalog-events-client-final.log` in the qualification directory.
No live push subscription, packaged GUI, physical timing or cross-platform
qualification is claimed for this boundary work.
Client/GUI all-target/all-feature Clippy passed on the final sources
(`native-catalog-events-clippy.log`); source-size, formatting and whitespace
checks also passed.

### Background catalog sockets

The notification reducer is now connected to a single-generation socket worker
and enabled in the native background fleet registry. Each lane discovers its
captured owner, matches the expected catalog instance/environment, proves the
identity of its exact TCP socket without credentials, then upgrades that socket
with a sensitive Authorization header. Local record/remote tunnel ownership is
rechecked before upgrade. URLs remain literal loopback; no credential is put in
a URL or published state.

Cancellation shuts down the exact owned socket, clears the coalesced mailbox and
prevents later notifications. Startup, read/write and heartbeat waits are bounded;
worker failure is sticky and reconnect remains an explicit owner decision. The
pool permits one watch per route (at most 65), preserves its four-operation catalog
limit, coalesces invalidations, and wakes the parked actor rather than making idle
watch sockets count as continuous polling work. Removing/disconnecting a route
cancels its watch before retiring its source. Failure retires pending reads and
publishes a fenced unavailable result. Successful observer installation triggers
one fresh read to close the initial read/subscribe race; identical reads remain
suppressed by the publication comparison.

Automatic background reconnect is qualified below. These background watches
do not complete the metadata-helper replacement or change the default launcher.

The first real-SSH watch run observed creation but timed out waiting for removal
of an externally managed scratch session. The shared TUI explicitly supplements
root notifications with a five-second full scoped-catalog fallback, because root
push does not cover every server owner. The native watch now does the same while
healthy, resetting the fallback deadline after push invalidation and never
reconnecting a failed/stopped lane. Root interest is limited to workspace-catalog;
fleet-catalog would additionally activate daemon agent-status polling, which is
unnecessary for this Home session catalog. A socket test verifies the idle fallback
on one connection. The failed run is retained in
`native-catalog-watch-live-push-only.log` (`nssh-nn6qwq`): process, file, daemon and
fleet cleanup steps passed, but the process-capture audit refused a changed-parent
observation, so its overall cleanup receipt is false. It is not qualification.

Final validation passed: 564 client tests (4 ignored), 3,086 GUI tests (11 ignored),
and the private real-SSH journey. That journey created and removed a scratch
session externally and observed both changes in the background Home group without
issuing a refresh command (`nativeCatalogUpdates: true`). It then observed tunnel
failure before manual recovery and passed the existing disconnect, retry,
navigation, preference and cold-history checks. Source-pane preservation and all
cleanup audit steps passed (`nssh-7uuByK`). Evidence:
`native-catalog-watch-final-tests.log`, `native-catalog-watch-live.log`,
`native-catalog-watch-qualification.json`, and
`native-catalog-watch-build-identity.json` in the qualification directory.
These checks prove combined push/fallback behavior, not push-only observation of
all server owners or physical input/paint performance.
Client/GUI all-target/all-feature Clippy passed
(`native-catalog-watch-clippy.log`). The SSH-only endpoint export and descriptor
projection are explicitly Unix-gated; that final declaration-only guard does not
change the tested macOS code path. Cross-platform checks remain outstanding.
The test callback's fixed tungstenite HTTP error type has a narrowly scoped
`result_large_err` allowance; production error variants remain bounded/boxed.
Source-size, formatting, harness syntax and whitespace checks passed.

### Selected Home catalog observation

The selected machine now uses an authenticated catalog watch and a separate
background read lane while Home is visible. Hiding Home cancels reads and closes
the watch; resuming reinstalls observation and refreshes after subscription.
Foreground operations preempt reads. Manual refresh and owner replacement reset
the observer before resetting the shared source. These reads never reset the
interactive transport or replay terminal actions.

Unchanged snapshots are suppressed. Changed catalogs preserve session selection
tokens for the same server generation and live session; server-generation changes
revoke old tokens and clear invalid selection. Watch/read failures show a fenced
unavailable state and require refresh to reconnect.

Validation: 3,089 GUI tests passed (11 ignored). The private real-SSH journey
observed selected-machine session creation and removal without a refresh command,
retained the existing session token, and passed background updates, connection
controls, navigation and history checks. Source-pane preservation and all cleanup
audits passed (`nssh-A422Gu`). Evidence: `native-selected-catalog-tests.log`,
`native-selected-catalog-live.log`, `native-selected-catalog-qualification.json`,
and `native-selected-catalog-build-identity.json` in the qualification directory.
Physical input was not tested. Default launcher migration, production native
surfaces and final packaged performance/memory qualification remain unfinished.

### Bounded automatic background recovery

Transient background catalog failures now schedule at most three consecutive
read-only recovery attempts, delayed by one, two and four seconds. The native
actor sleeps until the next deadline; healthy idle routes add no polling timer.
Recovery runs only with foreground Home visible and no foreground operation.
Every attempt resets local registry discovery and waits for a fresh authenticated
registry result before replacing the captured background source. Removed, disabled,
retargeted, repinned and explicitly disconnected routes invalidate pending retries.
Manual controls take precedence. Successful catalog reads reset the attempt budget.

Authentication, identity, record-security and protocol errors do not automatically
retry. Abrupt WebSocket EOF without a closing handshake is the specific protocol
exception treated as a transient connection loss. Recovery never replays mutations
or resets the selected terminal source.

Final validation passed: 564 client tests (4 ignored), 3,094 GUI tests (11 ignored),
and client/GUI all-target/all-feature Clippy. The real OpenSSH fixture interrupted
the owned background tunnel, observed disconnection, and recovered the session
selection at the same Home request without sending a refresh command
(`nativeBackgroundAutoRecovery: true`). Existing explicit disconnect/retry,
catalog updates, navigation, preferences and cold-history checks also passed.
Source-pane preservation and every cleanup audit passed (`nssh-a5fimL`). Evidence:
`native-fleet-auto-recovery-qualified-tests.log`,
`native-fleet-auto-recovery-clippy-final.log`,
`native-fleet-auto-recovery-live.log`,
`native-fleet-auto-recovery-qualification.json`, and
`native-fleet-auto-recovery-build-identity.json` in the qualification directory.

The initial production check exposed a test-only WebSocket dependency in GUI
error classification. Classification now lives in the client package; the initial
failed log is retained as `native-fleet-auto-recovery-clippy.log`. Formatting,
source-size, harness syntax and whitespace checks passed. No physical input,
packaged performance, cross-platform or production surface qualification is
claimed. The metadata helper remains the default launcher.

### Native retained session tab navigation

The native owner now retains up to eight session tabs with opaque action tokens.
Targets keep the machine, authenticated catalog identity, server generation and
live session identity; they retain no terminal capability or SSH credentials.
Current catalog availability and labels can change without rotating a tab's
action tokens. Commands are request/revision/foreground fenced and replayed
request numbers are rejected.

Activation rechecks the saved registry and catalog, including same-machine
activation, before opening an exact target. Source switches preserve only the
matching pending continuation; readiness commits the active tab. Closing a tab
does not kill the tmux session, and closing the active tab returns Home.
Activity/unread badges still depend on the remaining native agent-observation
migration. The launcher remains on the helper path; native tabs alone do not
complete that migration.

The final GUI suite passed 3,098 tests (11 ignored). The private real-SSH journey
opened a retained remote tab from Local Home, confirmed active attachment with
restored scrollback, then closed the tab and confirmed its tmux session remained
in the catalog. Existing recovery, disconnect, catalog, preferences, navigation
and cold-history checks passed; source-pane preservation and all cleanup audit
steps passed (`nssh-cldQij`). Evidence: `native-tabs-tests-final.log`,
`native-tabs-live-final.log`, `native-tabs-qualification.json`, and
`native-tabs-build-identity.json` in the qualification directory.

The first live run (`native-tabs-live.log`, `nssh-DO0DkB`) passed cleanup but timed
out because its assertion required immediate typing in a session with restored
scrollback. The corrected test requires confirmed tab attachment and either live
input or restored history; restored history must keep typing disabled. Production
scrollback behavior was preserved. The initial Clippy run passed before the added
tests; a subsequent style-only nested-if error was corrected. Physical input,
agent activity badges and packaged performance remain unqualified.

Final client/GUI all-target/all-feature Clippy passed (`native-tabs-clippy-qualified.log`).
Formatting, source-size, harness syntax and whitespace checks passed.

### Native managed local setup

The Rust client now resolves the fixed managed installer layout without PATH
search or process launch. It verifies installer/release markers, canonical paths,
regular owner-owned files, executable runtime, package identity and the same
qualified CLI version allowlist as the helper. Private file identities are
rechecked before both version verification and the explicit
`update --daemon --json` invocation. Output is bounded, waits are bounded to
15 seconds per process/20 seconds overall, and cancellation kills/reaps only the
owned CLI waiter. A detached daemon elected by the CLI may survive cancellation.
The child uses the inspected home and excludes Node injection environment values.

The GUI has an owned background setup worker, an availability offer on local
discovery failure, and explicit setup command handling. Request/source changes,
focus loss and shutdown cancel work and discard stale replies. Success triggers
fresh authenticated discovery, rather than granting authority from CLI output.
Only the ordinary managed-home daemon path can offer setup; custom runtime
namespaces remain explicit CLI workflows. Command dispatch was split into its
own module to keep source files below the repository's size limit.

Validation: 570 client tests (4 ignored) and 3,101 GUI tests (11 ignored) passed.
Private fake-managed-install fixtures exercise exact commands, version/identity
changes, symlink/version refusal, output limits, waiter cancellation, read-only
offers, explicit execution in the inspected home, late-result cancellation and
shutdown. The existing real-SSH journey also passed, preserving source panes and
all cleanup audit steps (`nssh-bhl8R0`). This SSH regression run does not exercise
actual managed daemon bootstrap. Evidence: `native-local-setup-tests.log`,
`native-local-setup-live.log`, `native-local-setup-qualification.json`, and
`native-local-setup-build-identity.json` in the qualification directory.

Actual packaged setup/daemon-start qualification, default-local session creation,
agent observation/actions, remaining helper command migration, native surface
production integration and packaged physical performance/memory checks remain.
The default launcher still uses the Node metadata helper.

Client/GUI all-target/all-feature Clippy passed (`native-local-setup-clippy-final.log`);
formatting, source-size and whitespace checks passed.

### Native default-local session creation boundary

The Rust client/catalog worker now supports read-only local creation proofs,
single-use default-server creation, and post-create owner verification. Proofs
retain private record identity and daemon generation; clones share an atomic
consumption flag. Only a verified LocalDaemon can mint/use a proof, and the worker
rejects remote authority before any creation traffic.

Creation rechecks the owner and absence of online servers, then sends exactly one
`workspace.session.create` owner action with an operation ID. It does not guess a
server scope, invoke a CLI, or launch tmux. Receipts require the exact operation
and daemon identity. A transport/cancellation/validation failure after submission
is classified as uncertain; the consumed proof cannot submit again. Post-create
verification allows servers to have appeared while still requiring the same owner.

The client suite passed 576 tests (4 ignored), including local socket tests for a
successful single POST, a server appearing between offer and activation, and a
lost response with no replay. Concurrent clones have one claim winner. Evidence:
`native-local-session-client-final.log` in the qualification directory. The first
fixture run failed because macOS accepted sockets inherited nonblocking mode;
`native-local-session-client-tests.log` is retained and the fixture now explicitly
uses blocking accepted sockets with read deadlines.

This is the client/worker boundary, not completed GUI integration. Home still
needs to publish/retire the creation action, handle uncertain outcomes, verify the
created owner's catalog, and select the returned session without guessing its
server. Real-daemon creation and packaged GUI qualification remain outstanding.

Client/GUI all-target/all-feature Clippy passed (`native-local-session-clippy.log`).
Formatting, source-size and whitespace checks passed. No launcher change or release.

### Native default-local creation in Home

The opt-in native Home path now requests a private, single-use local creation
proof when its authenticated catalog has no online server. It publishes an action
only for foreground local Home. Activation checks the current request and action,
validates the name, retires background read work, and submits one creation action.
Focus loss or navigation retires the offer; cancellation after submission keeps
an uncertain operation rather than replaying creation.

After a receipt, the local worker verifies the captured owner before and after a
fresh catalog read. Home requires the receipt's daemon identity, exactly one
matching live session, and its online server scope before opening that session.
Missing, duplicate, or replaced identities remain unavailable and uncertain.
An empty local catalog also initializes saved-machine discovery, so a first local
session does not prevent access to existing remote profiles.

This is integration in the opt-in native actor. It does not change the default
launcher or establish packaged first-session creation, physical input latency,
or production native surface readiness. Those qualifications remain outstanding.

The first real-daemon discovery regression exposed a foreground server-selection
command being ignored during a read-only saved-machine registry refresh
(`native-local-creation-discovery-live.log`). The actor now lets supported
foreground actions retire that read, while leaving registry mutations protected.
A dedicated server-selection regression test covers the same pending-read path.

Final verification: 576 client tests passed (4 ignored), 3,107 GUI tests passed
(11 ignored), and client/GUI all-target/all-feature Clippy passed. The repeated
real-daemon discovery regression passed session/window creation, authenticated
catalog selection, programmatic input and history restoration with the source
pane unchanged. This uses an existing isolated server and does not qualify the
new no-server first-session path against a real daemon. Evidence is recorded in
`native-local-creation-qualification.json`, `native-local-creation-build-identity.json`,
`native-local-creation-gui-recheck.log`, `native-local-creation-clippy-final.log`,
and `native-local-creation-discovery-live-final.log` in the qualification directory.
The verified temporary CLI copy was removed after the harness completed cleanup.

### Native terminal topology metadata

The native metadata actor now consumes authenticated-controller topology notices
instead of ignoring them. Pane choices retain the exact issued inventory while
receiving native display names, window identities, grouping, and topology order.
The actor checks attachment ID, request, daemon generation, live session, selected
pane, presence revision, foreground state and workspace surface. Partial,
duplicate or foreign pane inventories cannot replace the published roster.

Display labels match the helper's control-character cleanup, fallback and 512-byte
UTF-8 bound. Identical projected choices do not republish metadata, even if the
controller has delivered another topology notice. Geometry and terminal cells
remain owned by the existing native terminal path. This does not change initial
pane-selection policy or the default launcher.

The GUI suite passed 3,111 tests (11 ignored), and client/GUI all-target/all-feature
Clippy passed. The real-daemon discovery journey now requires native window
identity and label on every pane before input begins; it passed along with
session/window creation and history restoration. Evidence:
`native-topology-metadata-tests.log`, `native-topology-metadata-clippy.log`,
`native-topology-metadata-live.log` in the qualification directory. These are
programmatic actor/daemon checks, not physical GUI latency measurements.

The real OpenSSH journey also passed with the native label requirement, including
reconnect, cross-machine navigation, retained tabs, catalog updates and bounded
background recovery. Cleanup passed for the isolated `nssh-dalD3S` environment;
source panes were unchanged. Evidence: `native-topology-metadata-ssh-live.log`,
`native-topology-metadata-qualification.json`, and
`native-topology-metadata-build-identity.json`. The verified temporary CLI copy
was removed. Agent observation/actions, other helper commands, production native
surfaces and packaged correctness/performance qualification remain outstanding.

### Rust agent-observation reader

The client and catalog worker now expose read-only observations from the existing
server-scoped application-shell endpoint. Reads include the exact live-session
query and are bracketed by session/catalog observations requiring the same live
ID and workspace. Existing local/SSH ownership and cancellation checks remain in
force; the operation never opens/adopts a session or issues an interactive lease.

The bounded projection retains activity, attention, harness, team context and
correlated pane/window/native-lifetime identities. It validates the outer server
scope, strict agent and terminal records, unique inventories and agent bindings,
active-resource consistency, positive canonical native birth IDs, and endpoint
scope/workspace/pane agreement. Unavailable or unattached rows gain no native or
interaction identity. Unrelated shell UI fields are ignored rather than retained;
this decoder is an agent-observation projection, not validation of the entire
application-shell UI document. Observed identities are not control authority.

The client suite passed 583 tests (4 ignored). Socket fixtures prove authenticated
GET-only traffic, encoded workspace/live-session targeting, rejection after a live
session changes and cancellation stopping further reads. Populated synthetic
rosters cover identity and bounds checks. The isolated local daemon test also
reads an actual empty roster through the catalog worker. GUI scheduling,
publication, admission and agent actions are not connected yet.

Client/GUI all-target/all-feature Clippy passed after two collapsible-if fixes;
the initial failed lint log is retained. The real OpenSSH client journey also
read an actual empty roster and completed cleanup (`nssh-rWyNQu`), preserving the
source pane. Evidence: `native-agent-observation-client-recheck.log`,
`native-agent-observation-clippy-final.log`, `native-agent-observation-local-live.log`,
`native-agent-observation-ssh-live.log`, `native-agent-observation-qualification.json`,
and `native-agent-observation-build-identity.json` in the qualification directory.
The verified temporary CLI was removed. No GUI roster, launcher change, packaged
performance result, or full research completion is claimed by this boundary.

### Bounded native agent-observation batches

A reusable Rust observation pool accepts at most 32 explicitly scoped session
requests and runs at most four unfinished workers. Replacing a batch immediately
revokes its publication epoch and queued work. Canceled workers retain their
concurrency slots until their actual thread exit, so refresh churn cannot grow
parallel network work. The caller retains source lifetime: observation cancellation
never resets shared SSH authority or shuts down a daemon/terminal source.

Catalog workers now return nonblocking retirement receipts. A completion guard
sets the receipt on both normal exit and unwinding. The observation pool validates
returned scope/live-session/workspace against the submitted request, associates
results with the batch epoch and private request key, and never retries a read
within the batch. Invalid replacement input leaves the current batch intact.

The client suite passed 586 tests (4 ignored). One socket fixture holds four
identity reads open while replacing the batch 100 times, checks that no fifth
connection appears, then releases the exact workers and verifies all stale
results are discarded. Other tests cover session limits, duplicate keys and
bounded completion of 32 independent read failures. This pool is not yet connected
to GUI roster publication or agent actions; its owner must persist across refresh
and navigation so retirement slots continue to be accounted for.

The isolated real-daemon client journey also completed one successful pooled
observation and waited for its worker retirement, with the source pane unchanged.
Client/GUI all-target/all-feature Clippy passed. Evidence:
`native-agent-pool-tests-final.log`, `native-agent-pool-clippy.log`,
`native-agent-pool-local-live.log`, `native-agent-pool-qualification.json`, and
`native-agent-pool-build-identity.json` in the qualification directory. The
verified temporary CLI was removed after the harness completed cleanup. GUI
observation scheduling, presentation/actions, production native surfaces and
packaged qualification remain unfinished; the default helper launcher is unchanged.

### Native GUI agent roster and identity-bound selection

The native local/SSH owner now feeds Home and workspace agent rosters from the
bounded Rust observation pool. It retains retiring workers across navigation,
limits observation to 32 sessions and publication to 256 rows, suspends reads
while hidden, and refreshes visible observations every five seconds. Activity,
attention, harness and team context use the existing GUI roster presentation.
This is selected-source observation; cross-machine aggregation and additional
agent workflows remain unfinished.

Opening a row requires its private observation-batch key, a revision at or after
its first publication, the current foreground request and the current route.
Unrelated partial results preserve an unchanged row's selection token; refresh,
scope changes and hiding revoke it. An isolated live test caught the original
strict-latest-revision race: workspace selection passed but Home selection was
dropped when another session's observation arrived. The same test passes with
the per-row publication fence.

The client rechecks the captured catalog identity and the agent's exact pane and
native lifetime/endpoint before and after explicit session admission. It then
requires the selected pane in fresh inventory. Changed identities never fall back
to another pane or replay admission. Socket tests cover a changed identity before
admission (zero writes) and after admission (one write, no capability request).

Validation: 589 client tests and 3,115 GUI tests passed (4 and 12 ignored). An
earlier full run hit an unrelated upload-source test timeout; the retained full
rerun passed. The populated local daemon fixture opens the exact agent pane from
both workspace and Home. The real OpenSSH GUI journey passed with cleanup
(`nssh-IaM2gS`), including native roster observation and existing terminal/session,
fleet, reconnect and history checks. These are programmatic GUI-owner tests, not
physical input measurements. The default Node helper launcher, production native
surface integration and final packaged qualification remain unchanged/unfinished.

All-target/all-feature client and GUI Clippy passed after a boolean simplification
with identical semantics. Test binaries precede that lint-only rewrite; the receipt
records this distinction. Evidence: `native-agent-gui-selection-tests-final.log`,
`native-agent-gui-local-live-recheck.log`, `native-agent-gui-ssh-live.log`,
`native-agent-gui-selection-clippy-final.log`, `native-agent-gui-qualification.json`
and `native-agent-gui-build-identity.json` in the qualification directory. The
hash-verified temporary CLI was removed after both live harnesses completed.

### Native appearance ownership

The opt-in Rust catalog owner now loads and saves local appearance preferences,
resolves system light/dark events and serves the existing native theme picker.
A generated catalog embeds both system variants and every canonical preset from
`resolveNativeAppearance`; no Node process resolves colors at runtime. The
headless bridge gate, native release build wrapper and local app assembler check
catalog parity. The palette license is retained next to the catalog and included
in supplemental app notices.

Appearance belongs to the local GUI owner across SSH route changes. Publication
reprojects it after Home/error catalog resets. Loading and atomic save run on the
catalog actor, never on the UI/terminal input thread. Saves reread raw JSON and
retain unrelated fields, use a private creation-owned temporary file, and reject
observed concurrent replacement. This is not a cross-process transactional lock.
Failed writes leave the applied theme unchanged and expose only a generic error.
Malformed/oversized files are not overwritten. Explicit `TMUX_IDE_CONFIG` is
honored; custom records/namespace overrides without an explicit config remain
read-only rather than falling back to personal state. Full namespace-resolution
parity remains a follow-up before the native launcher becomes the default.

Validation passed: 3,120 GUI tests (13 ignored), all-target/all-feature client/GUI
Clippy, five shared appearance tests, generated palette parity, and 13 build
receipt/launcher tests. The isolated live daemon fixture changes native system
appearance, saves a preset, returns Home with the preset retained, and restores
it in a fresh owner. It also repeats populated agent selection and the existing
local terminal journey. The first live appearance run rejected an incorrect test
assumption that config and daemon records share a directory; the corrected fixture
requires their actual common isolated root. The initial compile failure from a
test closure lifetime annotation and failed fixture log are retained.

The real OpenSSH GUI regression passed with complete cleanup (`nssh-CYEqGB`).
Evidence: `native-appearance-navigation-tests.log`, `native-appearance-parity.log`,
`native-appearance-package-tests-final.log`, `native-appearance-clippy-final.log`,
`native-appearance-local-live-final.log`, `native-appearance-ssh-live.log`,
`native-appearance-qualification.json` and `native-appearance-build-identity.json`
in the qualification directory. The temporary CLI was hash-verified and removed.
No physical typing/scrolling, packaged GUI performance, platform parity, default
launcher migration, or production native-surface completion is claimed.

### Native local config namespace resolution

The native appearance owner now resolves local configuration through a Rust
projection of `runtime-namespace.ts` and `development-instance.ts`. Production
keeps canonical config even with an alternate state home; isolated modes use their
own state/config default. Explicit config paths retain their existing behavior
inside a valid namespace. Custom local records require matching daemon-directory
authority unless config is explicit; selecting an SSH source never changes the
local settings namespace.

Development resolution recomputes the canonical worktree/name digest and exact
state/runtime/socket descriptor. Existing directory ownership/modes, canonical
and sibling-instance exclusions, scoped settings/integration paths, inherited
foreign TMUX authority and existing symlink ancestors are checked. Socket identity
resolution validates the direct parent and compares canonical device/inode identity.
The owner captures local environment once and resolves it again before each save,
so a changed ancestor cannot silently retain the previous approval. Invalid
non-Unicode namespace values are rejected rather than dropped into production
fallback. This is a path-resolution boundary, not a cross-process filesystem lock.

`bridge/native-config-namespace-smoke.mjs` constructs owned paths and compares the
actual TypeScript authority with Rust. It refuses zero matching Rust tests and
cleans up its child, socket and owned files. The initial fixture exceeded macOS's
Unix socket path limit; its root now uses a short private `/tmp` path. A subsequent
run caught an outdated hardcoded client test binary. Qualification now uses
`herdr_client-a5ee57a18c977380`, the executable reported by the current Cargo run;
the stale-binary zero-test run is retained as failed evidence.

Final macOS validation passed: 594 client tests (5 ignored), 3,119 GUI tests
(13 ignored), all-target/all-feature client/GUI Clippy, and 48 reference-parity
fixtures (16 valid and 32 invalid). The isolated local daemon journey passes with
native appearance persistence/Home navigation, populated agent selection and
terminal/catalog actions. The current-binary OpenSSH GUI journey also passes with
complete cleanup (`nssh-kShOWM`). These checks supersede the earlier read-only
namespace limitation for supported valid descriptors; they do not prove platform
parity or race-free filesystem transactions.

Evidence: `native-config-namespace-tests-final.log`,
`native-config-namespace-parity-qualified.log`, `native-config-namespace-clippy-final.log`,
`native-config-namespace-local-live-final.log`, `native-config-namespace-ssh-live-final.log`,
`native-config-namespace-qualification.json` and `native-config-namespace-build-identity.json`
in the qualification directory. Earlier compile/fixture/stale-binary failures are
retained. The temporary CLI was hash-verified and removed after cleanup. The
launcher still defaults to the Node helper; remaining agent workflows, production
native surfaces and packaged physical-input/performance/memory qualification are
still unfinished.

### Fleet-owned sources for native agent observations

The fleet catalog pool retains the identity of its last successfully accepted
catalog and exposes its existing source only for a matching route incarnation and
catalog identity. Initial/unverified, failed, disconnected and retired routes do
not grant a source. Catalog/watch failures and shutdown clear this eligibility
before returning errors. Registry cleanup or loss of route authority also denies
borrowing. The caller must recheck route lifetime before publishing observations;
borrowing does not transfer shutdown/reset ownership or grant terminal admission.

This lets the agent observation pool reuse the fleet's authenticated SSH owner
instead of creating a separate connection per observation. A remote-source unit
test verifies the borrow shares the same Arc and cannot reopen after the owner
retires it. Socket tests cover successful catalog qualification, wrong identity
or incarnation, failed-refresh revocation and explicit disconnect/invalidation.
The real isolated daemon client journey now borrows its local source through the
fleet registry, observes the exact session through the bounded observation pool,
retires that pool, disconnects the registry route, then continues other client
operations on the still-running daemon.

Validation passed: 597 client tests (5 ignored), client/GUI all-target/all-feature
Clippy, and the real local daemon client fixture with the source pane unchanged.
The current client-only Cargo run emits `herdr_client-b688c41bbd500647`; artifact
names differ with feature unification, so use the executable in the current Cargo
output rather than a remembered hash. Evidence: `native-agent-fleet-source-tests-final.log`,
`native-agent-fleet-source-clippy.log`, `native-agent-fleet-source-local-live.log`,
`native-agent-fleet-source-qualification.json`, and `native-agent-fleet-source-build-identity.json`
in the qualification directory. The hash-verified temporary CLI was removed.
This is the source-sharing boundary; the GUI global-agent scheduler, cross-machine
agent selection, filters, palette and attention workflows are not connected yet.
No current GUI/physical-input/performance or full research completion claim is made.

### Native Home agents across connected machines

The native Home roster now observes connected fleet catalogs through their existing
registry-owned authenticated sources. It deduplicates environment aliases, prefers
ready routes, bounds observations to 32 sessions/four unfinished workers and rows
to 256, and reports incomplete or truncated observations. Machine identity and
route incarnation participate in private row context; replaced, failed or disconnected
routes revoke their rows before results can be accepted. Conflicting environments
suspend observations. Workspace observation remains scoped to its active session.

Cross-machine agent selection re-enters fresh registry selection and catalog
validation, then verifies the exact observed agent/session/pane identity through
the existing client operation. Background metadata connections are not promoted
into terminal ownership. Identical session identifiers on separate machines and
replacement incarnations have regression coverage.

Validation: 597 client tests (5 ignored), 3,121 GUI tests (14 ignored), and
all-target/all-feature client/GUI Clippy passed. The local daemon journey passed
with populated agent selection and appearance persistence. The real isolated
OpenSSH journey passed, including Home selection of an observed remote agent,
exact session/pane and active host checks, navigation, reconnection and cached
history (`nssh-teae9i`, complete cleanup). Initial fixture failures were retained:
agent seeding originally preceded a deliberately empty-roster client test, and
the new GUI test originally checked the Home creation target instead of the active
session/tab. Both assertions/setup issues were corrected before final qualification.

Evidence in the qualification directory: `native-fleet-agent-tests-final.log`,
`native-fleet-agent-clippy-final.log`, `native-fleet-agent-local-live.log`,
`native-fleet-agent-ssh-live-final.log`, `native-fleet-agent-qualification.json`,
and `native-fleet-agent-build-identity.json`. Temporary CLI removed after hash
verification. This supersedes the preceding Home global-roster integration gap;
filters, palette, attention, workspace fleet agents and activity badges remain.
The launcher still defaults to the Node helper; production native surfaces and
final packaged physical-input/performance/memory qualification remain unfinished.

### Native Home machine filter and primary-route observation

The Rust owner now handles the existing Home machine-filter command. Commands
must match the current foreground Home request and roster revision, refer to a
published machine group, and arrive while no catalog action is pending. Filtering
reconfigures observations before the 32-session budget; it neither changes the
navigation request nor opens a terminal. The published capability tracks the
roster revision, disappears while hidden, and resets if its machine is removed.

Fleet projection now records its visible primary routes and conflict state for
agent observation. The roster uses those primary routes rather than independently
choosing an alias, and excludes conflicting background groups. Selection also
rechecks this eligibility. This closes the preceding Home implementation's gap
for conflicts outside the selected environment.

Validation passed: 597 client tests (5 ignored), 3,122 GUI tests (14 ignored),
all-target/all-feature client/GUI Clippy, source-size gate and diff whitespace.
Regression checks reject stale, unknown-machine and hidden filter commands without
navigation, and verify primary alias/conflict eligibility. The owned OpenSSH test
cycles all machines → local → remote, checks the remote row disappears/reappears,
then selects its exact session/pane and active host. The full SSH journey passes
with cleanup (`nssh-FM6yur`); local populated-agent/appearance/catalog checks pass.
Initial test cleanup compile errors were corrected before qualification.

Evidence: `native-agent-filter-tests-qualified.log`, `native-agent-filter-clippy.log`,
`native-agent-filter-ssh-live.log`, `native-agent-filter-local-live.log`,
`native-agent-filter-qualification.json`, and `native-agent-filter-build-identity.json`
in the qualification directory. The temporary CLI was hash-verified and removed.
Recovery/load-more, palette, attention, workspace fleet agents and activity badges
remain; the launcher still uses the Node helper by default. Production native
surfaces and packaged physical-input/performance/memory qualification are unfinished.

### Native observation recovery and bounded expansion

The native Home owner handles observation retry and load-more. Coverage starts at
32 sessions and expands in pages of 32 up to 512 sessions, matching the native
fleet's visible-session budget. The client queue ceiling is now 512; unfinished
reads, including retiring workers, remain capped at four. The 256-row projection
limit is unchanged. Filtering happens before the coverage budget, cancellation
revokes previous rows, and truncation remains explicit at the hard ceiling.

The owned 34-session fixture exposed a real control-admission bug: an otherwise
current load-more command was discarded because unrelated metadata work was in
flight. Observation-only controls now take effect without changing that operation;
new reads wait for the existing scheduler's eligibility. Controls also retain the
first applicable revision within an unchanged context, so partial result updates
do not drop a still-valid click. Retry cannot use a revision from before retry
became available. Reconfiguration, hiding, navigation and consuming a control
invalidate previous commands. This supersedes the prior machine-filter section's
requirement that no catalog operation be pending and its exact-latest-revision rule.

Validation passed: 597 client tests (5 ignored), 3,127 GUI tests (15 ignored),
all-target/all-feature client/GUI Clippy, source-size and whitespace gates.
Tests cover incremental expansion through the hard limit, stale/consumed controls,
retry following actual worker read failure, and filter admission during metadata
work. The owned local daemon fixture observes an agent beyond the first page,
checks that a healthy roster does not advertise retry, and verifies Home stays
detached. The current-binary SSH journey passes filtering, exact agent selection,
reconnection and history with cleanup (`nssh-l9yf57`). These are controller/runtime
checks, not physical GUI timing measurements.

Earlier failures are retained: fixture agent metadata lacked a fresh state stamp,
long test names were correctly truncated, healthy reads correctly offered no retry,
and the SSH assertion needed to wait for the asynchronously published active tab.
The metadata-stage rejection was reproduced with matching request/revision before
being fixed; the failure log includes bounded roster counts for diagnosis.

Evidence: `native-agent-recovery-tests-complete.log`,
`native-agent-recovery-clippy-verified.log`, `native-agent-recovery-local-verified.log`,
`native-agent-recovery-ssh-verified.log`, `native-agent-recovery-qualification.json`,
and `native-agent-recovery-build-identity.json` in the qualification directory.
The temporary CLI was hash-verified and removed. Palette, attention, workspace
fleet agents and activity badges remain on the migration list; the default launcher
still uses the Node helper. Production native surfaces and packaged physical-input,
performance and memory qualification remain unfinished.

### Bounded agent-row projection before native picker integration

Expanded coverage could previously construct and sort every display row before
truncation (up to 512 sessions × 64 agents). The native projection now retains a
256-row max heap ordered by the same attention/activity/key priority as the full
sort. Candidates that cannot enter the retained set do not construct their display
metadata. Filtering can run before the heap, so a future palette query can find a
match beyond the ordinary Home row cap. The private publication map also retains
only current displayed rows: omitted rows lose old selection rights, and a row
reintroduced later requires its newer publication revision.

Tests compare mixed-priority, ascending and descending input with a full sort;
the ordered 32,768-candidate case constructs exactly 256 display rows. This is
algorithmic/allocation-count evidence, not a measured speedup or end-to-end memory
qualification. A filtering test finds a row beyond the 256-row unfiltered limit
and verifies token revocation/reintroduction. The observed source data remains
bounded separately by session/agent limits. Multiple future picker views will
need their own scoped selection maps; this projection's current map belongs to
its one active roster.

Validation passed: 597 client tests (5 ignored), 3,130 GUI tests (15 ignored),
client/GUI all-target/all-feature Clippy, file-size and whitespace checks. Local
agent/recovery/appearance/controller checks passed, as did the full OpenSSH
filter/selection/navigation/reconnection/history journey (`nssh-GPfMd0`, cleanup
complete). Evidence: `native-agent-projection-tests.log`,
`native-agent-projection-clippy.log`, `native-agent-projection-local-live.log`,
`native-agent-projection-ssh-live.log`, `native-agent-projection-qualification.json`,
and `native-agent-projection-build-identity.json` in the qualification directory.
The temporary CLI was hash-verified and removed.

Palette and attention commands are still unconnected in the native owner. Their
migration must share bounded observations while preserving independent scope,
query, cancellation and selection fencing, including from an open workspace.
Workspace fleet agents, activity badges, the default-launcher switch, production
native surfaces and packaged physical-input/performance/memory qualification also
remain unfinished.

### Native palette and attention subscriptions

The opt-in Rust owner now handles palette and attention observation, cancellation,
and exact agent selection from Home and open workspaces. One visible picker shares
the existing bounded observation pool; it temporarily replaces roster publication
without replacing the active terminal. Query matching precedes the 256-row display
cap. Each picker kind retains monotonic subscription scopes, and selection uses
request, scope, publication and fresh agent/pane validation. Closing or navigating
revokes the subscription. Workspace pickers use the independent catalog watch lane;
a catalog failure makes the picker unavailable without resetting terminal ownership.

Validation: 597 client tests (5 ignored), 3,133 GUI tests (16 ignored), all-target/
all-feature client/GUI Clippy, file-size and whitespace checks passed. A new owned
fixture proves Home palette selection, palette selection into a different workspace,
and attention selection back to the original pane; merely observing retains the
current ready terminal and selected pane. Its initial failure exposed a missing
fixture workspace registration. The fixture now explicitly promotes that session;
opening a picker must not perform adoption. The failed diagnostic is retained.
Local recovery/appearance and the existing real OpenSSH journey also passed
(`nssh-IiZwG2`, cleanup complete). The SSH journey is regression coverage, not yet
picker-specific remote coverage. No physical-input or performance claim is made.

Evidence in the qualification directory: `native-agent-picker-tests-live-build.log`,
`native-agent-picker-clippy-live.log`, `native-agent-picker-local-promoted.log`,
`native-agent-picker-recovery-live.log`, `native-agent-picker-ssh-live.log`,
`native-agent-picker-qualification.json`, and `native-agent-picker-build-identity.json`.
The temporary fixture CLI was verified before removal.

Still pending: remote picker qualification, workspace fleet agents/activity badges,
default native launcher migration, production native surfaces, full workspace and
cross-platform gates, and packaged physical-input/performance/memory qualification.

### Native remote picker qualification

The owned OpenSSH journey now exercises palette selection from a local workspace
into the exact observed remote pane, followed by attention selection on that remote
workspace. Observing either picker preserves the ready terminal and selected pane;
only the explicit selection changes navigation. The remote fixture marks its agent
blocked so the attention predicate is exercised. The receipt requires both original
fleet-selection and new remote-picker success markers. This is an actual SSH/daemon
owner-path test, not physical GUI input or performance evidence.

Validation passed: 597 client tests (5 ignored), 3,133 GUI tests (16 ignored),
client/GUI all-target/all-feature Clippy, file-size and whitespace checks, and the
full SSH journey (`nssh-JqWEpw`, cleanup complete). Evidence in the qualification
directory: `native-remote-picker-tests-verified.log`, `native-remote-picker-clippy.log`,
`native-remote-picker-ssh-live.log`, `native-remote-picker-qualification.json`, and
`native-remote-picker-build-identity.json`. The temporary fixture CLI was hash-verified
and removed. An initial test compilation error referenced a non-public machine ID
field; the corrected test checks the display label plus exact session/pane identity.

Next migration work remains workspace-wide fleet agent publication and selection,
then tab activity/unread observations (currently always absent in native tabs).
Those should share bounded observations and preserve exact incarnation, scope and
request fences. Native metadata remains opt-in. Production native surfaces, the
launcher switch, full platform/package gates, and physical-input/memory/performance
qualification remain incomplete.

### Native workspace-wide agent publication and selection

Open workspaces now observe the bounded fleet through the existing shared pool,
with the active workspace first. The native owner publishes the fleet sidebar and
handles its scoped selection command, reusing fresh catalog/agent/pane validation.
Navigation, hiding and picker replacement revoke the workspace scope. Invalid or
replayed selection attempts cannot acquire a terminal. Workspace catalog updates
use the independent read lane; failure marks observations incomplete without
resetting the terminal. Active session and server labels come from the catalog.

The selected marker is refreshed from current state on every publication. Active
session rows are filtered using a bounded set of their observation keys rather
than repeatedly searching the entire fleet; unavailable rows remain visible.
Identity checks include machine, catalog owner, server generation and live session.
This is structural correctness/work reduction, not measured performance evidence.

Validation passed: 597 client tests (5 ignored), 3,135 GUI tests (16 ignored),
all-target/all-feature client/GUI Clippy, file-size and whitespace checks. The local
owned picker journey now also checks both workspace agent rows, the active marker,
rejection of an incorrect scope without navigation, and exact cross-workspace pane
selection. Recovery/appearance and the full OpenSSH regression, including remote
pickers, passed (`nssh-yVjwOk`, cleanup complete). The new workspace-fleet selection
command itself still needs a specifically remote live assertion, and actual-window
UI validation remains outstanding.

Evidence in the qualification directory: `native-workspace-fleet-tests-final.log`,
`native-workspace-fleet-clippy.log`, `native-workspace-fleet-local-live.log`,
`native-workspace-fleet-recovery-live.log`, `native-workspace-fleet-ssh-live.log`,
`native-workspace-fleet-qualification.json`, and `native-workspace-fleet-build-identity.json`.
The temporary CLI was verified and removed.

Remaining migration work includes team grouping parity and tab activity/unread
observations, plus targeted lifecycle/remote coverage for the new workspace view.
The default launcher remains unchanged. Production native surfaces and final
platform/package/physical-input/performance/memory qualification remain incomplete.

### Native team grouping and tab activity

Workspace fleet rows now follow the TUI membership order: machine groups in first
appearance order, then teams, then ungrouped agents. Membership uses server ID,
generation, source and team ID within a machine; identical display names do not
merge groups. The projection remains bounded to the retained 256 rows.

Native tabs now consume the existing bounded agent observations. Each tab retains
at most 64 exact identities (agent, pane, native lifetime and interaction endpoint)
and processes each observation epoch once. Waiting/failed/running/idle indicators
follow the existing priority. An inactive tab becomes unread only on an observed
running-to-complete transition of the same identity. Failed or missing observations
clear the baseline and activity; ordinary pending refreshes retain the baseline.
Verified activation clears unread. Badge changes preserve tab navigation tokens
and revisions and do not add workers or terminal-bridge messages.

Validation passed: 597 client tests (5 ignored), 3,140 GUI tests (16 ignored),
all-target/all-feature client/GUI Clippy, file-size, formatting and whitespace
checks. Tests cover grouping identity boundaries, replacement panes, observation
epoch deduplication, unavailable observations, badge priority/bounds and stable
navigation capabilities. The real OpenSSH journey now specifically selects a
remote agent through the workspace-fleet command and verifies its active tab's
waiting indicator (`nssh-PQuqh7`, cleanup complete). Local picker/workspace and
recovery/appearance journeys also passed. Unread completion has unit coverage;
a timed live daemon transition and actual-window rendering/input remain unverified.

Evidence in the qualification directory: `native-tab-activity-tests-final.log`,
`native-tab-activity-clippy.log`, `native-tab-activity-local-live.log`,
`native-tab-activity-recovery-live.log`, `native-tab-activity-ssh-live.log`,
`native-tab-activity-qualification.json`, and `native-tab-activity-build-identity.json`.
The temporary fixture CLI was hash-verified and removed. An earlier compilation
attempt used the internal team-source type name; the public alias is used now.

The next step is remaining metadata behavior/lifecycle qualification and a reviewed
default-launcher migration. Production native surfaces, full platform/package gates,
and final physical-input/performance/memory qualification are still incomplete.

### Live unread transition and default native local launch

The owned daemon fixture now waits for an inactive tab's observed running state,
then marks that exact fixture pane done. Rust observes the completion, marks the
inactive tab unread without changing the selected pane or tab navigation tokens,
and clears unread after activating that tab. The harness uses explicit readiness
and completion markers, not a guessed delay; it changes only its owned tmux pane.

A new `--tmux-native-local` executable entry resolves the canonical daemon record
through the validated runtime namespace. Tests cover production, isolated paths,
registry/record overrides, config-path independence and rejection of unsafe or
incomplete namespaces. The dedicated executable rejects invalid local namespaces
before creating a window or personal state. The assembly launcher now uses this
entry for no-argument startup. Explicit legacy private-host files still use the
Rust-owned Node helper; Node/broker files remain packaged for that compatibility
path. There is no automatic helper fallback for normal startup.

Validation passed: 598 client tests (5 ignored), 3,140 GUI tests (16 ignored), six
compiled CLI tests, eight launcher tests, all-target/all-feature client/GUI Clippy,
file-size and whitespace checks, plus the owned live completion journey. Launcher
checks use fixture executables and prove version pinning during update, rollback,
detach and direct launch for both native and legacy entries. They do not prove a
fresh real app starts correctly. Unit suites preceded a final CLI help-text update;
the executable suite and Clippy include that update. No new release was made.

Evidence in the qualification directory: `native-local-entry-tests.log`,
`native-local-entry-cli.log`, `native-local-entry-launcher-tests.log`,
`native-local-entry-clippy.log`, `native-tab-completion-local-final.log`,
`native-local-entry-qualification.json`, and `native-local-entry-build-identity.json`.
The temporary CLI was verified and removed.

Next: assemble and qualify the real default native app, including first-run managed
setup and actual-window lifecycle. Legacy private-host migration, production native
surfaces, full platform/package gates and physical-input/performance/memory checks
remain unfinished. The launcher source switch alone does not establish release readiness.

### Optimized default native app startup qualification

The local release wrapper now resolves the exact installed toolchain from the
pinned rust-toolchain.toml, without requiring a rustup launcher. Local dependency
admission remains constrained to captured workspace manifests and the exact
captured Apple vendor patch. Eleven build-input/receipt tests passed. The optimized
build completed with binary SHA-256
`03127859752364cef778ceebf6007332f7c049168291064bdf85ac153324d8f6`.
A separate development app was assembled with generated license notices; the
initial notice generation failed because Cargo was absent from PATH, then passed
with the pinned toolchain and existing cargo-about environment.

The real assembled no-argument launcher created an owned native window with zero
child helper processes. Process termination preserved the isolated daemon's full
readiness and both source pane contents. This is process termination, not a manual
window-close test. The Mac was locked: no screenshot, physical input, visual quality
or latency claim follows. Initial fixture attempts found missing-semantic-stamp
before and after termination: only one of two sessions had been promoted. Explicitly
promoting both owned fixture sessions yielded the passing readiness check.
The test CLI copy was hash-verified and removed. No personal app was replaced.

Evidence under the qualification directory: `native-default-local-build-receipt.json`,
`native-default-local-release-build.log`, `native-default-local-assembly.log`,
`native-default-build-inputs-tests.log`, `native-default-bridge-gate.log` (913 passed,
5 skipped), and `native-packaged-startup-4/receipt.json`. Earlier failed startup
attempts and readiness diagnostics are preserved as `native-packaged-startup-1`
through `native-packaged-startup-3`. The startup script was formatted after its
passing run; no behavior changed.

Remaining: managed first-run setup, actual-window lifecycle and final platform/
package qualification; production authenticated native surfaces; physical input,
performance and memory validation. This development assembly is not a release.

### Native delivery correlation without predicting control arrival

The Mach inbox can now return an owned `Delivery` containing the received ticket,
sequence and surface right. The connection worker can match this against its
bounded authenticated offer table instead of guessing the next control offer at
receive time. Receiving alone is explicitly not admission. Unmatched deliveries
must be dropped and use fallback; no unmatched-right queue is introduced. Both
strict and unpredicted receive methods share envelope validation and monotonic
replay rejection. Rejected envelopes destroy kernel-delivered rights; dropping a
returned delivery releases its surface right. The queue remains one message and
all receives remain nonblocking.

Six inbox tests passed, including unknown-control delivery drop, replay/stale
rejection, later-message recovery, mixed receiver modes, queue backpressure and
right-reference cleanup. The full Apple platform test binary passed 26 tests
(three opt-in tests skipped), including native import and GPU completion retention.
The explicit two-process IOSurface fixture was then updated to use the new receive
method and passed: private fixture ticket validation, Metal color readback, final
owner retirement and exact child/endpoint cleanup. This still uses a test-only
legacy bootstrap registration and does not authenticate a production endpoint.

Evidence: `native-surface-delivery-tests.log`, `native-surface-platform-tests.log`,
and `native-surface-delivery-process.log` in the qualification directory. File-size
and whitespace gates passed. Production endpoint distribution, producer wiring,
offer admission/import dispatch, retirement ACK/fallback and packaged GUI
qualification remain unfinished. The previously assembled app predates this change;
its receipt must not be presented as the identity of the updated source.

### Kernel sender identity and full workspace qualification

The native surface inbox now requests and validates the kernel audit trailer.
`SenderIdentity::current` reads the producer's full TASK_AUDIT_TOKEN for delivery
through authenticated control setup. `try_receive_from` compares all eight words,
including process incarnation, before transferring a surface right or advancing
sequence state. A wrong sender's message is destroyed and cannot poison the next
valid sequence. Numeric PID alone is not accepted as sender identity. Existing
unbound receive methods remain for the current prototypes; production control
setup and selection of the expected identity are still not wired.

The Apple suite passed 27 tests (three opt-in tests ignored). New coverage compares
TASK_AUDIT_TOKEN with the actual kernel trailer, rejects a changed incarnation,
and proves sequence recovery after rejection. The existing explicit two-process
IOSurface/Metal retirement fixture also passed with audit trailers enabled. That
fixture still uses the unbound receive method and a private test control pipe;
it does not prove production sender authentication.

The complete macOS workspace gate passed before this audit-trailer change:
format/file-size, all-feature and no-default-feature Clippy, and default/all-feature
workspace tests and doctests. Across those two test runs, 7,612 passed and 55 were
ignored. `just` was unavailable, so its exact command sequence was run in a
fail-fast shell. Evidence: `native-full-workspace-ci.log`,
`native-surface-audit-tests.log`, and `native-surface-audit-process.log`.

The Linux gate snapshot was corrected to include the exact sibling Apple patch
manifest Cargo resolves on every platform; source snapshots mount read-only. Docker
is available with roughly 4 GiB RAM (one compiler job). The Linux gate was started
with its own cache and log `native-linux-lint.log`; completion is not yet claimed.
Windows cross tools/standard library are absent. No app was reassembled or released.

### Cross-process sender binding and Linux dependency repair

The owned two-process IOSurface fixture now obtains the producer's full audit
identity through its private stdout pipe and uses `try_receive_from` before native
import. It verifies the ticket and sequence separately, paints through Metal,
waits for final GPU ownership retirement, and then permits the producer to exit.
This check passed (`native-surface-bound-process.log`). The first attempt exposed
a fixture stdout lifetime bug: closing the read end after the identity line made
the producer's final libtest output fail. Keeping that bounded output handle alive
until child exit fixed the failure; a direct coordinator run confirmed the original
failure occurred at producer exit, not sender verification or GPU import.

The expected-identity exchange remains test-only. Production authenticated control
setup and endpoint distribution are not established by this fixture.

The first Linux gate terminated with missing `glib-2.0` pkg-config metadata while
checking the full workspace's gpui-wry crate. `install-linux-deps.sh` now includes
WebKitGTK 4.1 development dependencies, which bring the required GTK/GLib stack.
The app still uses external browser tabs on Linux. Shell syntax and whitespace
checks passed. A fresh gate run uses the same owned cache and a separate log,
`native-linux-lint-webkit.log`; it is still running. The original failure log
`native-linux-lint.log` is retained. No platform result is inferred from installing
a dependency, and no release/app assembly was performed.

### Linux application gate and rendezvous boundary review

With WebKitGTK dependencies installed, the Linux gate reached herdr-gpui and found
an unused `cx` in `SnapshotView::discard_composition`: only its macOS branch uses
that context. The non-macOS branch now explicitly consumes the parameter without
changing composition behavior. Formatting, source-size and whitespace checks
passed after correcting the formatter's toolchain PATH. The terminated gate log is
`native-linux-lint-webkit.log`; a new full gate is running with the same cache and
log `native-linux-lint-composition.log`. No Linux success is claimed yet.

Rendezvous remains a production gap. Receiver-side audit identity protects import,
but a producer must authenticate the receiver before sending private pixels.
A publicly discoverable bootstrap name plus receiver-side checking is insufficient.
The current prototype must not be promoted directly. Apple's published launchd
implementation distinguishes per-process lookup and rejects registrations belonging
to another job; a simple shared fixed-name pool is therefore not an established
solution to the prototype's inactive-name lifetime issue. Source reviewed:
https://github.com/apple-oss-distributions/launchd/blob/main/src/core.c
(`job_mig_register2`, `job_mig_look_up2`). This historical source is design evidence,
not proof of current runtime behavior. Endpoint distribution, mutual proof before
pixel transfer, bounded registration lifetime and failure-to-inline behavior must
be qualified together before advertising native surfaces.

### Mutual native endpoint proof before pixel transfer

The native inbox now distinguishes endpoint-proof messages from surface messages.
A fresh reply inbox receives an endpoint only when both the kernel audit identity
and the control challenge match. It is one-use; wrong peer, challenge, replay or
message kind destroys the transferred right without advancing valid replay state.
Endpoint-proof messages carry no pixel right and cannot be imported as surfaces.
Both send and receive operations remain nonblocking with a one-message kernel queue.
Production setup must supply unpredictable per-handshake challenges and both peer
identities through authenticated control; this is not achieved by trusting the
bootstrap service name.

The Apple suite passed 30 tests (three opt-in tests skipped), including mutual
endpoint exchange, wrong peer/challenge/kind, replay and proof/surface separation.
The two-process IOSurface fixture was then updated to exchange identities through
its private control pipes, prove both peers, and transfer the actual pixel endpoint
only after those checks. The producer allocates and sends its IOSurface only after
receiver verification. Metal rendering and final GPU retirement still passed.
Evidence: `native-surface-endpoint-tests.log` and `native-surface-mutual-process.log`.
The bootstrap rendezvous remains test-only; production registration lifetime,
control negotiation and fallback integration are still incomplete.

The next Linux test compilation found sibling fixture includes missing from the
container snapshot (fixtures, bridge/binary-vectors.json and one recorded fleet
JSON). The gate now copies and read-only mounts those exact input locations rather
than excluding tests. The terminated failure is retained in
`native-linux-lint-composition.log`; the gate is running again in
`native-linux-lint-fixtures.log`. Source-size and whitespace checks passed. No app
assembly or release was made; prior packaged receipts predate these source changes.

### Process-scoped optional rendezvous and Linux gate completion

The Linux all-target gate now passes with both all features and no default
features (`native-linux-lint-fixtures.log`). It used the isolated Ubuntu 24.04
snapshot, one compiler job, the corrected WebKitGTK dependencies and exact sibling
fixture mounts. This is Linux lint/type checking, not Linux native GUI testing.

An optional macOS process-scoped rendezvous module now dynamically resolves
bootstrap_register2/bootstrap_look_up2. Their private ABI and PER_PID flag were
checked against Apple's bootstrap_priv.h:
https://github.com/apple-oss-distributions/launchd/blob/main/liblaunch/bootstrap_priv.h
Missing symbols or registration/lookup failures return errors for fallback; there
is no global-name fallback. The namespace is finite (32 slots per process), inputs
are bounded, and registrations own their receive right. Drop destroys that right
before one best-effort unregister call, without blocking/retrying. Delayed inactive
name cleanup remains possible but cannot grow the namespace beyond 32 names.

Lookup returns an UnverifiedEndpoint that can send only a proof endpoint, never
pixel storage. Pixels require the separately verified endpoint from the mutual
kernel identity/challenge exchange. Production authenticated control must still
supply the expected identities, process/slot and fresh challenge. This module is
not advertised or wired to the production daemon yet, and private API availability
on this host is not a promise of support on other macOS versions.

Two new rendezvous tests passed: scoped proof exchange/revocation on drop and
invalid process/slot bounds. The full Apple platform suite passed 32 tests with
three opt-in tests ignored; all-target Apple crate Clippy passed. Logs:
`native-surface-rendezvous-tests.log`, `native-surface-rendezvous-platform.log`,
`native-surface-rendezvous-clippy.log`. Cross-process registration isolation and
replacement/exit cleanup still need qualification with this new rendezvous.
No final packaged GUI or release claim follows.

### Scoped rendezvous through the complete two-process pixel fixture

The IOSurface fixture now uses the optional process-scoped Registration and
lookup_unverified APIs, replacing its legacy global bootstrap registration and
cleanup implementation. The producer receives the receiver PID/slot and full audit
identity over private stdin; its own identity returns through private stdout.
Both peers prove their identity before the pixel endpoint is transferred, then
IOSurface import, Metal readback and GPU retirement run as before.

The outer parent owns an identical slot in its own process. The fixture proves
that receiver exit makes the receiver's PID/slot unresolvable while leaving the
parent's same-slot endpoint available. Successful lookup with a null right is now
classified as an inactive endpoint (None), never an imported capability. The
macOS-only fixture and support module are gated consistently. This tests normal
receiver exit; forced-crash and production reconnect behavior remain unproven.

The complete two-process fixture passed, all 32 default Apple platform tests passed
(three opt-in tests ignored), and all-target Apple Clippy and whitespace checks
passed. Evidence: `native-surface-scoped-process.log`,
`native-surface-scoped-platform.log`, `native-surface-scoped-clippy.log`. No legacy
random global service names are created by this fixture anymore. Production
control-channel integration, producer/daemon ownership, fallback negotiation and
final packaged GUI measurements are still unfinished; no release was made.

### Rendezvous replacement bug found and fixed

Capacity/replacement qualification exposed a host behavior missed by one-shot
registration tests: registering a null port returned success but left the slot
rejecting a replacement with BOOTSTRAP_SERVICE_ACTIVE (1103). Waiting longer and
repeating null registration did not fix it. Removing null-port registration did:
Drop now destroys only the owned receive right and lets launchd observe its death.
This supersedes the earlier best-effort-unregister design.

A bounded RegistrationAttempt reserves one of 32 slots and polls only on the
transport worker, with a five-second expiry. Only a slot previously owned and
retired by this module may return pending for 1103; an unknown active-name collision
is an error, never an unregister target. Success clears retirement tracking; Drop
cancels the pending attempt. The immediate Registration::new path still falls back
without waiting. No sleeps or retry threads were added to production code.

New tests hold all 32 slots, reject over-capacity allocation, replace one retired
slot, and prove stale capabilities cannot send to its replacement. A separate owned
child is forcibly killed without running Rust destructors; its endpoint becomes
unusable/unresolvable while the parent's same-slot registration remains live.
The final lifecycle tests passed (4 plus 1 ignored child helper), all default Apple
tests passed (34 plus 4 ignored), the full two-process pixel/GPU retirement fixture
passed, and all-target Apple Clippy/whitespace checks passed. Earlier failed logs
are retained rather than represented as success.

Evidence: `native-surface-rendezvous-lifecycle.log`,
`native-surface-rendezvous-lifecycle-fixed.log`,
`native-surface-rendezvous-lifecycle-retirement.log`, `native-surface-slot-debug.log`,
`native-surface-rendezvous-lifecycle-port-death.log`,
`native-surface-lifecycle-platform.log`, `native-surface-lifecycle-pixels.log`,
`native-surface-lifecycle-clippy.log`. Production daemon/control integration and
packaged GUI qualification remain unfinished. Nothing was released.

### Native surface control schemas and shared admission vectors

The shared contracts package now defines strict native receiver, producer-peer,
surface-offer, final-retirement and fallback control envelopes. Endpoint descriptors
carry bounded process/slot identifiers and full audit identities, not arbitrary
service names, paths or raw Mach port integers. Setup is scoped by daemon generation
and a connection nonce/challenge. Surface offers preserve the existing Rust exact
committed-pane envelope and charge padded backing allocations up to 64 MiB;
retirement is a final-storage event sent only on the original connection.

No capability was added or advertised and these messages are not yet in the
production stream parser. Authentication, locality and kernel proof remain runtime
requirements; successful schema parsing is not peer authorization. Existing inline,
file and compressed graphics remain the active transport.

All 602 contracts tests across 71 files passed, along with contracts typecheck and
lint. Shared fixture `fixtures/native-surface-offers.json` is consumed by TypeScript
and Rust tests. It covers padded BGRA success and invalid bounds, sequence, format,
ticket and path cases; Rust additionally proves rejected vectors reserve zero bytes.
Seven focused Rust offer tests passed. Evidence: `native-surface-wire-contract-tests.log`,
`native-surface-wire-types.log`, `native-surface-wire-lint.log`, and
`native-surface-wire-rust.log`. Whitespace checks passed.

The required terminal compatibility gate was started as `pnpm release:opentui:check`
with log `native-surface-control-terminal-gate.log`; it is still running. Production
message dispatch, native provider ownership and GUI presentation wiring, followed
by final packaged/performance qualification, remain unfinished. No release was made.

### Native surface control lifecycle qualification

The terminal compatibility gate recorded above finished successfully, including
installed-package journeys (`native-surface-control-terminal-gate.log`).

Rust now has a connection-scoped native control state machine. Each instance uses
fresh nonce/challenge values; strict bounded peer frames cannot rebind a connection
or make it ready without a matching kernel proof. Duplicate peer announcements are
idempotent and cannot extend the five-second handshake deadline. A worker poll
emits timeout fallback once, without blocking the UI. Fallback prevents re-enabling
native delivery while allowing final GPU-storage retirements on the original
connection; closure suppresses further retirement frames.

All 605 client library tests passed (5 ignored), including six control lifecycle
tests. Client all-target/all-feature Clippy with warnings denied passed. Evidence:
`native-surface-control-rust.log` and `native-surface-control-clippy.log` in the
qualification directory. Whitespace checks passed.

This module is not wired into production dispatch yet. Constructor locality and
capability prerequisites and kernel-proof provenance must be enforced by that
integration. No native-surface capability is advertised, no production producer
has been enabled, and these checks do not establish physical GUI performance.
Production integration and final packaged qualification remain active work.

### Connection-owned kernel receiver

The Apple native surface receiver now owns proof registration, reciprocal reply,
and pixel inbox together. Its worker-facing poll performs authenticated kernel
proof reception, retries only one retained reciprocal send under backpressure or
interruption, and reports readiness only after that send is queued. Successful
proof immediately revokes the rendezvous endpoint. Invalid proof, expiry, explicit
close or drop releases the owned endpoint rights. The caller supplies the original
handshake deadline; retries do not reset it. Pixel admission still requires the
separate exact-pane offer, storage reservation and ticket correlation.

The existing owned two-process IOSurface fixture now uses this receiver instead
of hand-written proof and inbox plumbing. It passed, including actual IOSurface
import, Metal readback and final backing-owner retirement. All 37 Apple library
tests passed (4 opt-in helpers ignored), including new timeout/revocation,
backpressured reciprocal proof, and wrong-challenge tests. Apple all-target Clippy
with warnings denied and whitespace checks passed. The pre-existing future
compatibility warning for block 0.1.6 remains.

Evidence: `native-surface-receiver-tests.log`, `native-surface-receiver-pixels.log`,
and `native-surface-receiver-clippy.log` in the qualification directory. This is
an exercised native receiver component, not enabled application traffic. Production
daemon negotiation/provider ownership, socket dispatch, offer-to-scene integration,
and final packaged/physical/performance checks remain unfinished. No release.

### Connection-scoped native offer and retirement owner

A renderer-neutral surface session now composes the control state machine,
reservation pool, and pending handoffs under one connection lifetime. Admission
requires completed proof and matching daemon generation before reserving bytes.
The worker can leave Mach rights in the bounded kernel queue until an admitted
offer exists, avoiding an unbudgeted early-right queue when socket metadata lags.
Binding still consumes exactly one matching ticket and rechecks the exact committed
pane identity before returning storage for import.

Fallback clears pending offers but retains charges for imported storage until the
last GPU/backing owner drops. Retirement frames remain available on the original
socket during fallback. Closing the session retires the pool before clearing
pending offers, suppressing both immediate and late acknowledgments permanently.
The native endpoint owner must be closed alongside this renderer-neutral state.

All 609 Rust client library tests passed (5 ignored). New session tests cover
proof/generation gating, fallback with simultaneous pending and GPU-held storage,
closure with delayed GPU retirement, and expiry/replacement before import. Client
all-target/all-feature Clippy with warnings denied passed, along with file-size
and whitespace checks. Logs: `native-surface-session-tests.log` and
`native-surface-session-clippy.log` in the qualification directory.

Production dispatch/provider negotiation and offer-to-scene wiring remain
unfinished. These lifetime components are not advertised or enabled in the app.
Final packaged and physical performance qualification is still required; no release.

### Native surface stream boundary and unavailable-provider fallback

The shared pane-stream schemas now route native receiver/retirement/fallback
upstream and peer/offer/fallback downstream. Native client variants remain last in
the union so ordinary terminal input retains its existing schema-check path.
The production daemon accepts a bounded receiver descriptor only after redemption,
with semantic delivery and the current runtime generation. With no provider enabled,
it emits one scoped unsupported fallback, performs no PID/slot lookup, and preserves
the terminal stream. Exact repeated descriptors do not amplify replies. Changed
identity/endpoint/challenge, stale generation, oversized control, legacy delivery,
foreign fallback scope and unissued retirements are rejected.

Rust's socket command and inbound control boundaries recognize the same directions;
inbound native controls are bounded to 16 KiB and require authenticated readiness.
NativeSession still rejects these controls unless a native platform owner is wired
in: existing kitty graphics capability is not authorization for native storage.
This intentionally does not advertise or enable a native producer.

All 604 contract tests and 102 daemon pane-stream tests passed. The first added
pre-redemption fixture needed an issued origin before reserving its upgrade; after
fixing that setup, it verifies rejection before ticket redemption. Daemon typecheck,
changed-file ESLint and whitespace checks passed. All 612 Rust client tests passed
(5 ignored), and client all-target/all-feature Clippy with warnings denied passed.
Evidence: `native-surface-daemon-dispatch-contracts.log`,
`native-surface-daemon-dispatch-tests-fixed.log`,
`native-surface-daemon-dispatch-types.log`, `native-surface-stream-lint.log`,
`native-surface-stream-rust-tests.log`, and `native-surface-stream-rust-clippy.log`.

The required terminal compatibility gate is running under log
`native-surface-stream-terminal-gate.log` (live command handle 92526 when recorded).
Native provider ownership/positive negotiation and app presentation integration
remain unfinished, followed by packaged and physical performance qualification.
No release was made.

### Native producer endpoint ownership and stream gate completion

The terminal compatibility gate recorded above completed successfully, including
installed-package journeys (`native-surface-stream-terminal-gate.log`).

The Apple sender now owns the producer-side rendezvous/proof lifecycle. It keeps
one reply inbox across missing-service/backpressure retries, uses the original
handshake deadline, and exposes pixel sends only after reciprocal kernel identity
and challenge verification. Lookup alone cannot send pixels. Successful sends
advance a monotonic sequence; backpressure/interruption does not consume it.
Replay and nil-ticket attempts cannot enter the kernel queue. Closing or a failed
proof revokes its owned rights permanently. Queued sends still require the provider
to retain immutable backing until control retirement; this transport does not
substitute kernel queuing for GPU completion.

The two-process IOSurface fixture now uses both connection-owned Sender and Receiver
components instead of inline handshake code. Its real transfer, import, Metal
readback and final backing-owner retirement passed, including new replay/nil-ticket
checks. All 40 Apple library tests passed (4 opt-in helpers ignored). Apple all-target
Clippy with warnings denied and whitespace checks passed. The existing block 0.1.6
future-compatibility warning remains. Evidence: `native-surface-sender-tests.log`,
`native-surface-sender-pixels.log`, `native-surface-sender-clippy.log`.

This supplies the native producer transport, not an activated daemon provider.
Provider registration/retained-frame ownership and positive authenticated negotiation,
then app scene wiring and packaged/physical performance qualification remain active
work. No new capability is advertised and nothing was released.

### Native producer retention and recycling boundary

The producer now has a concrete IOSurface-backed frame owner. It derives bounded
BGRA geometry and allocation size from actual backing, then reserves producer
retention before creating a send right. One connection retains at most eight frames
and 64 MiB; producer-owned process references are capped at 32 frames and 256 MiB.
These limits cover retained producer references; consumer-side leases independently
account for scene/GPU ownership after transfer.

Ordered nonblocking sends retain the same buffer/ticket under kernel backpressure.
A queued send never releases storage. Fallback drops unsent buffers but retains
transferred frames until their original control retirement. Only retirement returns
a buffer for recycling; disconnect discards references without returning them for
reuse, while receiver-native references preserve any still-used backing. Unknown
or duplicate retirements cannot release another outstanding frame.

All 43 Apple library tests passed (4 opt-in helpers ignored), including bounded
actual backing, replay rejection, real kernel backpressure and fallback retention.
The owned cross-process IOSurface/Metal fixture now uses this frame owner and
passed, verifying producer retention before ACK and recycling only afterward.
Apple all-target Clippy with warnings denied and whitespace checks passed. Existing
block 0.1.6 future-compatibility warning remains. Logs:
`native-surface-producer-frames-tests.log`,
`native-surface-producer-frames-pixels.log`,
`native-surface-producer-frames-clippy.log`.

Provider activation/authenticated registration and app rendering integration are
still missing. The fixture's private pipes do not establish production negotiation.
No capability is advertised, no app release was made, and final packaged physical
performance/memory qualification remains required.

### Native surface placement contract and exact-pane projection

Surface offers now include a strict visible-cell rectangle instead of leaving
placement undefined. Shared TypeScript/Rust vectors cover empty, overflowing and
unknown-field placements. Rust checks the rectangle against the exact committed
pane's rows/columns before reserving storage. Accepted storage can project into a
native topology region only while that region retains the same commit identity;
projection uses content_top (excluding pane headers) and the pane's left edge.
Clipped geometry and replaced/different panes return no placement. History-view
suppression remains an integration responsibility alongside scene publication.

All 604 contract tests passed. The full Rust client suite passed with 614 tests
and 5 ignored, after correcting a test-file editing mistake during projection work.
All earlier offer/handoff/session tests remain included. Client all-target/all-feature
Clippy with warnings denied, changed-contract ESLint, file-size and whitespace checks
passed. Evidence: `native-surface-placement-contracts.log`,
`native-surface-placement-projection-fixed.log`,
`native-surface-placement-clippy.log`, `native-surface-placement-lint.log`.

The required terminal compatibility gate is still running under
`native-surface-placement-terminal-gate.log`, live command handle 90444 when recorded.
Placement admission/projection is not app rendering: native provider activation,
import-to-scene wiring and final packaged/physical/performance qualification remain
unfinished. No capability was enabled or release made.

### Native surface GUI import and prepared paint boundary

The macOS GUI now has an import adapter that attaches the accepted storage lease
to the CoreVideo buffer, projects only against the exact committed pane identity,
and suppresses incoherent and selected-pane history presentations. Prepared paint
items retain the buffer through GPUI's surface painter and are clipped to the
terminal viewport. The app accepts a batch only for the same DisplayFrame and
at most eight surfaces. The general mutable CoreVideo type remains private behind
a narrowly documented immutable Send wrapper; no Sync or pixel mutation API is
exposed.

The GUI library suite passed 3,142 tests with 16 ignored. New tests exercise worker
transfer, final retained-owner retirement, placement, history suppression, and
replaced-identity rejection. Client/GUI all-target/all-feature Clippy with warnings
denied, formatting, file-size, and whitespace checks passed. The preceding terminal
compatibility gate also completed successfully. Evidence:
`native-surface-gui-paint-tests-transfer.log`,
`native-surface-gui-paint-clippy.log`, and
`native-surface-placement-terminal-gate.log`.

This is an integration boundary, not an enabled native provider: no production
transport populates the prepared native batch yet. Provider registration, positive
negotiation, original-socket retirement dispatch, and final packaged native-window
and performance qualification remain outstanding. Linux validation is running in
`native-surface-gui-paint-linux.log` (command handle 29554 when recorded).

### Connection-owned native import and retirement

The GUI native boundary now composes the client admission session, process-scoped
rendezvous, mutual kernel proof, native delivery and CoreVideo import into one
worker-owned Connection. Incoming rights resolve their pane only through a matching
admitted sequence/ticket. Import rechecks the current committed pane. Each poll
imports at most one right, fallback revokes endpoints while retaining original
connection retirement, and close suppresses late acknowledgments without releasing
storage still held by a paint item.

Two real Mach-delivery tests now cover the complete adapter path through retained
paint ownership: fallback emits retirement only after the final owner drops, while
disconnect suppresses that retirement. Duplicate peer metadata preserves endpoints.
The GUI suite passed 3,144 tests with 16 ignored (`native-surface-connection-gui.log`).
All surface client tests passed in the combined run; that run failed an existing
upload test with UploadTimeout (613 passed, one failed, five ignored). The upload
test passed alone in 0.19s, but the full-suite failure remains unresolved evidence,
not a green gate (`native-surface-connection-tests-fixed.log`,
`native-surface-upload-diagnostic.log`).

The earlier Linux gate terminated with compiler SIGKILL and no source diagnostic.
Docker reports about 4 GB memory. The lint harness now disables incremental query
graphs while preserving compiled dependency caches, to reduce compiler memory use;
the gate must be rerun. The adapter is still not attached to the production socket
or advertised as a capability. Provider registration, socket wiring and final
packaged physical/performance qualification remain required.

Client/GUI all-target/all-feature Clippy passed for this connection adapter
(`native-surface-connection-clippy.log`); formatting, file-size, shell syntax and
whitespace checks also passed. The Linux rerun is active in
`native-surface-connection-linux.log`, command handle 11384 when recorded.

### Native platform owner in the terminal stream worker

The renderer-neutral native session now has an optional platform-driver entry.
Its owner starts only after authenticated Ready, receives native controls with
the worker's exact committed-pane map, and polls through the existing maintenance
timer. Cancellation, authentication failure and worker exit close that same owner;
there is no added thread or event queue. Explicit remote-peer options reject this
entry. Existing broker/controller entry points continue without a platform owner
and reject unsolicited native controls, preserving default and SSH behavior.

Real WebSocket tests verify worker-thread start, timer polling, retained commit
pointer identity, cancellation cleanup, and authentication failure without start.
All three focused tests passed (`native-surface-worker-tests.log`). The full client
suite passed 616 tests with five ignored (`native-surface-worker-client.log`),
including the upload test that timed out in the earlier combined run. That earlier
intermittent failure remains recorded rather than being attributed to a fix.
Client/GUI all-target/all-feature Clippy passed (`native-surface-worker-clippy.log`),
as did formatting, file-size and whitespace checks.

The preceding Linux rerun completed both all-feature and no-default-feature Clippy
successfully with incremental compilation disabled (`native-surface-connection-linux.log`).
It covers the prior connection adapter snapshot; the worker-hook changes above
were validated on macOS. The platform-specific GUI Driver implementation, broker
provider negotiation and image publication into the prepared scene are still
required before native surfaces can be enabled. No capability or release changed.

### macOS driver and retirement-driven worker wakeups

The macOS Driver now implements the native stream-worker interface. It prepares
the process-scoped endpoint after authenticated readiness, joins admitted offers
with native rights, imports them off the UI thread, and publishes at most eight
Images through a nonblocking inbox. Fallback/disconnect revoke a shared live flag,
which also fences already-drained Images and prepared Paint items. The normal
application still does not instantiate this driver; broker negotiation and scene
publication remain unfinished.

Final storage release now posts a bounded, coalesced wake notification after
queueing retirement. The original pool remains the sole consumer of retirement
records. Static imported images do not require periodic worker polls: maintenance
is armed only while registration, proof or an admitted native handoff is pending.
Retirement wakes the existing worker without extra control traffic. Closing the
connection suppresses both late retirement records and wake notifications.

A real WebSocket + Mach + CoreVideo fixture passed through NativeSession and the
GUI Driver, delivered an imported Image to its inbox, and observed the exact
retirement message on the original socket after final release. Separate tests
verify timer-free wake dispatch, notification coalescing without stealing ACKs,
and revocation of projected images. Full suites passed: 618 client tests (five
ignored) and 3,145 GUI tests (16 ignored), recorded in
`native-surface-driver-full-tests.log`; the focused fixture run is in
`native-surface-driver-tests.log`. This is transport/import evidence, not physical
window or performance qualification. Formatting, file-size and whitespace checks
passed; final lint results are recorded separately when complete.

Client/GUI all-target/all-feature Clippy passed for this driver and wakeup path
(`native-surface-driver-clippy-final.log`). Linux validation of the updated source
is running in `native-surface-driver-linux.log`; no native capability was enabled
and no release was made.

### Native scene publication and immediate consumer revocation

The native GUI update path now projects a bounded retained image scene into
State.native_surfaces, binding every batch to the exact DisplayFrame. Unchanged
projections are reused. History and incoherent geometry suppress drawing without
reimporting storage; replaced committed panes discard old images. Connection
revocation clears the state's native batch. Dropping its inbox immediately revokes
already-retained image/paint references, before asynchronous transport cancellation
completes, while backing storage still waits for its final owner before retirement.

Three focused scene tests passed, followed by the full GUI suite: 3,149 passed and
16 ignored (`native-surface-scene-tests.log`, `native-surface-scene-full-tests.log`).
Coverage includes equal-but-replaced display frames, projection reuse, history,
incoherent previews, replaced commit identity, retained old publications, and
consumer revocation before transport closure. The preceding driver Linux run
completed both feature configurations (`native-surface-driver-linux.log`).

Active connections now own the scene, but its inbox still defaults to None until
broker/provider negotiation attaches a native driver. This is prepared publication
wiring, not an enabled native feature or a verified physical window. Provider
registration, positive capability negotiation and final package/performance gates
remain outstanding.

Client/GUI all-target/all-feature Clippy passed (`native-surface-scene-clippy.log`).
The Linux scene/cfg validation is running in `native-surface-scene-linux.log`.
Formatting, file-size and whitespace checks passed. No release or capability
activation occurred.

### Controller startup preserves negotiated fallback and encodings

Controller now has an explicit native-driver entry that passes through the same
handoff graphics, local-image, binary-cell and alternate-screen settings as normal
startup. Previously the session-level convenience entry used default encoding
flags, which would discard these negotiated settings when connecting a driver.
The common session constructor rejects a native driver for an SSH-provenance
handoff or without the graphics fallback, before opening its socket or starting
the platform owner. Normal controller startup still supplies no native driver.

Real socket tests confirm binary/deferred-history negotiation survives driver
startup, and rejection tests confirm unsupported handoffs create neither a socket
connection nor platform endpoints. Six focused native-session tests passed; the
full client suite passed 620 tests with five ignored
(`native-surface-controller-tests-fixed.log`, `native-surface-controller-client.log`).
Formatting, file-size and whitespace checks passed. Linux scene validation from
the preceding pass completed both feature configurations
(`native-surface-scene-linux.log`). Provider registration and positive broker
negotiation remain outstanding; the normal app still has no native driver attached.

Client/GUI all-target/all-feature Clippy passed for the controller startup change
(`native-surface-controller-clippy.log`). No capability was activated or release made.

### Daemon native provider negotiation and revocation

Added a daemon-generation native provider registry and explicit capability 115
opt-in on the redeemed pane stream. Existing clients and absent providers retain
the unsupported fallback. Offers are fenced to allowed panes, generation and
monotonic sequences, with bounded per-connection and process metadata budgets.
Retirement stays on the original connection/provider after fallback or provider
replacement; wrong-socket and replayed acknowledgments are rejected.

Provider shutdown during open closes the returned owner without starting it.
Unregistering synchronously during peer or offer delivery also revokes start and
transfer authorization, rather than letting the caller send a native right after
fallback. Registry close releases metadata ownership, never authorizes GPU buffer
reuse. Real native backing remains the producer/receiver's responsibility.

The final focused suites passed 110 tests in two files
(`native-surface-provider-revocation-tests.log`); daemon TypeScript and changed-file
ESLint passed, as did formatting and whitespace checks. The full terminal release
gate passed before the final synchronous-revocation guards
(`native-surface-provider-terminal-gate.log`); those guards were checked with the
focused suites and type/lint checks afterward.

This registration interface currently uses injected providers in tests. Normal
app activation still requires an authenticated production provider, broker
capability selection and attaching the driver inbox to the active scene. No
native feature activation, release, physical GUI or performance claim follows
from these checks.

### Authenticated native producer control connection

The default macOS pane runtime now owns a native provider registry and exposes a
bounded owner-authenticated WebSocket control endpoint. Its upgrade requires the
exact owner bearer and subprotocol, rejects duplicate credentials, admits one
provider connection, and bounds registration time and output buffering. Provider
registration carries the daemon generation and full audit token; it does not
replace receiver-side kernel proof. Offers require an explicit accepted response
before the producer may transfer a native right. Original connection retirement,
fallback and close controls route back to that provider. Disconnect revokes its
registration and falls consumers back to existing graphics. Daemon shutdown
closes the provider boundary with the pane-stream boundary.

Real WebSocket registration/offer/retirement/disconnect and refusal tests passed;
119 focused tests, daemon type checking, changed-file ESLint and whitespace checks
passed. The full terminal release gate including installed-package journeys
passed (`native-surface-provider-channel-terminal-gate.log`).

Rust now has typed, bounded parsing for provider control and receiver proof
inputs plus registration encoding. Three codec tests passed
(`native-surface-provider-rust-codec.log`); full client tests and Clippy were
started in `native-surface-provider-rust-client.log` and
`native-surface-provider-rust-clippy.log`. This codec is not yet a connected native
producer. Production producer startup, capability discovery/selection and GUI
inbox attachment remain outstanding, as do final physical/performance gates.

Full client tests subsequently passed 623 tests with five ignored. Client
all-target/all-feature Clippy passed after scoping the existing test-only unwrap
allowance to the new test module. File-size and whitespace checks passed. The
provider codec is platform-neutral; no additional platform activation occurred.

### Rust local-owner native provider connection

`LocalDaemon::connect_surface_provider` now opens the provider WebSocket from a
verified private discovery record. It reuses the catalog endpoint identity proof
on the exact credential-bearing socket, rechecks the record before upgrade and
registration, requires the exact provider subprotocol, and accepts only a bounded
matching-generation registration response. The transport is background-only,
retains partial reads, bounds WebSocket buffering, polls typed controls, and
closes its socket on error/drop. No caller-supplied URL or SSH-forward provenance
can enter this local-only API.

A real socket test verifies credential-free identity requests, exact authenticated
upgrade and registration, mismatch rejection before credential disclosure, and
socket closure on drop (`native-surface-provider-transport-tests.log`). Full
client tests passed 624 tests with five ignored; all-target/all-feature client
Clippy passed (`native-surface-provider-transport-client.log`,
`native-surface-provider-transport-clippy.log`). Formatting, file-size and
whitespace checks passed. The producer still needs bounded frame submission and
lifecycle integration; this connection does not yet enable native app delivery.

### Bounded Rust producer submission and retirement ledger

Producer submissions now derive the wire offer from a committed pane, validated
cell placement and native backing layout. The encoder reuses the receiver offer
schema and checks UUID identities, canonical revision/hash, padded allocation and
control size before queueing. Each provider transport keeps a bounded ledger of
its original receiver connections, pending/accepted sequences and allocation
charges. Limits match the eight-frame/64 MiB connection and 32-frame/256 MiB
provider budgets. Queueing alone never authorizes a native right transfer.

Only a matching accepted response authorizes transfer; wrong-connection, premature
and replayed retirement fail closed. Fallback refuses new submissions and suppresses
a delayed acceptance while retaining accounting until close/retirement. Socket
writes preserve tungstenite's bounded pending buffer on WouldBlock rather than
resending an offer. Polling flushes pending output only after rechecking owner
identity. Closing drops metadata accounting, never grants GPU backing reuse.

A real socket test now runs registration, receiver start, submission, acceptance
and retirement before checking drop. A producer envelope also round-trips through
the receiver admission path. The full client suite passed 628 tests with five
ignored; Clippy passed (`native-surface-provider-submission-client.log`,
`native-surface-provider-submission-clippy.log`). A final cross-connection budget
test is in `native-surface-provider-submission-final-tests.log`.

Linux validation for the preceding provider transport completed both feature
configurations (`native-surface-provider-transport-linux.log`). Native producer
backing/handshake lifecycle integration and app capability activation still remain;
no actual native window/performance claim is made by these transport tests.

### Native producer backing owner integration

The macOS producer owner now connects the Rust provider transport to the platform
Sender and Frames owners. Authenticated receiver starts create bounded kernel
handshakes; only ready, authorized receiver/pane pairs accept source frames.
Offers derive layout from actual retained IOSurface backing. Producer polls consume
bounded control work and transfer only accepted FIFO offers after the mutual
kernel proof. Original retirement drops retained producer backing. Fallback
closes endpoints, discards never-transferred backing and keeps transferred frames
until retirement; close drops references without returning reusable buffers.

Added an explicit platform discard-unsent operation, which refuses transferred
frames, and a native producer test exercising the actual Mach handshake and
surface transfer. `cargo check -p herdr-gpui` passed
(`native-surface-producer-check.log`). The focused runtime test was launched in
`native-surface-producer-tests.log`; its result is pending at this checkpoint.
The producer owner is an integration API, not yet normal app activation or a
validated browser producer. Capability selection, producer startup/source wiring,
physical GUI measurements and final packaged validation remain outstanding.

The focused native producer test passed, using a real Mach handshake/right and
IOSurface backing. It verifies no transfer before accepted control, rejection of
unsent offers and retention across fallback until retirement. The Apple suite
passed 43 tests with four ignored; the full GUI suite passed 3150 tests with 16
ignored (`native-surface-producer-apple-tests.log`,
`native-surface-producer-gui-tests.log`). All-target/all-feature Clippy is in
`native-surface-producer-clippy.log`.

Client/GUI/Apple all-target/all-feature Clippy passed. The final platform test also
checks explicit unsent cancellation refuses transferred frames, rejects repeat
cancellation and leaves fallback able to discard another pending frame while
retaining the transferred one (`native-surface-producer-discard-tests.log`).
Formatting, file-size and whitespace checks passed. No build/test process remains
running at this checkpoint.

### Normal app capability negotiation and scene attachment

The authenticated daemon capability route now optionally reports native provider
availability only when requested with `nativeSurfaces=1`; legacy responses remain
unchanged. The production default runtime reports availability only for its current
owner and registered provider. Rust queries this only for a local macOS default
owner, verifies the complete daemon identity and protocol version, and keeps the
existing graphics fallback for unsupported/failed negotiation. An in-memory
handoff flag carries positive proof; pipe JSON cannot set it. A positive result
adds protocol 115 and causes the normal GUI worker to create its native driver and
attach that driver's inbox to the active scene.

The shared offer count now admits nine versions: interactive binary/graphics
already occupied eight, so the additive native offer otherwise failed schema
admission. The positive pane-stream test uses the actual nine-version offer.
Receiver platform registration failures before endpoint publication now fall back
without failing the terminal session.

108 focused daemon tests, daemon type checking and changed-file ESLint passed.
Client tests passed 630 with five ignored; the added exact-identity capability
regression test also passed (`native-surface-capability-tests.log`). Client/GUI
Clippy passed before the final capability-test extraction. The full GUI suite is
running in `native-surface-activation-gui.log`; the shared terminal release gate
is running in `native-surface-activation-terminal-gate.log`.

This is conditional normal-path wiring, not end-to-end qualification of an actual
registered renderer. Producer startup/source wiring, full package/lifecycle tests
and physical input/performance/memory measurements remain outstanding.

### Bind producer offers to the actual viewer delivery lane

Normal activation's full GUI suite passed 3150 tests with 16 ignored, and the
shared terminal release gate passed (`native-surface-activation-gui.log`,
`native-surface-activation-terminal-gate.log`). During end-to-end source-path
inspection, a missing binding was identified: a producer observing a pane through
its own read-only subscription has a different delivery nonce from the receiving
GUI. Forwarding that source nonce would make the receiver correctly reject every
offer, despite matching canonical content.

The daemon provider session now resolves the target pane's live delivery nonce
from its original pane-stream connection and substitutes only that nonce before
forwarding an offer. Closed, absent or generation-mismatched target channels
reject the offer. Generation, incarnation, revision, hash, ticket, layout and
sequence remain unchanged; exact canonical identity and placement admission are
still performed by the receiver. A producer cannot choose another viewer's nonce.

111 focused provider/pane-stream tests passed, including actual target nonce
binding, preservation of canonical fields and rejection after target retirement
(`native-surface-viewer-binding-final-tests.log`). Type checking, changed-file
ESLint and whitespace checks passed. Final Rust activation Clippy is in
`native-surface-activation-final-clippy.log`. The full terminal gate above predates
this final binding correction; final integrated qualification remains required.

### Real daemon/native producer roundtrip qualification

Added `native-provider-fixture.mjs`, which creates an owned scratch tmux server,
starts an explicitly selected rebuilt daemon CLI, promotes only its single test
session, runs the explicit native test executable, and records daemon/fleet
cleanup. The ignored native test discovers that private daemon, opens a separate
read-only canonical source, registers the real Producer, obtains a positively
negotiated viewer capability and starts the normal Controller with its driver.
It verifies differing source/viewer nonces, matching canonical hashes, actual
IOSurface import, and original-socket retirement reaching producer storage.

The first full run passed in `native-provider-live-1/test.log`; both cleanup
entries passed in its `cleanup.json`. This uses real daemon WebSockets, canonical
pane subscriptions, Mach handshake and native storage; it is not a physical GUI
paint or performance measurement. The disconnect assertion is being strengthened
to wait for the actual retained image live-fence to become false rather than
relying on a short polling delay. Its rebuilt test executable and Clippy are
running in `native-provider-live-final-build.log` and `native-provider-live-clippy.log`.

Linux activation validation completed both feature configurations
(`native-surface-activation-linux.log`). The fixture script passed syntax/lint
checks. No personal daemon or tmux session was used or stopped.

The strengthened real-daemon run passed in `native-provider-live-2/test.log`. It
waits for the viewer's actual native live-fence to invalidate after producer
shutdown, confirms the terminal controller still has its pane, and verifies a
new capability no longer advertises native surfaces. Source and viewer nonces
were different, the frame imported, and retirement released producer backing.
Both owned cleanup entries passed. Final client/GUI Clippy passed
(`native-provider-live-clippy.log`); syntax, formatting, file-size and whitespace
checks passed. This remains transport/import/lifecycle qualification, not physical
window paint, input latency or GPU throughput measurement.

### Native provider optimized package and memory harness

The optimized local build completed with binary SHA-256
`1d774207138ce9b8b1a045967f9a49d86f76cce40a20431446cfbd235717ef4f`
and source SHA-256
`9d6e551fd82b5920a4ef0977190c18571ae534ad69a0adb39d4ee71ae18d9e89`.
`native-provider-release-receipt.json` binds these identities. A new development
app, `Tmux IDE Native Provider.app`, was assembled separately from existing apps.
Notice generation initially failed with Cargo absent from PATH; assembly passed
with the pinned Rust toolchain and existing cargo-about environment.

`native-provider-packaged-startup/receipt.json` records successful normal launcher
startup, a native window, zero helper child processes, unchanged source panes and
the isolated daemon remaining ready after process termination. The desktop was
locked. This does not verify physical input, visual rendering or window close.

The memory harness now defaults to the normal no-argument Rust-owned app path.
The former Node broker path requires explicit `--transport legacy`; manifests
record that choice, and only legacy runs include a broker hash/process. The
scratch session is promoted before startup so native discovery can find it.
`native-memory-direct-smoke/cleanup.json` records completed workload smoke,
successful sampling and all owned cleanup. Smoke never launches the GUI and is
not a GUI memory result. Syntax, formatting and ESLint passed for the harness.
Full visible image/scroll memory qualification still requires manual arming.

The final `pnpm release:opentui:check` passed after the viewer nonce binding
correction (`native-provider-final-terminal-gate.log`). This includes installer
recovery, package contents and the installed TUI journey. It protects the shared
terminal release surface; it does not establish native GUI performance parity.

### Real managed-install Rust setup qualification

Added `native-managed-setup-fixture.mjs` and the opt-in client test
`owned_managed_install_bootstrap_and_reuse`. The runner packs the current npm
surface, installs it with lifecycle scripts disabled into a private scratch
HOME, copies the selected Node runtime and constructs the managed release layout.
It does not run the website installer or mutate a personal installation.

Starting with no daemon record, the test invokes `LocalSetupInstallation::run`,
discovers the real daemon through the normal authenticated Rust discovery path,
checks its version and repeats setup. The second invocation must retain the
same instance identity. The runner verifies unchanged source pane contents.
Cleanup checks the private record, exact managed Node/CLI command and kernel
process birth identity before terminating only that daemon, then retires the
scratch tmux fleet.

Both `native-managed-setup-1` and `native-managed-setup-2` passed with successful
cleanup. The second run records Node, CLI, test executable and npm tarball SHA-256
identities in `artifacts.json`. Six focused setup tests passed (one opt-in test
ignored in the ordinary run), client all-target/all-feature Clippy passed, and
formatting, script lint/syntax, file-size and whitespace checks passed. Logs:
`native-managed-setup-{build,tests,clippy}.log`.

This proves first-run bootstrap and idempotent reuse through the real installed
CLI and Rust API. It does not exercise clicking the GUI setup action. The Mac
remained locked and off-console during the latest check. Physical input, visible
scrolling, window-close behavior and GUI memory/performance remain unverified.
The preceding optimized app receipt predates this test-only source addition;
the final source/binary receipt must be regenerated before final packaging.

### Full workspace qualification after managed setup coverage

The macOS equivalent of `just ci` passed with a single Cargo build job:
formatting and file-size checks, workspace/all-target Clippy with all features
and with no default features, then workspace tests with default and all features.
The default run recorded 3,832 passing tests and 26 ignored tests across 17 test
results; the all-feature run recorded 3,866 passing tests and 33 ignored tests
across 19 results. Counts include library, binary, integration and documentation
test results; ignored external/native tests did not run as part of this gate.
The explicit live native-provider and managed-setup fixture results above remain
separate evidence.

Logs are `native-final-workspace-{format,clippy-all,clippy-none,tests-default,tests-all}.log`.
The existing dependency future-compatibility warning for `block v0.1.6` remains.
The pixel-surface prototype README now distinguishes the implemented authenticated
producer API from automatic integration in existing pixel applications; the
current concrete producer caller is still the owned integration fixture.

Linux workspace Clippy passed both all-feature and no-default-feature configurations
on aarch64 Ubuntu (`native-final-workspace-linux.log`, 53.64 s and 47.19 s).
Windows was not qualified on this host. The related Sfora browser report was
re-read: it recommends a separate local WKWebView feature with SSH-proxied network
traffic, rather than a new remote streaming engine. It does not supply an existing
native IOSurface producer integration. Preserve that distinction when reporting
the current surface API and the broader browser roadmap.

### Refreshed package and direct renderer measurement harness

`native-final-release-receipt.json` records the optimized binary SHA-256
`1d774207138ce9b8b1a045967f9a49d86f76cce40a20431446cfbd235717ef4f`
against source SHA-256
`f0b0d7b84357733378b0b0dbe2db8ab935fdb71e90af459dc4c7dda3dd30c003`.
The binary remained identical after the test-only addition. The fresh local
`Tmux IDE Research Verified.app` assembly passed receipt and dependency checks.
`native-final-packaged-startup/receipt.json` verifies its normal launcher creates
a native window with zero metadata helper children, and process termination
preserves the isolated daemon and source panes. The desktop was locked; no
screenshot, physical input or window-close result is claimed.

The renderer measurement harness now defaults to Rust-owned local/SSH startup.
Remote mode uses `--tmux-native-ssh` with the explicitly owned local daemon;
`--transport legacy` retains the previous broker path for explicit comparisons.
Manifests record the selected transport and include a broker hash only for legacy
mode. The scratch workspace is promoted before launch. A malformed receipt file
fails qualification and is recorded as a cleanup/receipt failure instead of
silently producing a successful partial measurement.

Local and SSH setup smoke runs passed with all cleanup entries successful
(`native-renderer-direct-local-smoke` and `native-renderer-direct-ssh-smoke`).
These smoke runs launch neither GUI nor TUI and intentionally have no valid
measurement receipts. Script syntax, ESLint, formatting and whitespace checks
passed. The actual renderer trials, physical input, visible scrolling and GUI
memory qualification remain pending an unlocked desktop and manual interaction.

### Unlocked desktop reproduction: native Home presence (2026-10-26)

The saved optimized bundle's receipt verified after reboot. Actual window
inspection exposed two problems that startup/smoke tests did not cover:

- The measurement harnesses launched the bare binary with no arguments, which
  opens the read-only preview. The real bundle launcher passes
  `--tmux-native-local`. Both local measurement launch paths now use that flag;
  explicit Rust-owned SSH and legacy modes keep their respective arguments.
- The native Home catalog displayed its healthy isolated session as unavailable.
  The local catalog owner consumed presence revisions but never published their
  acknowledgement when no terminal stream existed. Home therefore could not
  satisfy its presence admission gate. The owner now publishes the handled
  revision when no route is open; an active terminal still relies on its
  controller for admission.

The new regression `home_presence_acknowledges_focus_without_an_open_terminal`
failed before the change at revision 1 (`native-home-presence-before.log`).
Afterward the GUI library suite passed 3,151 tests, with 17 ignored
(`native-home-presence-after.log`). The corrected optimized bundle visibly opens
the isolated session and renders its ready marker. Its binary SHA-256 is
`1c752c07c6fe97c3dbd084d881bedf2149d3daba425b44a6f3683dd69b795762`
(`native-home-focus-release-receipt.json`). No physical performance result is claimed.

The two attempted visible memory runs were never armed. The second workload
reached its 180-second arming deadline, exited, and the geometry sampler stopped
the fixture; owned cleanup succeeded. Sampling exceptions now retain bounded
diagnostics. Their evidence directories are `native-memory-visible-20261026` and
`native-memory-visible-20261026-2`; neither is a valid memory qualification run.

### Visible HD image and history run (2026-10-26)

`native-memory-visible-20261026-5` completed the full 191-second workload with
sampling and owned cleanup successful. Computer Use confirmed Home session
opening, the ready marker, HD pattern rendering, scrolling to older text,
returning to live output, and image disappearance after deletion. Geometry stayed
89 by 25 for every armed sample. The first wheel event after returning to the app
showed input interruption; clicking the terminal restored admission and scrolling.
These are synthetic correctness observations, not physical latency measurements.

Native process RSS was about 113 MiB at baseline, peaked at 581 MiB during image
updates, and ended at 309 MiB after 90 seconds idle. Daemon RSS went from 203 MiB
to a 513 MiB peak and ended at 423 MiB. The retained `rss-summary.json` contains
phase sample counts and endpoints. This single run demonstrates completion and
partial memory reclamation, not leak freedom or improvement over another build;
RSS excludes GPU allocation and includes allocator/framework caches.

Run 3 lost terminal authority/connection around a focus change during the image
workload and was stopped without qualification. Run 4 expired unarmed. Run 5 did
not reproduce that connection loss when checking focus before workload and after
deletion. Keep the earlier failure open for controlled reproduction; do not infer
it was fixed by a later successful run. The user requested automated checks for
now, so physical keyboard qualification remains deferred.

Both all-feature and no-default-feature GUI Clippy checks passed after the Home
fix (`native-home-focus-clippy.log`, `native-home-focus-clippy-none.log`), as did
script ESLint and formatting. Run 6 failed before arming because its kernel
identity witness could not execute; owned cleanup succeeded. Run 7 was a focused
reproduction: switching to Activity Monitor during HD updates and back retained
the tab and Connected terminal. Clicking the pane cleared the input-interrupted
notice and output continued. It was intentionally stopped early, with successful
cleanup, and is not a second complete memory qualification.

### Background image queue disconnect (2026-10-26)

The diagnostic build reproduced the connection loss while Activity Monitor held
focus across the baseline-to-HD-image transition. The native log reported
`terminal poll interrupted: graphics-backlog` in
`native-disconnect-visible-20261026-1`. This identifies local graphics queue
saturation rather than an SSH timeout. The diagnostic emits only a static error
category, never transport payloads or credentials.

The local image reader now pauses when the bounded graphics mailbox lacks room
for its next chunk and invalidations. A coalesced drain notification resumes it.
Socket controls, cancellation and maintenance continue while that reader is
paused; the existing queue limits and malformed/remote overflow handling remain.
The regression transfers a 9 MiB image through the real file worker, deliberately
holds the consumer, verifies control delivery during the pause, then checks every
byte and the original lease release. Disabling only the pause reproduces failure
(`native-graphics-backpressure-disabled.log`); the final client suite passes
632 tests with 6 ignored (`native-graphics-backpressure-client-tests.log`).
All-target client and GUI Clippy passes with all features and with no default
features (`native-backpressure-clippy.log`, `native-backpressure-clippy-none.log`). The GUI library suite also passes 3,152 tests
with 17 ignored (`native-backpressure-gui-tests.log`). Rust formatting and
whitespace checks pass.

The optimized binary is recorded in
`native-graphics-backpressure-receipt.json` with SHA-256
`ca83aa6127e6b7b8ff4b3d24f4c15bc0a4d3eb8694f5085ec1d699cf06c4b818`.
The fixed visible run `native-backpressure-visible-20261026-1` was never armed:
the desktop locked and the workload expired, causing geometry sampling to fail.
All owned cleanup succeeded. This is not a passing GUI reproduction or memory
qualification; repeat the same focus/HD-image path before closing that gate.

### Real pixel producer integration investigation

The terminal browser's Pixel source was inspected at
`zenbu-labs/pixel` commit `cdfdb9d6a424cb2c3774ccb258a9a6f9c4ceff0d`. Its
existing full-canvas Herdr transport uses private frame files and a different
JSON protocol; it cannot be advertised as compatible with tmux-ide's native
provider channel. The Chromium IOSurface alone excludes browser chrome. Its
current release callback also returns the Electron texture immediately after
submission, so sharing that mutable backing requires explicit retirement
ownership, not just forwarding an IOSurface pointer.

The application integration remains unimplemented. A first complete-frame path
can copy the browser's owned composited frame into immutable BGRA native backing
and use the authenticated provider/retirement API; that would bypass Kitty's
pixel encoding but must not be described as zero-copy Chromium rendering. A
production integration must also handle producer availability after a viewer is
already attached, resizing, bounded outstanding frames, and fallback. The
installed terminal-browser application has not been modified.

### Fixed background-image path verified (2026-10-26)

`native-backpressure-visible-20261026-2` completed the full 191-second HD workload
with sampling and owned cleanup successful. The app was backgrounded to Activity
Monitor across the baseline-to-image transition, then brought back during image
and history updates. Images and advancing text remained visible and the terminal
stayed Connected. The native log contains no poll interruption. Armed geometry
remained 89 by 25. These are synthetic correctness observations, not physical
latency or GPU-memory measurements. The deletion phase was not visually checked.
The initial Home row remained unavailable until Cmd-Tab delivered actual app
activation; window Raise alone did not activate it in Computer Use.

The shared native producer implementation now lives in the macOS
`tmux-native-surface-sdk` workspace crate and is re-exported by the GUI adapter.
This extraction lets the terminal browser reuse authentication and retirement
ownership without depending on the GUI application crate or adding a Node
transport. Its real Mach-handshake/retirement unit test passes; the GUI's owned
actual-daemon integration fixture remains separate. Application frame conversion,
browser wiring and availability after an existing viewer attachment remain work
in progress; the extraction alone does not enable a real browser.

### Composited canvas ownership adapter (2026-10-26)

The shared SDK now provides `canvas::copy_rgba`: a complete tightly packed RGBA
canvas becomes a fresh IOSurface-backed straight-alpha BGRA CoreVideo buffer.
It validates dimensions and byte count before allocation, checks native stride
and allocation bounds, clears row padding, and handles premultiplied input during
the same copy. CPU mapping is scoped to an RAII lock; no mutable source pointer
or borrowed browser canvas escapes. This is a CPU-copy path, not zero-copy
Chromium texture sharing.

Four SDK tests pass, including real native allocation, source mutation after
copy, padded rows, channel order, transparency, invalid dimensions, and the
existing real Mach transfer/retirement check (`native-producer-canvas-tests.log`).
All-target SDK Clippy also passes after using checked division for alpha-zero
conversion. Browser wiring is still pending. Inspection identified two further
integration requirements: a source-only pane subscription should avoid fetching
its own graphics payloads, and a browser starting after a viewer attaches must
negotiate native delivery without requiring manual reconnect. The current
provider capability is sampled only at attachment, and receiver identity proof
has a five-second deadline; leaving a receiver waiting indefinitely is not a
valid fix.

### Producer source subscription (2026-10-26)

`ServerClient::issue_surface_source` now issues a local, same-generation,
read-only, single-pane subscription with binary cells (versions 1/109) but no
graphics, image-file lease, native-surface receiver, or alternate-screen
projection. Ordinary GUI terminal negotiation remains unchanged. This gives an
application producer canonical pane identity without downloading the images it
is producing. The actual-daemon producer fixture now uses this entry for its
source; its receiving viewer retains ordinary graphics negotiation.

A socket test observes the actual authenticated request, verifies the cell-only
version offer and read-only pane set, checks the resulting handoff, and rejects
interactive/multi-pane requests before network access. The client suite passes
633 library tests, 2 non-ignored integration tests and 1 doc test (6 library and
3 external integration tests ignored). Client/SDK all-target Clippy passes.
Logs: `native-producer-source-{tests,client-tests,clippy}.log`. The updated live
native-provider fixture still needs rerunning with the final browser adapter.

The source offer intentionally omits capability 101. Version 109 selects binary
cell encoding and supports binary blobs only when graphics are separately
requested; `terminal-delivery-hub.ts` creates a graphics delivery handle only
when 101 is present. Thus the source receives neither graphics announcements nor
blob downloads, rather than merely ignoring downloaded pixels in Rust.

### Complete-canvas publisher and real daemon proof (2026-10-26)

The SDK `publisher::Publisher` joins the read-only source subscription, native
producer authentication and owned canvas conversion. It retains one latest
canvas, allows at most two submitted frames per receiver, and polls retirement
while idle. Superseded unsent canvases are dropped. Daemon-rejected offers can be
retried against refreshed canonical state without recopying pixels. Resize waits
for matching canonical pane geometry. Closing or failure retires the source and
native provider so the caller can return to Kitty output.

`native-publisher-roundtrip-20261026/test.log` passes the owned actual-daemon
fixture extended with this publisher. It stops polling the receiver, publishes
twelve different complete RGBA canvases, verifies the submission count never
exceeds two, resumes delivery and checks the final imported BGRA pixel value.
This crosses actual daemon capability issuance, canonical pane state, native
provider control, authenticated Mach transfer, receiver import and retirement;
it is stronger than a queue-only unit test. Owned daemon/fleet cleanup succeeded.
The GUI library test binary compiled successfully, and the four SDK tests pass.

This is still a synthetic application canvas, not the terminal browser itself.
The Pixel checkout is unchanged. Next is its render-worker adapter, explicit
native configuration and Kitty fallback, plus native availability changes after
an existing GUI attachment. The publisher must be polled while the browser is
idle so a last superseding frame is not stranded behind GPU retirement.

### Pixel render-worker adapter (2026-10-26)

The pinned Pixel development checkout now calls the shared publisher from its
terminal render worker. An explicit `TMUX_IDE_NATIVE_SURFACE` route selects the
verified local record/server/session/pane. No configuration or receiver preserves
Kitty output. Idle polling drains native retirement, and receiver changes request
redraw. Returning to Kitty invalidates both patched-image and animation caches,
so an unchanged page can be repainted rather than incorrectly skipped.

`pixel-native-adapter-pinned-check.log` records a successful `cargo check -p
pixel-node` including the modified core and Node binding. The initial attempt
resolved GPUI 0.3.20; it was stopped, then the lockfile was seeded from the native
workspace and the successful run uses the pinned 0.3.19 renderer. No installed
browser was changed. Engine unit tests are being built separately; their result
must be inspected in `pixel-native-adapter-tests.log`, not inferred from check.

The source patch, pinned revision/checksum and guarded preparation script live in
`integrations/pixel/`. Applying it to a fresh clone reproduced the exact adapter
and lockfile, and a second application correctly refused to overwrite edits.
The actual browser runtime and dynamic native availability remain unqualified.

### Maintained terminal-browser build and startup (2026-10-26)

Pixel now lives in the terminal-browser repository. The development integration
is pinned to `zenbu-labs/terminal-browser` revision
`660ec51e0ec0e5172338a2920e50089943882af4`, with the original Pixel revision retained
as provenance. A fresh shared clone accepted the integration patch and reproduced
the maintained checkout's adapter and pinned lockfile exactly.

The maintained checkout's native Node binding builds with `cargo build --locked
-p pixel-node`; all 256 core Rust tests pass, with one ignored. Pixel, shared,
browser and CLI TypeScript builds pass. Their JavaScript suites pass 49, 5 and
38 tests respectively. The macOS scroll helper also builds. Evidence is under
`gui-main-integration-20261023/terminal-browser-{native-build,native-tests,js-build,js-tests}.log`.

Electron 44.2.0 successfully loads the new Node binding. With private XDG paths,
a private browser profile and telemetry disabled, the browser daemon accepts its
own socket connection, acknowledges shutdown with zero sessions, and exits zero.
See `terminal-browser-startup-smoke.json` and its log. The native binding was
copied only into the separate source checkout; the installed browser is unchanged.
This proves loading and startup, not rendering, input latency or fallback.

Remaining: the real in-pane browser/chrome workload, native availability when a
browser starts after GUI attachment, receiver-loss/idle-page fallback, mixed
native/plain-terminal viewers, and usable launch-context configuration. The goal
remains active and nothing in this integration has been released.

### Actual terminal-browser native rendering and idle fallback (2026-10-26)

`native-browser-pane-20261026-1` runs the maintained browser in an owned tmux
pane with a private browser profile, local static page, and isolated daemon.
Computer Use opened its GUI session and observed the complete browser toolbar,
page, and scrollbar. Scrolling visibly advanced through the numbered sections.
After a fresh native-capable viewer attachment, a tmux output pipe captured zero
bytes while the visible page advanced from section 10 to section 14. Detaching
that viewer without changing the page produced 18,089 bytes, including Kitty
and tmux DCS sequences. This positive fallback control establishes that the
pipe was working and distinguishes native updates from identical-looking Kitty
rendering. Reattaching and hiding the GUI sidebar expanded the page viewport
while the connection remained live. See `transport-observation.json`,
`native-scroll-output.bin`, and `binaries.json` for the exact scope and inputs.

This is functional evidence, not a performance measurement. It does not prove
late native negotiation when the browser starts after an already-attached GUI,
simultaneous plain-terminal/native viewers, or long-running memory behavior.
The fixture's cleanup exposed a harness bug: Node's exitCode stays null after a
signal exit, so its second wait could hang. The fixture now also checks signalCode.
Exact owned children and the isolated tmux server were cleaned up manually, and
all recorded child PIDs were verified absent. Evidence directories were retained.

Late negotiation still needs an explicit native-channel lifecycle on the existing
terminal socket. In particular, current retirement controls identify only a
sequence, while the socket currently allows only one native receiver. Supporting
replacement native negotiations must preserve the old GPU retirement route and
prevent a reused sequence from acknowledging a replacement provider's storage.

### Native availability and scoped retirement groundwork (2026-10-26)

The registry now supports bounded availability observers, with one coalesced
microtask notification and cancellation before delivery. The provider's register
acknowledgement precedes notification, preventing a viewer from opening a channel
before the producer has entered its registered state. Shutdown notifies observers
of unavailability and releases subscriptions; a failing observer cannot prevent
other observers from receiving updates. This is not yet wired into the GUI's
native negotiation lifecycle.

Native retirement controls now include generation and connectionNonce. The
current single-receiver socket validates both before acknowledging a sequence.
The regression gives two receivers a valid sequence 1 and proves that an ACK
using the first receiver's nonce cannot retire the second receiver's storage.
Rust emits the original nonce even after fallback, and emits no ACK after close.
This prepares safe routing for multiple native negotiations on one terminal
socket; the multiple-negotiation lifecycle itself remains to be implemented.

The incompatible native control change uses capability 116 instead of 115.
Older participants therefore use the existing Kitty fallback. The previously
recorded browser GUI run used capability 115 and remains historical evidence;
capability 116 must be rebuilt and qualified across daemon, browser SDK and GUI
before claiming the new lifecycle works end to end. Focused daemon tests pass
126 tests, contracts pass 29, and the Rust client library passes 634 with six
ignored. See the `native-scoped-retirement-*` logs for subsequent build results.

The updated GUI's focused native tests also pass (six passed, one ignored),
including kernel delivery, paint-owned retirement and the worker wake path.
Daemon TypeScript checking and focused ESLint pass. The CLI was rebuilt, and
`native-scoped-retirement-roundtrip-20261026/test.log` passes the actual owned
daemon producer/canvas roundtrip on capability 116, with daemon/fleet cleanup
both successful. Browser-in-pane qualification of capability 116 remains pending
until the lifecycle wiring is complete and all application binaries are rebuilt.

### Late native availability and provider replacement (2026-10-26)

The existing authenticated terminal socket now accepts an explicit native watch.
The daemon announces a fresh, server-issued negotiation nonce when a provider is
available; no provider means no native endpoint or handshake timer. Capability
116 distinguishes supported native watching from current provider availability.
A viewer cannot choose a replacement nonce or resurrect a consumed negotiation.
The daemon retains at most eight native negotiations per terminal socket, each
with its original scoped retirement route. Old entries close only after their
outstanding frame count reaches zero, or when the terminal connection closes.

The Rust receiver watches without reconnecting the terminal. Availability starts
a fresh authenticated kernel handshake; replacement moves the old connection to
a bounded retirement-only set. Each native negotiation has a separate drawable
flag, and a separate publication-owner flag fences every image when the UI inbox
is dropped. Starting a new negotiation never revives old retained images.

`native-viewer-lifecycle-roundtrip-20261026-1/test.log` passes the actual daemon
fixture extended with a six-second provider-free wait (longer than the native
handshake timeout), late producer startup, actual pixel import, provider
replacement while the old image remains retained, and retirement isolation.
Dropping that old image leaves the new provider's one frame outstanding; dropping
the new image then retires it. The same terminal Controller remains active for
the whole sequence. Daemon and scratch-fleet cleanup both pass.

Focused daemon suites pass 130 tests before the additional subscription-exhaustion
case; the lifecycle bounds suite passes all four cases afterward. All 606
contract tests pass. Six focused GUI native tests pass (one live test ignored in
that command and run separately above). Clippy for GUI/SDK all targets/features
passes. The optimized GUI is being built for the real browser late-start check.
Simultaneous native/plain-terminal fallback and launch-context configuration
remain pending; this is not released support.

The subsequent optimized GUI and browser binding builds both passed. In
`native-browser-late-20261026-1`, the GUI terminal tab was opened before starting
the browser. The browser then appeared with its complete chrome on that same
tab. Scrolling from section 1 to sections 10–11 produced only 14 terminal bytes
(OSC 22 default cursor), with no Kitty image frames. Closing the GUI tab produced
18,106 cumulative bytes, including one Kitty image frame and its tmux DCS wrapper,
for the unchanged page. This positive control confirms the capture was active.
`transport-observation.json` records the observations; `cleanup.json` confirms
the browser, GUI, private daemon and scratch fleet all stopped successfully.
This verifies late negotiation in the actual browser and GUI, not performance
parity, simultaneous terminal viewers, or automatic launch configuration.

### Ordinary terminal presence for mixed-viewer fallback (2026-10-26)

The mirror now exposes an optional three-state native-client presence observer.
It requests initial inventory after startup, invalidates presence on attachment
notifications, and proves presence/absence using the control channel's
`list-clients` response. Malformed inventory, transport failure and channel exit
remain unknown, which must preserve ordinary image output. An attachment change
during an inventory request invalidates that answer and schedules one coalesced
follow-up; it cannot publish stale absence or grow a request queue. Existing
activity-only geometry observers retain their previous coalescing behavior.

The session-channel and mirror-service suites pass all 215 tests, including
initial absence, attachment, malformed inventory, changes during a pending query,
disposal and channel exit. Daemon typechecking and focused ESLint pass. This is
the observation seam only: the native producer fallback policy is not wired to
it yet. Pane-stream viewer demand, producer notification and the simultaneous
GUI/plain-terminal journey remain required before mixed fallback is complete.

The daemon-side demand path is now wired. A bounded `NativeSurfaceDemand` owner
combines per-pane stream viewers with ordinary-client presence. Native negotiation
updates the stream's demand; pane/socket closure releases its entries. Raw streams
continue requiring Kitty, while the producer's graphics-free source subscription
does not count as an image viewer. Unknown presence, capacity overflow, missing
pane observations and owner closure all preserve fallback. Production constructs
this owner before starting session mirrors so initial presence is not lost.

Authenticated producers may opt into one immutable `watch-demand` request for up
to 32 semantic panes. Coalesced, deduplicated `kitty-demand` controls describe which
of those panes still require Kitty. Unsubscribed producers receive no new controls.
Five focused suites pass 128 tests; the subsequent websocket test also proves
that an ordinary stream joining a native viewer requires fallback only for its
pane, and closing that stream restores native-only demand (104 websocket tests
pass). Typechecking and focused lint pass. The Rust SDK and browser have not yet
subscribed to this new control, so simultaneous rendered GUI/TUI output remains
unqualified and the browser still needs its dual-output implementation.

### Browser consumes mixed-viewer demand (2026-10-26)

The Rust provider transport now validates demand against its immutable watched
pane set. Missing/unverified demand preserves Kitty, unknown panes cannot suppress
it, and a changed watch is rejected. The SDK publisher subscribes for its source
pane. Pixel continues native submission while also drawing Kitty when required;
changes in either receiver availability or fallback demand invalidate its output
caches and trigger an idle-page redraw. Tests pass: 636 Rust client tests (six
ignored), four SDK tests and 256 Pixel tests (one ignored). Client/SDK Clippy for
all targets/features passes. The Node binding and daemon CLI build successfully;
the regenerated pinned integration patch applies to a fresh checkout.

`native-browser-mixed-20261026-1/transport-observation.json` records an actual GUI
with a separate ordinary tmux client attached through an isolated PTY. Before
attachment, native scrolling produced only 14 cursor-control bytes. Attaching
the client to the idle browser caused Kitty output without reopening the GUI tab.
While both viewers were attached, GUI scrolling remained visible, and the ordinary
client captured 22 Kitty commands (559,949 total terminal bytes). After that client
exited, the same GUI scrolled to sections 14–15 with zero additional terminal
bytes. Control-mode inventory separately confirmed the ordinary client was present.
The terminal client's cleanup receipt and all browser/GUI/daemon/fleet cleanup
entries pass. This proves delivery to a real tmux client, not rendered pixels in
a separate terminal emulator or a performance benchmark. Automatic launch-context
configuration and final broader qualification remain outstanding.

### Resolve browser launch location through the owner (2026-10-26)

The scoped, owner-authenticated `native-surface-context` POST route now resolves
an inherited tmux socket path, server PID, session ID and raw pane ID into the
current semantic source. The generation-pinned owner checks the native tuple,
trusted inventory, registered workspace and live session twice, rejecting changed
pane/window/birth identity rather than selecting another pane. Inputs are bounded
and validated before invoking tmux; errors expose no native paths or credentials.
Both default and separately registered owners use this resolver.

The resolver and scoped-router suites pass 23 tests. Daemon typechecking and
focused lint pass. `native-context-live.json` records the rebuilt daemon resolving
an actual promoted scratch pane, rejecting wrong socket/PID/session inputs and
requiring owner authentication; private daemon/fleet cleanup passes. This is the
daemon half of automatic launch configuration. The Rust client and browser still
need to derive their location from the launching terminal environment and call
this route; the explicit JSON configuration remains in the browser until then.

### Browser derives its own local source (2026-10-26)

Pixel now derives its source from the launching terminal’s TMUX, TMUX_PANE and
validated local runtime namespace. The shared browser process does not substitute
its own environment. Explicit fixture configuration remains available, but an
invalid explicit value cannot silently select another inherited source. The Rust
client checks the owner generation and validates the resolved read-only selection.
Client tests pass 639 cases (six ignored), Pixel tests pass 257 (one ignored),
and the Node binding builds. The updated patch applies to a clean pinned checkout.
Rust workspace formatting and the 1,000-line limit check pass.

`native-browser-automatic-20261026-1/transport-observation.json` confirms the
actual launch payload contains no explicit surface JSON. The GUI displays full
browser chrome and scrolls from section 1 to sections 10–11 while producing only
14 cursor-control bytes and no Kitty command. Closing the tab produces one Kitty
command for the unchanged page. Reopening retains the same browser and scroll
position and allows scrolling to sections 14–15. That final capture includes the
reopen transition, so its one Kitty frame does not establish the subsequent
steady-state transport; a separate capture remains necessary. All owned GUI,
browser, daemon and fleet cleanup entries pass. The terminal release gate and
updated Rust client/SDK Clippy were started after this run.

### Automatic browser replacement and recovery (2026-10-26)

`native-browser-automatic-replacement-20261026-1` keeps the original tmux pane
and GUI tab open while terminating and reaping its owned Electron browser, then
launching a new browser process. The new process discovers the same semantic
source automatically, renders the full chrome/page in that tab, and scrolls to
sections 10–11 with 14 cursor bytes and no Kitty command. A later tab close/reopen
recovers the page; a separate post-reopen baseline captures zero terminal bytes
while scrolling to sections 14–15. This resolves the transition ambiguity in the
previous run. PID replacement and byte counts are recorded in `replaced.json`
and `transport-observation.json`; all owned-process cleanup entries pass.

Client/SDK Clippy passes both all-features and no-default-features configurations.
The broader Rust workspace CI sequence is running directly from the justfile
recipes because `just` is unavailable. Both workspace lint configurations passed;
workspace tests are compiling. The terminal release gate passed its unit, renderer
and package-content checks, but its installed-package build rejected global Bun
1.3.11. A new full run uses the existing pinned Bun 1.4.2 runtime; its result is
pending. None of this work has been committed, published or installed over the
user’s application.

### GUI browser follow-up qualification complete (2026-10-26)

The current local macOS follow-up is implemented and qualified, but unreleased.
The actual background/foreground HD-image workload completed for 191 seconds
without the reproduced graphics-backlog disconnect. Browser integration now
qualifies full chrome, automatic authenticated launch discovery, scrolling,
viewport expansion, late startup, process replacement in the original GUI tab,
idle fallback, and recovery. Mixed ordinary tmux/native viewers receive Kitty
when required and return to native-only delivery after the ordinary client exits.
Scoped retirement is separately verified while an old GPU image remains held
across provider replacement. Bounded submission/allocation/demand regressions pass.

`native-browser-qualification.json` indexes the exact runtime evidence and hashes
the GUI, browser binding and integration patch. The full macOS workspace sequence
passes formatting, file sizes, both Clippy feature configurations, 3,845 default
tests (26 ignored) and 3,879 all-feature tests (33 ignored). Linux workspace Clippy
passes both feature configurations (`native-browser-linux.log`). The full shared
terminal release gate passes with pinned Bun 1.4.2
(`native-browser-terminal-gate-pinned.log`). Windows compilation was attempted but
cannot proceed without its Rust standard-library target; Windows is unqualified.

Limits remain explicit: this is a local macOS native surface integration with an
owned CPU copy into IOSurface, not zero-copy Chromium texture sharing or a remote
streaming implementation. Captured Kitty delivery does not prove rendering in a
separate terminal emulator. These checks do not claim physical input latency,
GPU memory measurements, or completion of the broader local-WKWebView/SSH-proxy
roadmap. No installed application was replaced and no release was published.
