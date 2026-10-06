# Executable tmux boundary contract

This correctness gate covers capture/output delivery, a real
attach/output/resize/reconnect journey, and cross-pane control scheduling.
It does not establish performance parity or complete terminal correctness.

## Run

Build the bundled runtime with `pnpm build:tmux` if needed, then select its exact
executable. For example, on Apple Silicon from the repository root:

```sh
TMUX_IDE_BOUNDARY_TEST_BINARY="$PWD/packages/daemon/dist/native/tmux/darwin-arm64/tmux" \
  TMUX_IDE_ORACLE_EXPECT_NATIVE=1 \
  pnpm test:tmux-boundary
```

The command requires an absolute executable path and an explicit expected
physical-capture capability (`1` for bundled tmux, `0` for stock compatibility).
It fails if the selected server does not match that expectation. It prints the
binary's version and SHA-256 and runs the models, application journeys, independent
cell checkpoints and scheduler wire
cases. Python 3 is required for the wire cases; their raw traces and JSON receipts
are retained in the printed temporary evidence directory. A missing binary fails
the command. The ordinary daemon
suite always collects the model; its live lane skips this optional qualification
when no binary was selected. The explicit gate cannot pass by skipping it.

The complete gate qualifies the patched bundled runtime: native guarded input
and scheduler-barrier cases require its extensions. Setting the physical oracle
expectation to `0` does not make the whole gate a stock compatibility gate.
Run selected stock-compatible live fixtures separately with the stock binary.

The live fixture owns a UUID-named tmux socket, a noninteractive pane and one
attached PTY client. It disposes the replica and control connections and kills
only its own server. It does not attach to production sessions.

## Boundary and authority

```text
tmux PTY/input parser and grid (authority)
  → control-mode replies and output
  → MirrorControlChannel (ordered reply matching, inline callbacks)
  → SessionChannel / PaneFeed (identity, geometry and capture generation)
  → SessionRuntimeTerminalReplicaOwner (canonical interpretation)
  → seed/patch consumer (replicated state)
  → renderer (separate verification boundary)
```

The relevant upstream source is tmux commit
[`e476c123`](https://github.com/tmux/tmux/tree/e476c1230b958df0cb12977517d24b3dc931375b),
also recorded in `native/tmux/provenance.json`. Our runtime additionally carries
the patches listed there; the test command records the actual binary identity.

| Contract or assumption                                  | Source evidence                                                                                                                                 | Test obligation                                                                                                                |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Capture replies participate in the control output queue | Upstream `cmd-capture-pane.c`, `cmd_capture_pane_exec`, calls `control_write`; `control.c:420–429` queues lines behind global blocks            | Establish the capture/output seam before splicing a snapshot into live output                                                  |
| Per-pane and global queues are distinct                 | `control.c:505–514` adds output to both queues; `control_write_pending` drains a per-pane queue and flushes line blocks only at the global head | Do not infer unconditional capture/output ordering from FIFO command replies; verify cross-pane backlog separately             |
| Reply completion changes delivery state synchronously   | `control-channel.ts` reply queue and `session-channel.ts` inline capture callbacks                                                              | Same-read-chunk deltas must observe the completed capture state                                                                |
| New capture attempts supersede earlier attempts         | `pane-feed.ts`, `beginReseed`; session-channel retains retired reply slots while callbacks become no-ops                                        | Late old replies cannot replace a newer view or consume its response slot                                                      |
| Capture and cursor are separate observations            | `session-channel.ts` reseed probe and geometry checks                                                                                           | A generation/geometry change invalidates the candidate; a command receipt alone proves neither parsed PTY output nor rendering |
| Disconnect invalidates delivery                         | `PaneFeed.abortCurrent` and owner/service disposal                                                                                              | No updates reach a retired consumer; reattachment requires a new seed                                                          |

The initial journey has **one active output pane**. A separate isolated wire
experiment has confirmed that a sibling pane's backlog can allow post-capture
output to overtake the capture reply. It reproduces on the original, unpatched bundled tmux 3.7c
and a clean build of the pinned upstream commit. With control stdout temporarily
undrained, flood pane B, issue a capture of A followed by an execution barrier,
then make A print a unique marker only after that barrier. A's marker arrives
before the earlier capture response, which excludes it. Without the backlog,
the comparison run delivers the capture first.

This matches upstream `control.c:689–728` and
`control_write_callback:755–763`: global blocks can hold reply lines behind B
while A's per-pane output drains. FIFO command replies therefore do not establish
a universal capture/output seam. The transcript model below assumes that seam;
it does not test tmux's scheduler. TM02 owns the real integration reproducer and
correction, and TM07 must retain the multipane regression. A real MirrorService/canonical-owner fixture also reproduces a stale replica:
the native pane changes from `BEFORE` to `AFTER!`, while the replica remains
`BEFORE` with unchanged cursor and history size. That proves impact on ordinary
native `-R` reseeding, not every application recovery path. The specialized
native atomic snapshot path requires a paused target and an empty global block
queue before committing snapshot and stream offsets; preserve those guards.

The retained `tmux-boundary-ordering-live.test.ts` asserts the correct final
canonical content in this two-pane failure. With the previous application
implementation, it fails on the original bundled server and clean pinned stock
server. The ordered
`native/tmux/control-output-barriers.patch` corrects the bundled scheduler:
panes share a scheduling budget within each segment between queued control lines,
and no later segment can drain before the preceding line. Lines exposed by
age-triggered pause or discard are flushed before scheduling again.
`scripts/check-tmux-control-barriers.py` additionally exercises adjacent replies,
age-triggered pause, pane off/death and service of both flooding panes.

The server format `#{tmux_ide_control_output_barriers}` returns `1` only for the
patched scheduler. A new client connected to an old server does not provide this
guarantee. The client also uses the stock-server snapshot protocol below; its
qualification must use an actual stock server, independently of the patched
scheduler. Local native builds require separate supported-platform and
release-artifact qualification.

These contracts do not establish a global atomic snapshot across independent
clients or panes. `%pause`/`%continue`, capture failure and pane disappearance need
their own recovery contracts. ANSI captures do not reconstruct every terminal
mode, hyperlink, hidden screen or exact physical backing cell. Preserve the native
capture path and its capability checks.

### Cancelled collector ownership

Cancelling a snapshot invalidates delivery immediately, but does not erase its
in-flight hook replies. The control connection retains the cancelled collector
as a drain owner and refuses another collector until a separately queued,
nonce-bearing ordinary reply proves that earlier hook replies have passed. Raw
capture rows cannot satisfy that fence. A bounded drain failure retires the
connection. Admission uses the collector's `onDrained` notification rather than
its earlier `onSettled` delivery result.

`control-collector-retirement-live.test.ts` executes a real hook on a private
server while its reader is paused, cancels before the start reply is observed,
then drains and successfully invokes another hook on the same connection. The
previous implementation fails this test by admitting the replacement too soon.

`session-channel-cancellation-live.test.ts` checks the same ownership boundary
through real `MirrorService` subscriptions and `SessionChannel` admission on both
stock and bundled servers. It holds the actual control reader after A's snapshot
executes, queues B, and closes A before observing A's start reply. The trace must
show the exact ordinary drain-fence reply, then A's `onDrained`, then B's admission.
A receives no late seed or delta; B's canonical baseline and subsequent unique
suffix are exact, and a final ordinary command remains aligned. The receipt
retains commands, wire bytes, event order, binary/source hashes and private-server
cleanup. This qualifies the stock-compatible path, including native capture when
available; native-Q recovery and arbitrary disconnect schedules are separate
proof obligations.

### Stock-server snapshot protocol

One connection-wide lease serializes snapshot work across panes. Cancellation
invalidates the recipient immediately, but the lease stays occupied until its
collector drains. Queued panes share bounded admission; repeated requests do not
extend the recovery's original absolute deadline.

The stock path first invokes a nonce-owned, synchronous NOHOOKS body on the exact
live pane. Its three authenticated reply blocks establish a successful target
pause. A new `%pause` notification may be absent if the target was already
paused; an arbitrary successful `refresh-client` reply without the owned live
pane invocation is not equivalent proof. The pause collector must drain before
the snapshot collector is admitted.

A second NOHOOKS body captures the screen, reads cursor/mode metadata and continues
the target without yielding to the event loop. When native and ANSI subscribers
share a pane, it captures both representations in that same body, with separate
sentinels and a combined payload bound. Native capability is negotiated against
the live server with a bounded full-history probe; a partial screen export can
carry a full-history header and must not be mistaken for a complete native grid.

`StockPaneSnapshot` holds all target output observed after the pause boundary,
including bytes that stock tmux delivers before the older capture reply. It
publishes reset, seed and capture-time cursor/mode metadata before replaying those
held bytes exactly once. Participant, pane incarnation and layout generation
changes invalidate the candidate. Capture/probe corruption is rejected directly;
an internally consistent snapshot ahead of known layout authority waits for a
new successful inventory sync within the original deadline.

Temporary hook options use nonce ownership and compare-before-invoke and cleanup.
A substituted hook is not executed or deleted. Closing the final subscriber
returns an internally owned pause only after the outstanding wire has drained.
Channel teardown cancels admission timers and queued work. The specialized native
`-Q` path retains its native identity, paused-target and stream-offset guards
while sharing the same admission owner.

The real ordering fixture checks single and mixed viewers, both final content and
a post-capture terminal mode change. A passive `no-output,ignore-size` control
client keeps tmux reading the producer while the tested reader is deliberately
stalled. No fixture callback fabricates or reorders tmux's output. This checks the
snapshot boundary, not physical renderer correctness or native-speed parity.

### First-slice operation inventory

The inventory covers the current live fixture and its production owners, not every
command exposed by tmux-ide. Source paths below are relative to
`packages/daemon/src/terminal/mirror/`.

| Operation                                                          | Owner and response handling                                                                                             | Failure / ownership boundary                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Control attach and dispose                                         | `control-channel.ts`, `MirrorControlChannel`; greeting and reply queue                                                  | Private test socket; owner/service disposal retires callbacks; automatic reconnect is later work                        |
| Session identity, `list-panes`, `list-windows` and semantic stamps | `session-channel.ts`, identity and inventory methods; promise replies for inventory, counted command lists where needed | Failed inventory is not pane absence; one session/server incarnation owns runtime-to-semantic mapping                   |
| `capture-pane -p -e -J -S` or native `-R`, with read marker        | `session-channel.ts`, `captureWithViewer` and reseed; synchronous bounded reply callback                                | Attempt epoch, deadline, identity and geometry fence the candidate; native capability rejection differs from deletion   |
| Cursor/size/mode `display-message`                                 | `session-channel.ts`, `RECOVERY_CURSOR_PROBE_FORMAT` and inline callback                                                | Invalid/failed or mismatched geometry quarantines/retries in the owner; no partially valid geometry assertion           |
| `send-keys` literals/bytes/named keys                              | `session-channel.ts`, `InputCoalescer`; discard reply slots are still consumed                                          | One semantic pane mapping; literals flush before named keys; this slice checks processed input, not all modifiers/mouse |
| Attached PTY resize                                                | Test client → tmux native client-size arbitration → layout notification and reseed                                      | One attached sizing client; application `fitViewport`/multi-viewer policy is not exercised by this fixture              |
| Format subscriptions and layout/output notifications               | `session-channel.ts` startup `refresh-client -B`; control parser dispatch                                               | Notification order and geometry changes can invalidate a pending seed; arbitrary multipane schedules remain unverified  |
| Retire owner/service and reattach                                  | `terminal-replica-owner.ts` and `MirrorService.dispose`                                                                 | Existing pane survives; retired subscriber receives no callbacks; a new owner publishes a fresh baseline                |

### Operation contract details

This appendix covers the operations used by the first-slice journeys and their
snapshot owners, including the optional native and observer branches. It is not
an inventory of every tmux-ide command. A reply below means protocol completion;
it does not by itself prove processed PTY input, canonical publication or drawing.
Cancellation retires application authority and drains already submitted work. It
does not undo a command that tmux has executed.

Source keys used in the table:

- **Channel**: [control-channel.ts](../../packages/daemon/src/terminal/mirror/control-channel.ts),
  `ControlChannelCore`, `MirrorControlChannel`, `pushCommandList`,
  `beginCollectorDrain` and `dispose`.
- **Session**: [session-channel.ts](../../packages/daemon/src/terminal/mirror/session-channel.ts),
  with the named methods below.
- **Discovery**: [session-descriptor-discovery.ts](../../packages/daemon/src/terminal/protocol/session-descriptor-discovery.ts),
  descriptor retries and retirement.
- **Input**: [input-coalescer.ts](../../packages/daemon/src/terminal/protocol/input-coalescer.ts),
  ordered literal, byte and named-key submission.
- **Snapshot**: [stock-pane-snapshot.ts](../../packages/daemon/src/terminal/mirror/stock-pane-snapshot.ts),
  participant/context validation, bounded buffering and publication.

| Operation / source                                                                                                                                                                                            | Response contract                                                                                                                                                                                                                                                      | Failure contract                                                                                                                                                                                                                               | Cancellation and ownership contract                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control attach, greeting and detach — Channel `start` / `dispose`; Session `start`                                                                                                                            | One initial greeting consumes the attach slot. Ordinary replies consume counted FIFO slots; later flags=0 hook blocks do not consume ordinary command replies.                                                                                                         | Exit fails pending work. Explicit disposal requests detach, then uses bounded process termination if needed.                                                                                                                                   | The connection owns its parser and reply debt. Closing it retires collectors and subscribers; a fresh owner needs a new baseline. It cannot inherit the old connection's reply slots.                                                                                                                                                                          |
| Session identity `display-message`, pane/window inventory `list-panes` / `list-windows` — Session `captureAttachedSessionIdentity`, `syncNow`, `stageWindows`; Discovery                                      | Identity is parsed and checked before joining semantic panes. Successful truth reads and coherent window metadata establish membership and geometry; notifications alone do not.                                                                                       | A failed read is not an empty inventory or proof of disappearance. Discovery has bounded retries; failed identity/metadata can leave the channel degraded or reject the requested trusted read.                                                | Reads already submitted still drain. Disposal retires discovery and subscribers. Snapshot publication separately checks pane incarnation, participants and layout authority; an older in-flight sync cannot release a wait requiring a newer sync.                                                                                                             |
| Pane/window semantic `set-option` stamps — Session identity reconciliation / `stageWindows`; Discovery                                                                                                        | Each write has an acknowledgement; generated identity is admitted only through successful reconciliation. Trusted inventory also requires its post-repair verification.                                                                                                | A failed stamp is not a verified semantic identity. Duplicate/missing identities are reconciled explicitly, rather than trusting a runtime ID as semantic authority.                                                                           | Submitted writes cannot be undone by cancelling a subscriber. Reconciliation checks disposal before publishing pane bindings; restamping retires old semantic subscribers and their snapshot work.                                                                                                                                                             |
| Format registration `refresh-client -B` and `%subscription-changed` / layout notifications — Session `start`, `onNotify`                                                                                      | Registration uses consumed discard-reply slots. Subsequent notifications are separate events; border/client hints trigger authoritative reads, while validated pane policy/history notifications can request a reseed.                                                 | Registration errors are consumed by the channel; no per-registration success guarantee is exposed to the subscriber. Malformed or incomplete layout/metadata is not accepted as authoritative geometry.                                        | Registrations belong to the control client and end with it. A geometry change retires affected active snapshots; buffered output cannot be released against superseded metadata.                                                                                                                                                                               |
| `send-keys` literals, bytes and named keys — Session input callback / `trySendOwnedInput`; Input                                                                                                              | The coalescer preserves submission order and flushes literals before named keys. Every reply slot is consumed; optional input tracing records acknowledgement success. The live test separately waits for processed producer markers.                                  | An error acknowledgement is not accepted input. An accepted native dispatch is not replayed through the compatibility path merely because attribution metadata is unavailable.                                                                 | Closing a subscriber prevents its further submissions, but cannot retract bytes already written. Session disposal flushes queued input before closing the channel. Native dispatch uses its pane/server identity guard; compatibility submission uses the current runtime mapping.                                                                             |
| Native capability probe `capture-pane -p -R -S -`, with read marker — Session `captureWithViewer`, `startStockSnapshot`                                                                                       | The selected counted reply is bounded and decoded as a complete native export. Explicit unsupported evidence selects the portable path; complete supported output confirms native capability.                                                                          | Unknown/malformed or failed probes retry at most once within the original recovery deadline. A partial export is not a complete native seed.                                                                                                   | Probe settlement checks its exact lease and local settled flag. Late replies can clean up their own marker but cannot negotiate or seed a replacement attempt. Submitted reply slots remain owned until drained.                                                                                                                                               |
| Owned hook setup / invocation: create-only `set-option -po`, guarded `if-shell`, `set-hook -Rp` — Session `startStockSnapshot`, `reseedRecoverySubscribersAtomic`                                             | Setup steps have separate acknowledgements. Invocation checks the owned value; authenticated raw guards/sentinels establish completion of the exact NOHOOKS body. The pause body has three blocks and must drain before capture is armed.                              | Replaced hooks are rejected. Partial setup errors, missing/malformed guards, payload overflow or timeout cannot publish a seed; recovery retries under finite budgets and retains wire ownership until drain.                                  | One connection-wide lease owns the attempt. Cancellation invalidates recipients immediately, conditionally cleans installed options, and keeps old raw replies fenced. Cleanup compares ownership/value so it does not remove a substituted hook. Explicit teardown attempts guarded cleanup before detach; cleanup cannot be guaranteed after transport loss. |
| Paused snapshot: native/ANSI capture, cursor/mode `display-message`, `refresh-client -A ...:continue` — Session `reseedRecoverySubscribersAtomic`; Snapshot                                                   | A nonwaiting NOHOOKS body captures screen(s), probes metadata and continues the same pane. Dual replies have separate capture sentinels and one combined budget. All participants receive reset/seed/cursor metadata before held output is replayed once.              | Capture/probe corruption fails directly. A consistent capture ahead of authoritative geometry waits for a newer successful sync within the existing absolute deadline. Overflow or participant/context change invalidates the whole candidate. | Target output after authenticated pause is held even if it precedes capture on the wire. Pane incarnation, layout generation and participant identity fence publication. Cancelling does not erase raw reply debt. Final departure returns an internally owned pause after drain, without overriding a remaining requested freeze.                             |
| Internal read marker, optional bounded observer append and `wait-for -S`, conditional unset — Session `retireInternalReadMarker`, `reseedRecoverySubscribersAtomic`                                           | Read markers identify this capture attempt. Optional observer commands are synchronous, counted hook blocks; successful emission/status affects whether a marker remains redeemable. A conditional unset accounts for both the `if-shell` and selected branch replies. | Invalid observer configuration fails the attempt. Command/error or missing completion cannot be treated as successful observer emission. Cleanup failure does not license deleting another marker.                                             | Only an exact owned marker is unset. Late cleanup for attempt A cannot erase B's authority. Where observation has already been emitted, retirement preserves the corresponding evidence rather than claiming it never happened.                                                                                                                                |
| Ordinary admission/drain `display-message -p -l NONCE` — Channel `beginCollectorDrain`; Session `retireSnapshotLease` / `releaseSnapshotLease`                                                                | The exact payload of a separately queued bounded ordinary reply proves preceding commands/raw hook debt have passed. Successful raw completion or the separate fence releases ownership through the applicable drain path.                                             | Wrong payload, failed reply or finite drain timeout retires the connection. Capture text equal to the nonce is not fence completion.                                                                                                           | A retired collector is a tombstone, not an available slot. New panes cannot arm a collector until the owning lease drains; old timer/fence callbacks cannot release a newer owner.                                                                                                                                                                             |
| Specialized native `-Q` snapshot / optional dual representation — Session `recoverNativeAtomic`; [native-atomic-snapshot.ts](../../packages/daemon/src/terminal/mirror/native-atomic-snapshot.ts)             | Native reply decoding validates the negotiated server epoch/pane birth and capture identity. Native commit guards establish the paused-target/stream-offset seam; geometry and participants are checked before publication.                                            | Invalid identity, malformed native result, geometry mismatch or failed commands cannot silently fall back to an unfenced portable capture. Retries pause again and remain bounded.                                                             | Uses the same admission lease as stock work, while retaining native identity and offset guards. Cancellation suppresses publication and drains outstanding ordinary commands before another owner is admitted.                                                                                                                                                 |
| Attached PTY resize, owner retirement and fresh attachment — live fixture; Session layout handling; [terminal-replica-owner.ts](../../packages/daemon/src/terminal/session-runtime/terminal-replica-owner.ts) | Resize is driven by a real attached client. Native formats and eventual canonical checkpoints establish the result; a later fresh owner receives a baseline of the surviving pane.                                                                                     | Test timeouts fail qualification; they do not prove absence of the pane. A resized native client alone does not prove every subscriber has published matching geometry.                                                                        | Old owner callbacks must stop after disposal. Resize invalidates incompatible pending snapshots, but plain live subscribers can receive layout without a new reset. This journey explicitly reconnects; automatic reconnect is not established here.                                                                                                           |

The pinned upstream links in the boundary table describe the native seam; the
application sources above describe its client-side ownership and failure policy.
The tests qualify bounded cases of these contracts, not every possible schedule.

## Independent transcript model

`packages/daemon/src/terminal/mirror/pane-feed-model.test.ts` uses a simple world:
output appends unique ASCII tokens and a capture records a prefix of that world.
The oracle does not use production capture conversion, a VT parser, or production
state names. Logical request tickets are mapped to implementation epochs only at
the test adapter. The model snapshots its world at simulated capture-reply time;
it checks delivery correctness **assuming a valid seam**, not tmux's internal
capture-to-wire scheduling. That assumption must be tested at the wire layer.

Its externally observable rules are:

1. While an attempt is pending or disconnected, the published transcript stays
   unchanged.
2. A successful current capture/cursor checkpoint publishes the world exactly:
   captured prefix plus post-capture output, once and in order.
3. Subsequent live output appends exactly once.
4. Superseded, duplicate and incomplete replies cannot publish a checkpoint.
5. Every emitted seed is paired with a reset in the same returned batch.

The suite runs 64 deterministic schedules, each with 80 generated actions plus
mandatory successful recovery and live output at the end. It includes overlapping
requests, output before and after capture, duplicate/stale callbacks and disconnects.
Some callback orders are defensive fault injection, not claims that tmux reorders
its FIFO replies. Capture-before-cursor is the valid successful path.

Failures report the seed and a deletion-reduced schedule. Reduction removes
unnecessary actions; it does not guarantee the globally smallest trace. Missing
requests in reduced schedules make their replies inert. A negative control doubles
delivered delta events and proves the oracle detects corruption and reduces the
failing trace. This is a transcript model, not a model of terminal emulation,
geometry ownership, queue overflow or the entire SessionChannel lifecycle.

### Generated control-parser schedules

`control-channel-model.test.ts` drives the real `ControlChannelCore` with 128
recorded seeds and a bounded campaign of 1,024 additional seeds. Each schedule
contains 48 operations: pane output with escaped control bytes, server hook
replies, successful command groups, first-command errors that abort their group,
and bounded reply overflow. Reads split down to individual bytes or coalesce
multiple complete replies. The expected transcript comes directly from those
operations, independently of the production parser and reply queue.

The oracle checks exact output and reply delivery order, selected reply identity,
success/error results, and that every reserved response slot is consumed. Hook
replies must not consume ordinary command slots. These schedules put output
between complete reply blocks; they do not claim arbitrary interleaving inside
capture payloads is legal. They also do not model SessionChannel publication,
cancellation, disconnected generations, or tmux's internal scheduling.

On an invariant failure, the test retains a JSON receipt containing its seed,
original schedule, deletion-reduced schedule and failure in a temporary
`tmux-control-model-*` directory. Reduction removes whole operations so the wire
stays framed and every remaining reply retains its command. Negative controls
duplicate output, lose output or misroute a reply. Each is detected and reduced
to one operation that passes without the injected corruption; their original
and reduced schedules are retained as `negative.json` receipts.

### Generated SessionChannel lifecycle schedules

`session-channel-model.test.ts` drives the real SessionChannel and control parser
through a constrained stock-server transport. Its independent reference is an
append-only producer transcript, capture cuts and public subscriber lifetimes;
it does not use the production snapshot reducer to compute expected content.
Server execution, capture and wire delivery are distinct steps. The transport
checks the installed owned hook before synthesizing its replies.

There are 32 recorded seeds and 128 wider seeds, each containing 12 rounds.
Continuing rounds vary reseed, shared subscription, cancellation, freeze/thaw and
recovery after an observed pause with missing live output. The final round varies
disconnect, output overflow or an aborted capture. Reads are coalesced, fragmented
byte by byte, or split into varying chunks. Operation and partition coverage are
asserted. Deliberately delivered stale wire after disconnect is a separate fault
lane, not a legal tmux schedule.

The checker requires exact transcripts, current subscriber generations, complete
metadata before retained output, and a real ordinary drain fence before admitting
the queued pane after cancellation. An aborted capture must fail explicitly
within its deadline and drain that exact failed collector; retaining the old
display alone is not success. Overflow must not publish a partial baseline or
tail. Negative controls drop or duplicate output, publish to a retired subscriber,
or deliver output before baseline metadata. Whole-round reduction preserves the
invariant and victim, with original/reduced traces and unmutated passing controls.
Reply identity and misrouting negative controls belong to the separate generated
control-parser suite described above; this lifecycle suite does not independently
establish every ordinary reply's origin.

This model uses two panes, fixed geometry and short ASCII transcripts. It does
not model terminal emulation, native-Q/dual capture, topology changes, every
cancellation phase or automatic reconnection. The real ordering and cancellation
witnesses qualify representative server phase orders; generated read partitions
are not a claim about a particular kernel's chunk boundaries.

## Real-tmux checkpoints

`tmux-boundary-model-live.test.ts` drives the actual MirrorService and canonical
replica owner. It verifies:

1. Attach to pre-existing output.
2. Send 32 lines through the service input path, including enough output to form
   history.
3. Styled Unicode output: complete text plus known red/bold cells and wide-glyph
   width.
4. Resize an attached client's PTY to three sizes. This exercises tmux's client
   sizing; `resize-window` would force manual sizing and test a different path.
5. Dispose the replica and control connection, produce output while disconnected,
   and attach a fresh owner to the surviving pane.
6. Resume live input after recovery.

At each quiescent checkpoint, the complete replica history plus visible text is
compared with native `capture-pane`, and cursor/geometry with native formats.
Producer markers confirm the pane processed input before comparison; command
completion and arbitrary sleeps are not used as an output fence. Polling allows
asynchronous delivery to converge and fails on timeout. This verifies eventual
checkpoint agreement, not the absence of every incorrect transient frame.

The native text oracle does not call our projection code. The styled-cell checks
use known fixture expectations. Complete native cell attributes/modes are not yet
compared, and this test stops before actual OpenTUI rendering. Existing native-grid,
renderer, flow recovery and linked-window tests remain necessary.

### Exact input delivery

`terminal-input-ordering-live.test.ts` sends mixed Unicode and shell-sensitive
text, arbitrary binary bytes, separately delivered bracketed-paste messages,
Enter and Ctrl-C through MirrorService and its existing input coalescer. Two
raw-mode receiver processes record their bytes independently. Native clients
select the opposite pane before input dispatch; each receiver must still match
its exact expected byte stream. Cleanup verifies both receivers and the private
server have exited.

This fixture exercises ordinary control `send-keys` on stock and bundled tmux.
Its custom IO intentionally excludes the native guarded input route. It does not
qualify controller/WebSocket authorization, stale pane/session generations,
physical keyboard behavior or mouse targeting.

`terminal-input-session-replacement-live.test.ts` retains an old subscription
after its session dies, waits for the actual closed event, then recreates the
same session name and semantic pane stamp. Old text/key calls must remain no-ops;
the new raw receiver accepts only fresh input. Both runtime session and pane IDs
must differ. This proves isolation after observed closure, not rejection of input
already queued before deletion or controller-generation authorization.

The same fixture separately replaces the public SessionRuntimeRegistry while
the physical pane and client ID survive. An old controller lease must reject
text, bytes and named keys with a typed stale-lease error, without issuing input
commands or changing receiver bytes; fresh authority must deliver exact bytes.
A separately labelled fault case changes only the generation on a fresh lease
to isolate that check from token/revision mismatches. This exercises the registry
boundary, not a complete daemon restart or WebSocket reconnection.

`terminal-native-input-death-live.test.ts` exercises the production owned-viewer
route without custom IO. A real tmux lock holds accepted input behind a waiting
command while another client deletes the target pane. After unlocking, native
guards must reject the queued commands without ordinary-input fallback, and the
replacement receiver must remain empty. Fresh native input then succeeds. This
tests physical target death with a different replacement ID and birth, not
runtime-ID reuse or every input-admission race.

## Coverage matrix

`native-physical-cell-oracle-live.test.ts` adds an independent, deliberately small
8×4 physical-cell checkpoint. Both raw native JSON and delivered canonical cells
are compared with literal expectations, without using the production decoder or
projector to compute expected cells. Initial and insert/delete-character frames
cover selected indexed/RGB colors and attributes, wide/combining characters,
explicit spaces and colored erased tails. A trailing OSC title marker fences all
fixture output, including cursor positioning. Mutation checks verify field-error
detection; malformed-record tests prevent silent coercion in the oracle.

The native comparison normalizes wide continuation cells to their leading cell's
visual style. Unsupported record flags, attributes and renditions are rejected,
not silently treated as defaults. Stock tmux checks text, cursor and available
modes and explicitly reports that physical capture is unavailable. These two
authored checkpoints do not establish complete mode/history/reflow coverage or
continuous frame correctness.

The default-tab extension paints a known row background, checks native tab-span
occupancy and pending wrap, then emits one printable character to verify the
next-row continuation. Raw tmux's end-column cursor and the canonical visible
cursor are asserted separately; their different representations are not treated
as equal. This fixture does not scroll or establish custom tab-stop state.

**Known stock snapshot discrepancy:** the ANSI capture includes a tab preceded
by a background-color sequence, but replay moves across existing cells without
painting that background. The stock canonical tab span therefore loses the
fixture's pre-erased background; bundled native capture preserves it. Stock
text/cursor/mode checks passing do not resolve this visible style mismatch. The
independent fixture retains that limitation while capture replay is investigated.

| Evidence                               | First-slice status                                                                 | Remaining boundary                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Transcript delivery under a valid seam | Generated schedules and corruption negative control                                | Real wire scheduler, failed replies and overflow                     |
| Settled native checkpoints             | One pane: full text/history, cursor, geometry, selected style/Unicode expectations | Complete attributes, modes, alternate screens and adversarial reflow |
| Continuous coherent frames             | Not established                                                                    | Observe every published and drawn frame during overlap               |
| Recovery                               | Explicit retirement and fresh owner                                                | Automatic recovery of a still-open viewer and multiple consumers     |
| Physical display / input               | Not established                                                                    | Installed OpenTUI and real emulator verification                     |
| Performance parity                     | Not measured                                                                       | Comparable successful-work latency and resource measurements         |

## Canonical publications during client resize

`canonical-resize-publication-live.test.ts` observes every delivered canonical
callback during four real attached-client PTY resizes. Each resize and producer
output occurs while a real client snapshot collector is unresolved. The fixture
waits for convergence between sizes; it does not claim simultaneous server
capture execution, an uninterrupted resize storm, or every OpenTUI host paint.

Each published seed carries the trace identity of its original reset batch.
The checker compares that batch's layout epoch with the independently observed
layout, including repeated dimensions after a reversal. It also checks revision
and identity continuity, physical cell structure, cursor bounds, retained
sentinel content and the final native cursor. The initial cached subscriber seed
is explicitly distinguished from later commit-time publications. A surviving
pane cannot publish a tombstone during this schedule.

Copies of actual successful publications with an obsolete same-size batch or
an out-of-bounds cursor must fail. These are labelled transcript mutations, not
real server failures. The fixture preserves native window sizing policy and
records bounded teardown and private server/client/producer absence. It runs in
the bundled boundary gate; stock snapshot limitations remain separate.

The navigation variant adds six individually converged transitions across a
split pane, a second window, and zoom/unzoom while the client collector remains
unresolved. Native acknowledgements verify client dimensions, selected window,
target-window active pane and zoom state. Expected geometry comes from the target
pane itself, including while another window is selected. Both variants verify
all private producers exit after teardown.

## Completed renderer frames during a snapshot handoff

`terminal-transient-frame-renderer.test.tsx` drives controlled mirror events
through the production replica owner, fast lane, renderer adapter and PaneSurface.
It observes every native test-renderer `FRAME` completion after baseline, including
forced draws after layout, reset and staged grid delivery. The previous coherent
image must remain until cursor admission; the settled frame must contain the new
image. Literal rows, sentinel foreground and cursor positions reject partial or
mixed frames, with three mutations of an actual frame as negative controls.

The pane narrows and expands inside a fixed host renderer. This verifies the
controlled production rendering handoff, complementing the real tmux publication
fixture above; it does not join both into a live PTY journey or prove physical
terminal paint. The fixture runs in `test:tui-renderer` with the repository's
pinned Bun version. Cleanup removes the frame observer and destroys the renderer.

## Retained viewers and prior-release upgrades

`scripts/lib/product-tui-recovery-live.test.mjs` now waits for each retained TUI
to join the live daemon generation before sending supported focus events. It
selects one geometry owner and verifies the committed authority and native
bottom markers before recording the recovery baseline. The SIGKILL case keeps
eight TUI processes alive across replacement, then verifies content, input
acknowledgements, geometry and the single replacement control client. This
qualification does not cover SSH interruption or every recovery mode.

The former pre-viewer geometry assertion was inconsistent with viewport fitting:
clients intentionally replace the initial manual size. Uncontrolled startup can
also select a smaller viewer, so a taller observer's native content need not end
at its own viewport bottom. Controlled ownership is part of this recovery test's
setup, not a production geometry-policy change.

`installed-daemon-upgrade-live.test.ts` accepts the absolute
`TMUX_IDE_UPGRADE_PRIOR_CLI` path to an installed prior release's `bin/cli.js`.
It checks that release's real version, starts its public headless entry, observes
its health through the current CLI, and requests concurrent explicit updates.
Both requests must converge on one replacement while pane identity and full
history survive. The default cases still use current daemon code with older
metadata to exercise manual/systemd/launchd provenance; they are not historical
code compatibility tests or actual service-manager runs.

Qualification with the published 2.9.2 package passed against current source.
That fixture includes tmux on PATH. A separate clean-PATH installer journey found
that published 2.9.3's `status --json` still attempts system `tmux` despite a
bundled executable. Installer activation and rollback success alone therefore do
not establish complete clean-install usability; this command-resolution defect
requires its own same-path regression and fix.

## Next extensions, in order

- Broaden the bounded stock lifecycle model to additional cancellation phases,
  topology changes and native/mixed snapshot paths, retaining independent oracles
  and real-tmux correspondence for newly claimed legal schedules.
- Add native physical-cell and mode checkpoints, alternate screens, wrapping,
  erase/insert operations, Unicode transitions and large-history reflow.
- Model geometry generations and continuously check published frames during
  output/resize overlap, beyond eventual quiescent convergence.
- Add multiple viewers, linked windows, slow consumers and real connection loss
  with automatic recovery. The first live test explicitly reconnects a new owner.
- Once these contracts pass, record capture counts, copied rows, queue depth and
  rendered-frame latency for the same scenarios. Performance changes must retain
  correctness; wall-clock test duration is not a user-visible latency benchmark.

### Ordinary CLI client selection

Ordinary bridge commands (including `status --json`) resolve their tmux client
lazily at the CLI composition boundary. An explicit absolute
`TMUX_IDE_TMUX_BIN` takes precedence and an invalid override fails without
fallback. Otherwise the existing PATH client wins, including relative and empty
PATH entries interpreted against the command's working directory; an omitted
PATH uses the Unix default `/usr/bin:/bin`. If no PATH client exists, the CLI
uses the validated bundled tmux and its terminfo resources. Caller environment
and socket arguments are preserved; selecting a client does not select or
replace a server. The daemon's pinned client selection and development namespace
guard remain separate.

`cli-tmux-resolution-live.test.ts` exercises the built CLI against a private
server through tmux's ordinary `TMUX` socket context, checks unchanged
server/session/pane/process identity, and covers clean PATH, repeated reads,
ordinary/relative/empty PATH, explicit override precedence, invalid override
failure, and a subsequent successful read. Enable it with an absolute
`TMUX_IDE_TEST_BUNDLED_CLI_ANCHOR` pointing to a CLI beside validated native
assets, and run it with `vitest.live.config.ts` after building `bin/cli.js`.
It does not qualify the separate `TMUX_IDE_TMUX_SOCKET_NAME` namespace policy.

## Hidden semantic viewers

`terminal-hidden-viewer-live.test.ts` joins a real native producer and replica
owner to two semantic delivery clients. After one client becomes hidden, the
other advances through three native updates while the hidden client receives no
new deliveries. Reveal must produce one current seed; both clients are checked
against a literal complete 40×8 grid, including blank cells and a wide-character
continuation, plus native cursor and geometry. Visibility must not change native
sizing policy. Closing both clients releases the hub's retained revisions and
representation cache; the private server and producer must exit.

This fixture runs in the boundary gate. It verifies semantic delivery, not
physical WebSocket buffering or renderer work; the stalled-observer wire test
and rendering fixtures cover those separate boundaries.
