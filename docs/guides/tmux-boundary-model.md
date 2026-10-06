# Executable tmux boundary contract

This correctness gate covers capture/output delivery, a real
attach/output/resize/reconnect journey, and cross-pane control scheduling.
It does not establish performance parity or complete terminal correctness.

## Run

Build the bundled runtime with `pnpm build:tmux` if needed, then select its exact
executable. For example, on Apple Silicon from the repository root:

```sh
TMUX_IDE_BOUNDARY_TEST_BINARY="$PWD/packages/daemon/dist/native/tmux/darwin-arm64/tmux" \
  pnpm test:tmux-boundary
```

The command requires an absolute executable path, prints its version and SHA-256,
and runs the transcript model, both application journeys, and the scheduler wire
cases. Python 3 is required for the wire cases; their raw traces and JSON receipts
are retained in the printed temporary evidence directory. A missing binary fails
the command. The ordinary daemon
suite always collects the model; its live lane skips this optional qualification
when no binary was selected. The explicit gate cannot pass by skipping it.

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
output to overtake the capture reply. It reproduces on the bundled tmux 3.7c
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
canonical content in this two-pane failure. It fails on the original bundled
server and clean pinned stock server. The ordered
`native/tmux/control-output-barriers.patch` corrects the bundled scheduler:
panes share a scheduling budget within each segment between queued control lines,
and no later segment can drain before the preceding line. Lines exposed by
age-triggered pause or discard are flushed before scheduling again.
`scripts/check-tmux-control-barriers.py` additionally exercises adjacent replies,
age-triggered pause, pane off/death and service of both flooding panes.

The server format `#{tmux_ide_control_output_barriers}` returns `1` only for the
patched scheduler. A new client connected to an old server does not provide this
guarantee. Stock/old-server reseeding remains an open TM02 requirement; do not
infer it from a passing test with the new bundled server. Local native builds
also require separate supported-platform and release-artifact qualification.

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
| Format subscriptions and layout/output notifications               | `session-channel.ts` startup `refresh-client -B`; control parser dispatch                                               | Notification order and geometry changes can invalidate a pending seed; multipane scheduling remains unverified          |
| Retire owner/service and reattach                                  | `terminal-replica-owner.ts` and `MirrorService.dispose`                                                                 | Existing pane survives; retired subscriber receives no callbacks; a new owner publishes a fresh baseline                |

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

## Coverage matrix

| Evidence                               | First-slice status                                                                 | Remaining boundary                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Transcript delivery under a valid seam | Generated schedules and corruption negative control                                | Real wire scheduler, failed replies and overflow                     |
| Settled native checkpoints             | One pane: full text/history, cursor, geometry, selected style/Unicode expectations | Complete attributes, modes, alternate screens and adversarial reflow |
| Continuous coherent frames             | Not established                                                                    | Observe every published and drawn frame during overlap               |
| Recovery                               | Explicit retirement and fresh owner                                                | Automatic recovery of a still-open viewer and multiple consumers     |
| Physical display / input               | Not established                                                                    | Installed OpenTUI and real emulator verification                     |
| Performance parity                     | Not measured                                                                       | Comparable successful-work latency and resource measurements         |

## Next extensions, in order

- Correct the stock/old-server capture boundary and retain the bundled-server
  regression, then
  connect a generated legal wire-event schedule to SessionChannel, retaining the
  independent oracle and shrinking. Cover response failures and bounded overflow.
- Add native physical-cell and mode checkpoints, alternate screens, wrapping,
  erase/insert operations, Unicode transitions and large-history reflow.
- Model geometry generations and continuously check published frames during
  output/resize overlap, beyond eventual quiescent convergence.
- Add multiple viewers, linked windows, slow consumers and real connection loss
  with automatic recovery. The first live test explicitly reconnects a new owner.
- Once these contracts pass, record capture counts, copied rows, queue depth and
  rendered-frame latency for the same scenarios. Performance changes must retain
  correctness; wall-clock test duration is not a user-visible latency benchmark.
