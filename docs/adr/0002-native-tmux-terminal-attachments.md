# ADR-0002 — Native tmux terminal attachments

- **Status**: Accepted
- **Date**: 2026-07-22
- **Decision drivers**: tmux authority, native terminal fidelity, renderer
  isolation, bounded streaming, reconnect correctness, desktop/web development
  parity, and a portable daemon boundary.
- **Supersedes**: terminal-transport assumptions in
  `docs/product/native-tmux-ide-ux-contract.md` that prohibited every renderer
  endpoint, one-time ticket, and use of `node-pty`.
- **Superseded by**: none
- **References**: `docs/product/native-tmux-ide-ux-contract.md`,
  `packages/daemon/src/terminal/PtyAdapter.ts`,
  `packages/daemon/src/terminal/attachments/grouped-tmux.ts`, and
  `apps/desktop-renderer/src/terminal/native-terminal-transport.ts`.

## Context

The desktop renderer needs the behavior of a native terminal: a full tmux redraw on
attach, byte-accurate input and output, resize propagation, terminal control sequences,
and recovery after a renderer or daemon interruption. tmux must remain the only owner
of shells, agent processes, sessions, windows, panes, history, and framebuffer truth.

Earlier design work protected that authority by keeping daemon endpoints and tickets
out of the renderer and by excluding `node-pty` from the native terminal path. Those
rules prevented obvious parallel runtimes, but they also forced terminal bytes through
Electron main or toward tmux control mode. Both alternatives are the wrong boundary:

- Electron main becomes a high-volume byte proxy and must invent input, resize, output,
  acknowledgement, queue, and teardown semantics unrelated to its host role.
- tmux control mode reports protocol events; it does not behave like a terminal client
  attached to a PTY. Reconstructing a terminal from `%output`, `capture-pane`, or a
  replay tail produces a synthetic snapshot and diverges from tmux's real redraw.
- A renderer-created shell or renderer-authored command/cwd would create terminal
  authority outside tmux and expand the renderer's privilege.

The daemon already owns a testable `PtyAdapter`, backed in production by `node-pty`.
The safe use of that adapter is narrow: allocate a PTY for a real, fixed-argument tmux
client that attaches to an already proof-resolved pane view. The PTY does not launch or
own the shell shown in the tile; tmux does.

## Decision

**A Solid/xterm terminal surface obtains a short-lived, single-use, daemon-instance,
request, target, and renderer-origin-bound attachment descriptor through one narrow
Electron host issue call. After issue, terminal bytes and resize/control messages flow
directly between the renderer and daemon over a binary WebSocket. Electron main never
proxies terminal input, output, resize messages, flow-control acknowledgements, or
terminal lifecycle events.**

**The daemon redeems the descriptor once, verifies its proof and one-writer policy,
builds a proof-bound ephemeral one-window tmux view, and uses its existing
`PtyAdapter`/`node-pty` boundary to launch a fixed argv-safe real
`tmux attach-session`. tmux remains the sole process, session, pane, history, and
framebuffer authority.**

### Data flow

```mermaid
sequenceDiagram
  autonumber
  participant X as Solid + xterm renderer
  participant H as Electron host issue boundary
  participant D as tmux-ide daemon
  participant P as daemon PtyAdapter / node-pty
  participant T as real tmux client + server

  X->>H: issue(semanticPane, viewport, requestGeneration)
  H->>D: POST issue + durable daemon credential + canonical renderer origin
  D->>D: resolve proof, reserve writer, mint single-use ticket
  D-->>H: ephemeral attachment descriptor
  H-->>X: descriptor only (no durable credential or raw pane id)
  X->>D: WebSocket upgrade (exact Origin)
  X->>D: redeem(ticket, requestId, daemonInstanceId)
  D->>D: atomically consume ticket and revalidate proof
  D->>P: spawn(fixed tmux executable, fixed argv, safe env, viewport)
  P->>T: real PTY-backed attach to ephemeral one-window view
  T-->>P: full tmux redraw
  P-->>D: PTY output
  D-->>X: binary terminal output
  X->>D: binary input or bounded resize/control
  D->>P: ordered PTY write or coalesced resize
  P->>T: real terminal input/resize
  Note over X,D: Direct stream; Electron main is absent from the byte path
```

The host issue call is a privilege transition, not a stream transport. It accepts only
a daemon-issued semantic pane identity, the current resource/generation proof, and a
validated viewport. It does not accept an executable, argv, shell fragment, working
directory, environment, daemon URL, expected Origin, raw tmux `%pane_id`, or ticket.

### Attachment descriptor

The descriptor is a renderer-safe, versioned value with only the information needed
for one immediate connection:

- protocol version;
- a WebSocket URL for the selected daemon instance;
- an opaque one-time ticket, delivered separately from the URL and never placed in a
  query string;
- daemon instance and request identifiers used for retirement checks;
- expiry; and
- non-secret display/retry metadata where useful.

The ticket is bound server-side to the exact daemon instance, host-issued request,
canonical renderer Origin, semantic target proof, resource generation, and writer
reservation. It has a short fixed TTL, is consumed atomically before the tmux client
starts, and cannot be retried or transferred to another origin. Cancellation, target
retirement, daemon restart, and expiry release the reservation. Reconnect always
requires a new host issue call and a new ticket.

The descriptor may expose the daemon's WebSocket URL because the URL alone grants no
terminal access. The renderer must never receive the durable daemon credential or a
reusable, directly admissible terminal URL.

### Durable credential versus ephemeral ticket

The two credentials have deliberately different trust and lifetime boundaries:

| Property            | Durable daemon credential                           | Ephemeral attachment ticket                             |
| ------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Holder              | daemon and trusted Electron host only               | one isolated renderer request                           |
| Purpose             | authorize descriptor issue                          | redeem one exact terminal attachment                    |
| Scope               | current daemon instance                             | instance + request + origin + target proof + generation |
| Lifetime            | daemon lifetime; rotate on restart                  | short TTL; single atomic use                            |
| Storage             | canonical daemon record with owner-only permissions | memory only                                             |
| Renderer visibility | forbidden                                           | allowed only for immediate redemption                   |
| Logging/URL use     | forbidden                                           | forbidden                                               |

The issue endpoint requires the durable credential even on loopback. Loopback and CORS
are not authentication. The issue response is `no-store`, ticket values are redacted
from errors and telemetry, and neither credential may enter renderer state snapshots,
crash reports, URLs, command descriptors, or persisted workspace data.

### Origin and CSP admission

Production desktop builds use a stable, registered secure application scheme and a
canonical renderer Origin. The daemon rejects `null`, missing, wildcard, file, and
unexpected origins for terminal upgrades. It checks the upgrade Origin before allowing
the bounded redemption frame and checks that the same Origin was bound by the trusted
host at issue time. The renderer does not supply or override its expected Origin.

The desktop renderer keeps context isolation enabled, Node integration disabled, remote
navigation disabled, and a restrictive Content Security Policy. `connect-src` admits
only the resolved local daemon origin needed for the current instance plus explicitly
declared development services. No remote document is allowed to inherit terminal
capabilities. A fixed WebSocket subprotocol identifies the protocol version; the first
small control frame carries the one-time ticket. After ready, terminal input and output
use binary frames. Ticket material is never encoded in a WebSocket URL.

Development has two honest modes:

1. A standalone browser preview uses preview/unavailable transports and cannot issue a
   live attachment.
2. Live desktop development runs the Vite renderer inside Electron. The host binds the
   descriptor to that exact loopback development Origin and CSP admits the exact daemon
   origin plus the known Vite/HMR endpoints.

Arbitrary browser tabs, wildcard dev origins, and a public unauthenticated live-terminal
mode are not supported.

### Real tmux client and proof-bound view

The daemon resolves the semantic pane identity to a current tmux proof that includes
the server/socket identity, daemon generation, session/window/pane lineage, and current
resource revision. It reserves the single writer before awaiting work and revalidates
the proof immediately before PTY spawn.

For each attachment, the daemon creates an ephemeral tmux view containing exactly one
linked target window, selects the proof-resolved pane, and attaches a normal tmux client
to that view. The view changes presentation only: it does not clone a pane, start a new
shell, copy history, or become durable workspace topology. It is removed when the
attachment exits. A daemon-owned fixed command builder supplies the tmux executable,
socket/server selector, `attach-session`, and generated view target as separate argv
values. Spawning through a shell is forbidden.

The view proof must also prevent sibling-pane disclosure. The current grouped-view
planner therefore admits only a source window proven to contain the target pane alone;
it fails closed for a multi-pane source window. Supporting an arbitrary pane later
requires a tmux-native isolation plan that preserves process and topology identity and
passes the same proof gates. It must not fall back to a synthetic snapshot or mutate
durable layout as a side effect of viewing.

The renderer cannot author the command, cwd, environment, socket path, session name, or
view name. Environment is a small daemon-owned allowlist needed for terminal fidelity
(for example `TERM`/color/locale), with secrets and renderer values excluded.

`PtyAdapter`/`node-pty` is allowed only around this real tmux client. No renderer,
Electron main process, dock surface, agent card, or daemon attachment handler may use it
to launch a shell, agent harness, or arbitrary program. Those processes are created by
semantic tmux mutations and remain tmux-owned.

### Stream, resize, and backpressure

The daemon and renderer use a versioned direct protocol with strict frame kinds and
size limits. Terminal input/output is binary. Small bounded control frames cover
redemption, ready, viewport resize, exit, and typed failure. Electron IPC is not part
of this protocol.

Both directions have byte, frame-count, and per-frame limits. Input writes are ordered;
empty writes are ignored. Resize keeps only the latest uncommitted viewport and is
serialized with terminal mutations so it cannot create an unbounded resize queue.
Output observes WebSocket/transport high- and low-water marks. The daemon pauses the PTY
source where the adapter supports it; otherwise it fails closed and retires the
attachment before a bounded buffer can overflow. A slow, detached, or non-reading
renderer cannot grow daemon memory without limit.

Capacity is reserved atomically before asynchronous issue/redeem work. Limits cover
pending descriptors, live attachments, pending bytes, frames, control messages, and
per-pane writers. Teardown is idempotent and removes every timer, listener, writer
reservation, ephemeral view, and PTY client.

### Redraw and reconnect

The initial screen is the redraw emitted by the real tmux client on attach. The daemon
does not synthesize it from control-mode `%output`, `capture-pane`, persisted logs, or a
replay tail. Those sources may support diagnostics or explicit history tools but are
not terminal framebuffer initialization.

On interruption, xterm may retain the last validated frame behind a recovery overlay,
with input disabled. Reconnect retires the old attachment, obtains a fresh descriptor,
resets the terminal parser/display for a fresh attach, and accepts the new real tmux
redraw exactly once. It does not prepend cached output or merge an old tail into the new
stream. Daemon-instance and request generations reject late bytes, exit events, and
control messages from retired connections.

### WSL2 and remote Windows

tmux is not replaced by a native Windows shell runtime. On Windows, the supported local
shape is:

- tmux, the daemon, and `PtyAdapter`/`node-pty` run inside one WSL2 Linux distribution;
- Electron may run on Windows and reach the daemon through a resolved WSL2 loopback
  forwarding address; and
- the daemon still launches Linux `tmux attach-session` directly. It never launches a
  separate PowerShell, `cmd.exe`, or agent process through ConPTY for a terminal tile.

The daemon descriptor records the canonical reachable address for that instance, but
the issue call and exact-Origin checks remain unchanged. If the WSL2 address changes,
the host rediscovers the daemon and requests a fresh descriptor; old tickets fail by
instance binding.

Remote Windows clients do not expose the daemon on `0.0.0.0` with bearer tickets. A
remote setup must place the daemon behind an authenticated, encrypted, host-owned tunnel
(for example an SSH loopback forward), preserve exact Origin admission, and still run
the daemon next to tmux on the Linux/WSL2 side. Native Windows without WSL2/tmux and a
general remote transport are outside this ADR; any future remote broker must preserve
this authority and credential split.

## Explicitly rejected alternatives

### tmux control mode as the terminal renderer

Rejected. Control mode is useful for topology/events and proof resolution, but a
control-mode reconstruction or synthetic snapshot is not a real terminal attachment.

### `capture-pane` or replay tail as the initial framebuffer

Rejected. A snapshot/tail has ordering, truncation, mode, cursor, and alternate-screen
ambiguities. The real attached tmux client owns initial redraw.

### Electron main as terminal byte proxy

Rejected. Main may discover the daemon and authorize descriptor issue, but it never
carries terminal input, output, resize, acknowledgements, or streaming lifecycle.

### Renderer-authored command or cwd

Rejected. The renderer selects a semantic resource, never an executable context. A
command/cwd terminal API would be a renderer shell-spawn primitive.

### Renderer or parallel PTY runtime

Rejected. `node-pty` is used only by the daemon's existing `PtyAdapter`, and only to
host the fixed real tmux client. It never becomes a second shell, process, history, or
session authority.

### Reusable renderer terminal credential or endpoint

Rejected. The renderer receives one expiring ticket and a URL that is inert without
valid issue/redemption authority. Durable credentials and directly reusable terminal
admission remain outside the renderer.

## Consequences

### Positive

- xterm consumes the output of a real tmux terminal client, including native initial
  redraw, modes, cursor, alternate screen, input, and resize behavior.
- tmux remains the sole process and terminal-history authority.
- Electron main stays a low-volume capability broker instead of a streaming runtime.
- The durable daemon secret never crosses into the renderer, while direct streaming
  avoids an unnecessary IPC hop.
- `PtyAdapter` remains mockable and platform-local, and the narrow use of `node-pty` is
  enforceable by dependency/import tests.

### Negative

- The renderer sees a short-lived bearer ticket and daemon URL. CSP, Origin checks,
  short TTL, single-use redemption, and redaction are therefore mandatory, not defense
  in depth that may be deferred.
- Each attachment creates a small ephemeral tmux view and a real tmux client, requiring
  strict cleanup and capacity limits.
- Production custom-scheme, Vite-in-Electron development, WSL2 forwarding, and future
  remote tunnels need explicit origin discovery rather than wildcard CORS.
- Reconnect deliberately redraws rather than attempting seamless byte-tail replay, so
  selection/local viewport state may be retired while tmux process/history state stays
  intact.

## Implementation gates

The native terminal path is not complete until all gates are implemented:

1. Versioned contracts define the issue request, renderer-safe descriptor, direct WS
   protocol, typed failures, limits, and generation retirement.
2. Electron exposes only `issueTerminalAttachment(...)`; no terminal byte/resize/ACK
   IPC channels or main-process stream queues exist.
3. The daemon authenticates issue with the durable credential and atomically issues,
   reserves, redeems, expires, and retires tickets.
4. Upgrade and redemption enforce exact Origin, daemon instance, request, target proof,
   resource generation, TTL, one-time use, and one-writer capacity.
5. A daemon-owned fixed argv builder creates and cleans a proof-bound one-window view,
   rejects sibling-pane exposure, then spawns only a real `tmux attach-session` through
   `PtyAdapter`.
6. Renderer xterm connects directly, handles binary data, coalesces resize, preserves a
   recovery overlay, and resets for a fresh real redraw on reconnect.
7. Production CSP/custom-origin and exact Vite-in-Electron development origin are
   configured; standalone browser preview remains non-live.
8. WSL2 discovery resolves the daemon without changing process authority; remote use is
   refused unless an authenticated host-owned tunnel is configured.
9. Metrics expose counts and sizes without tickets, terminal bytes, commands, cwd,
   environment secrets, or raw tmux correlation.

## Test gates

Required automated evidence includes:

1. Contract tests reject executable/cwd/env/raw-pane fields, malformed descriptors,
   oversized frames, retired generations, and protocol-version mismatch.
2. Security tests cover missing/wrong durable credential; missing/`null`/wrong Origin;
   ticket reuse, expiry, transfer, daemon restart, target change, concurrent redemption,
   and log/snapshot/crash-report redaction.
3. Capacity tests race concurrent issue/redeem calls and prove atomic caps for pending
   tickets, connections, per-pane writers, frame count, and bytes.
4. `PtyAdapter` unit tests assert the exact executable/argv/env/cwd shape and prove no
   shell interpolation or renderer-authored launch field can reach spawn.
5. Live tmux tests prove an existing full-screen/alternate-screen pane redraws on
   attach; subsequent output arrives exactly once; input and `Ctrl-C` reach the tmux
   process; resize reaches the attached client; multi-pane sources fail closed; and
   disconnect leaves tmux alive.
6. Reconnect tests prove a new ticket and client, fresh redraw without cached-tail
   duplication, last-frame recovery overlay, disabled input while stale, and rejection
   of late old-connection events.
7. Backpressure tests use slow/non-reading peers, oversized/zero-byte frame floods,
   resize storms, PTY write failure, socket close races, and teardown during pending
   writes; memory and queue bounds remain fixed.
8. Boundary/source tests prove Electron has no terminal streaming IPC and that
   `node-pty` imports exist only behind the daemon `PtyAdapter` implementation.
9. CSP/navigation tests prove production and Vite-in-Electron live development connect
   only to the intended daemon; standalone browser preview and remote documents cannot
   issue or redeem live attachments.
10. WSL2 integration tests cover discovery/address rotation and fresh issue; remote
    network tests reject unauthenticated/non-tunnel exposure.

## Clean-room reference boundary

NodeTerm and Gloomberb remain behavioral references only. No source, assets, names,
glyph sequences, styling values, storage model, terminal runtime, or transport code is
copied. Allowing tmux-ide's pre-existing daemon `PtyAdapter` around a real tmux client
does not adopt either reference project's architecture: the authority, protocol,
security split, proof model, view lifecycle, and implementation remain native tmux-ide
designs.
