# ADR-0003 — Bounded input for opaque PTY writers

- **Status**: Proposed; primitive implemented, native attachment input remains gated
- **Date**: 2026-07-22
- **Decision drivers**: no unbounded native queue, byte fidelity, explicit failure,
  npm-installable distribution, macOS/Linux/WSL2 support, and honest delivery semantics
- **Depends on**: `docs/adr/0002-native-tmux-terminal-attachments.md`

## Decision summary

The current `node-pty` public API cannot prove that an input byte left its internal
writer queue. tmux-ide therefore must not estimate drain from elapsed time, terminal
echo, output, or private fields.

We will use two layers:

1. **Now: a monotonic fail-closed capability.** Each fresh `PtyProcess` owns a fixed
   lifetime byte budget, frame budget, and single-frame limit. It snapshots and reserves
   each accepted binary frame before calling `node-pty.write`, never returns capacity,
   and permanently rejects after any limit/backend failure. This bounds the opaque
   queue by assuming the worst case: every accepted byte and task remains forever.
2. **For lossless long-lived input: a maintained public completion API.** Prefer an
   upstream `node-pty` API; otherwise publish a scoped fork with the same prebuild
   matrix. A native helper is the fallback if a maintained fork is not viable.

The monotonic primitive is implemented by
`packages/daemon/src/terminal/MonotonicPtyInput.ts` and exposed as
`PtyProcess.boundedInput`. It is not wired into `ClaimedPtyTmuxAttachment.write` in this
card. The launcher continues to throw `input-backpressure-unavailable` until the direct
WebSocket transport owns typed retirement/re-attach behavior and is structurally given
only the bounded capability, never `PtyProcess.write`.

## Evidence

The installed dependency is `node-pty@1.2.0-beta.12`. Its public declaration exposes
`IPty.write(data): void` and no pending-byte, completion, callback, or drain primitive.
The current upstream beta, `1.2.0-beta.14`, has the same public shape.

On Unix, `CustomWriteStream.write` copies every frame into a private array, while an
asynchronous `fs.write` callback advances the head. `EAGAIN` retries later, but callers
cannot observe queue size or completion. On Windows, `inSocket.write(data)` is called
without returning its boolean or callback; calls made before ConPTY readiness are also
stored in a private deferred array. WSL2 uses the Linux/Unix path because tmux and the
daemon run inside WSL2.

Primary evidence:

- [`IPty.write` in v1.2.0-beta.12](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.12/typings/node-pty.d.ts)
- [Unix `CustomWriteStream` in v1.2.0-beta.12](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.12/src/unixTerminal.ts)
- [Windows write/deferred path in v1.2.0-beta.12](https://github.com/microsoft/node-pty/blob/v1.2.0-beta.12/src/windowsTerminal.ts)
- [Upstream issue #939: indefinite input queue when write completions stall](https://github.com/microsoft/node-pty/issues/939)
- [Unmerged callback/return-value PR #186](https://github.com/microsoft/node-pty/pull/186)

`@lydell/node-pty` does not solve the contract: it is a smaller distribution of the
same upstream package, not an independent writer API. Upgrading or changing package
names therefore cannot unlock input.

## Monotonic capability contract

```ts
interface PtyBoundedInput {
  write(data: Uint8Array): PtyInputWriteReceipt;
  snapshot(): PtyInputSnapshot;
  close(): void;
}

interface PtyInputLimits {
  maxFrameBytes: number;
  maxAcceptedBytes: number;
  maxAcceptedFrames: number;
}
```

The default policy for one PTY generation is:

| Limit           | Default | Hard configurable ceiling | Purpose                                    |
| --------------- | ------: | ------------------------: | ------------------------------------------ |
| Single frame    |  16 KiB |                    64 KiB | bounds the snapshot before the opaque call |
| Lifetime bytes  | 256 KiB |                     4 MiB | bounds all payload ever handed to node-pty |
| Lifetime frames |   8,192 |                    16,384 | bounds private queue/task metadata         |

The ceilings are unit-specific. A large byte ceiling cannot be exchanged for tens of
millions of one-byte tasks. `NodePtyAdapter` validates and freezes its daemon-owned
policy in its constructor, before any spawn.

### Invariants

For every non-empty input frame:

1. Validate the original byte length against the single-frame and remaining lifetime
   limits. A refused frame is never copied into or passed to the backend.
2. Copy to a new `Buffer`, preventing later mutation of a renderer/WS-owned view.
3. Increment lifetime byte and frame counters before calling the opaque writer.
4. Call `node-pty.write` once with that immutable snapshot.
5. Never decrement either counter, including after success, synchronous throw, exit, or
   close.

An empty frame is ignored without spending capacity. Every non-empty refusal throws a
typed `PtyInputRejectedError` without input content. Limit refusal changes state to
`exhausted`; backend throw changes it to `failed`; explicit close/PTY exit changes it
to `closed`. None can return to `open`.

Only spawning and proof-claiming a new tmux-client PTY creates a fresh budget. Reconnect
must retire the old generation and reject its late frames. There is no reset API and no
input replay across generations, because replay could execute a command twice.

### What “accepted” means

An accepted receipt means only: “the daemon copied this frame into a bounded opaque
writer budget.” It does **not** mean tmux read the byte, the foreground process handled
it, or output corresponding to it exists. A direct transport may release its temporary
WebSocket-frame allocation after acceptance, but must not label the receipt as a PTY
drain/completion acknowledgement.

If an accepted frame exactly reaches a limit, its receipt reports `state: exhausted`.
The transport must disable further input and replace the attachment. If the next frame
finds the limit first, it gets a typed rejection and the transport retires immediately.
The UI must never silently drop or automatically resend the uncertain frame.

This finite-generation behavior is memory-safe but can require the user to verify the
last interaction after replacement. That tradeoff is why the native launcher remains
gated until the direct transport and recovery UX are implemented and reviewed.

## Memory bound

The proof does not read node-pty private fields at runtime. It counts the only values
tmux-ide can cause the opaque API to retain: calls and bytes handed across the boundary.

At the default policy, one generation can allocate at most:

- 256 KiB of accepted payload in tmux-ide snapshots over its lifetime;
- 256 KiB of queued payload copies in the audited Unix node-pty implementation;
- 8,192 opaque write-task records; and
- one temporary caller/WS frame no larger than 16 KiB outside the capability.

The conservative reachable/pool-retained payload allowance is therefore 512 KiB plus
one 16 KiB caller frame per attachment. V8 object, allocator, and libuv request overhead
is implementation dependent, so this ADR does not pretend it has a byte-exact static
size. Instead, the supported-platform stress gate caps the measured post-GC RSS delta
at 8 MiB per stalled default-policy attachment. With the launcher's existing maximum
of 32 owned attempts, the corresponding admission-planning ceiling is 256 MiB RSS and
16 MiB accounted payload copies. The direct transport may choose a lower live cap; it
must not raise either input default without re-running the matrix and updating this ADR.

The hard configurable ceilings exist for isolated future use, not as direct-transport
defaults. Running every live attachment at the 4 MiB/16,384-frame ceiling requires a
separate aggregate capacity review.

## Direct transport requirements

The future binary WebSocket bridge must:

1. receive only `PtyBoundedInput`, output pause/resume, resize, and dispose capabilities;
   it must not receive `PtyProcess` or legacy `PtyProcess.write`;
2. limit the WebSocket input frame before creating a second copy;
3. serialize input and reserve its own per-socket/global temporary frame capacity;
4. call `boundedInput.write` exactly once per admitted frame;
5. on `PtyInputRejectedError`, disable input, retire that PTY/view generation, surface a
   typed recovery state, and issue a fresh descriptor/client;
6. on an accepted receipt whose snapshot is already exhausted, complete the same
   retirement path before accepting another frame;
7. never automatically replay input after reconnect; and
8. treat `Ctrl-C`, escape sequences, UTF-8, NUL, and high bytes as ordinary binary input.

Paste larger than 16 KiB must be chunked before the adapter, remain inside the socket's
temporary capacity, and stop at the first typed rejection. The renderer should show an
explicit reconnect/review state rather than report the full paste as delivered.

## Path to measurable completion

The preferred upstream/scoped-fork API is conceptually:

```ts
interface BoundedPtyWriter {
  tryWrite(
    data: Buffer,
  ):
    | { accepted: true; writeId: bigint; pendingBytes: number; pendingFrames: number }
    | { accepted: false; reason: "capacity" | "closed" };
  onWriteSettled(
    listener: (event: {
      writeId: bigint;
      status: "written" | "failed" | "closed";
      pendingBytes: number;
      pendingFrames: number;
    }) => void,
  ): Disposable;
}
```

Acceptance must occur inside the same public queue that owns the buffer, before copying.
Settlement must fire only after the whole frame leaves that queue or is failed/closed.
Unix must account partial writes and `EAGAIN`; Windows must expose `net.Socket.write`
completion and bound pre-ready deferred calls. Close must settle every outstanding id,
and a stalled completion watchdog must fail/close rather than retain forever.

If upstream does not accept this API, the fallback is a published scoped fork with
macOS arm64/x64 and Linux arm64/x64 prebuilds (WSL2 consumes Linux). A pnpm patch is not
acceptable because npm consumers of the published tmux-ide package would install the
unpatched dependency. A native `forkpty` helper with a bounded framed stdin protocol is
the second fallback; it needs its own signed/prebuilt distribution and resize/signal
lifecycle and is materially larger.

Estimated effort after the monotonic primitive:

| Option                               | Engineering estimate | Release/maintenance risk                               |
| ------------------------------------ | -------------------: | ------------------------------------------------------ |
| Upstream API + temporary scoped fork |             5–8 days | medium; upstream timing and prebuild publishing        |
| Permanent scoped fork                |            7–12 days | high; security updates and platform matrix become ours |
| Dedicated native helper              |           10–15 days | high initially; cleanest long-term ownership           |

## Test gates

The primitive/card is mergeable when:

- deterministic fake-never-drains tests prove byte, frame, and single-frame refusal
  occurs before another opaque call;
- tests prove input is snapshotted, backend throws retain accounting, close is permanent,
  and a new process—not a reset—creates fresh capacity;
- NUL and high bytes remain byte-exact;
- invalid policy is rejected at `NodePtyAdapter` construction;
- source/boundary review confirms native attachment code cannot call legacy `write`; and
- the launcher still throws `input-backpressure-unavailable` in production.

Before enabling direct input, additionally require:

- a live stalled-reader/SIGSTOP stress on macOS arm64/x64 and Linux arm64/x64 (including
  WSL2) that holds the process at its limits, repeatedly refuses more data, forces GC,
  and stays within the 8 MiB per-attachment RSS delta over time;
- aggregate stress at the chosen live-attachment cap;
- exhaustion/reconnect UX and no-auto-replay tests, including remote 16 KiB+ paste; and
- either explicit product acceptance of uncertain final-frame delivery or the public
  completion API above.

The opt-in runner is
`packages/daemon/scripts/stress-bounded-pty-input.mjs`. On 2026-07-22, its first local
macOS arm64 run under Node 26.5.0 filled 256 KiB behind a SIGSTOP reader, performed
4,096 typed refusals across eight GC/sample rounds, and measured a 416 KiB peak RSS
delta against the 8 MiB gate. That is one platform sample, not the required release
matrix.

## Risk register

- **Blocker for enabling interactive attachments**: the direct WebSocket retirement and
  recovery path is not implemented, and the current launcher intentionally exposes no
  input capability.
- **High**: monotonic fail-closed input bounds memory but cannot prove final-frame
  delivery before retirement. It is not equivalent to completion/drain.
- **High**: a local package-manager patch would disappear for npm consumers; do not use
  it as a production fix.
- **Medium**: V8/libuv metadata size and RSS retention vary by platform; the empirical
  supported-platform gate must stay tied to dependency/runtime upgrades.
- **Medium**: 16 KiB paste chunking and finite generation quotas need explicit UX to
  avoid appearing as silent truncation.
- **Medium**: current node-pty source is audited evidence, not a stable memory-layout
  contract. Dependency upgrades require re-auditing write copies and re-running stress.

## Rejected shortcuts

- Reading `_writeQueue`, `_agent.inSocket`, `_fd`, or other private fields in production.
- Assuming one event-loop tick, timeout, echo, prompt, or output frame means input drained.
- Calling void `write` slowly and subtracting guessed capacity.
- Sending terminal input through Electron main.
- Replacing terminal input with `tmux send-keys`; it bypasses real-client key/prefix/mouse
  semantics and is not byte-equivalent.
- Resetting a budget on the same PTY or replaying uncertain bytes after reconnect.
