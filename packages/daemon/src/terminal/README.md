# `terminal/` — PTY adapter layer (T087)

The daemon's PTY surface is layered to keep `node-pty` (a native module
with sharp runtime edges) confined to one file. Everything above this
folder talks to the abstract `PtyAdapter` interface and never knows
whether the bytes came from a real OS PTY, a mock, or — eventually —
a remote transport.

```
+------------------+      +------------------------+      +-------------+
| server/pty-bridge | ---> |   PtyAdapter (iface)    | ---> | node-pty    |
|  (ring buffer,    |      |                         |      | (NodePty-   |
|   replay, WS      |      |  spawn  spawnSync       |      |  Adapter)   |
|   bridge)         |      |  PtyProcess primitives  |      +-------------+
+------------------+      +-------------+-----------+
                                        |
                                        v
                                +----------------+
                                | MockPtyAdapter  |
                                | (tests)         |
                                +----------------+
```

## Files

- `PtyAdapter.ts` — the contract: `PtySpawnInput`, `PtyExitEvent`,
  `PtyProcess`, `PtyAdapter`, and the `PtySpawnError` taxonomy.
- `NodePtyAdapter.ts` — concrete implementation backed by `node-pty`.
  Ports t3's `ensureNodePtySpawnHelperExecutable` chmod-on-helper trick
  so a fresh install always boots.
- `attachments/pty-tmux-attachment-launcher.ts` — daemon-owned normal
  `tmux attach-session` PTY client. It accepts canonical operation metadata,
  reconstructs the complete guarded argv itself, and rejects unknown fields;
  no caller-authored tmux argv crosses this boundary. Socket, exact tmux
  executable, cwd, and sanitized environment remain daemon-owned and are
  identical for spawn and readiness proof. Output stays bounded until tmux
  proves the spawned client PID is attached to that exact marked one-window
  view.
- `__tests__/MockPtyAdapter.ts` — scripted PTY for the test suite. Lives
  under `__tests__/` so production bundling never picks it up.
- `__tests__/*.test.ts` — contract tests parameterised over every
  adapter, plus adapter-specific units.

## Why this exists

`node-pty` is a native module compiled against an underlying runtime ABI.
T085 burned half a day finding out that under Bun, `node-pty`'s `onData`
callback never fires — the PTY spawns, the child exits, and zero bytes
flow back. The fix had to live in two places:

1. **Runtime pinning** (T087 PART 1): every daemon spawn site uses
   `node`/`tsx`, never `bun`. See `daemon-watchdog.ts`,
   `tmux-bridge/src/monitor.ts`, `src/lib/tmux.ts`. The
   `packages/daemon/package.json` `dev`/`start` scripts mirror t3's
   `apps/server/package.json` (`tsx --watch` in dev, `node dist/...` in
   prod).
2. **Adapter abstraction** (T087 PART 2): a thin interface so the future
   doesn't paint us into the same corner. New runtimes get their own
   adapter; tests use `MockPtyAdapter` so we never accidentally spawn a
   real PTY in CI.

## When to add a new adapter

Anything that produces PTY-shaped bytes is fair game. Concrete examples
we've considered:

- A **remote PTY** adapter that proxies over WebSocket to a daemon
  running on another host. Drops in here without touching `pty-bridge`.
- A **mock SSH** adapter for integration tests that need a deterministic
  remote shell. Built on `MockPtyAdapter` semantics.
- An **xterm replay** adapter that pipes a captured `.cast` file back
  through `onData` for demos. Useful for marketing GIFs.

Each new adapter MUST satisfy `PtyAdapter.contract.test.ts` — the
parameterised suite runs every contract assertion against every adapter
we register there.

## Constraints we honour

- `spawn` is async; `spawnSync` exists for legacy callers (today:
  `server/pty-bridge.ts`). Adapters that can't satisfy `spawnSync` throw
  `PtySpawnError({ code: "sync_unsupported" })`.
- Errors are typed (`PtySpawnError` with a discriminator) so the WS
  bridge can surface a structured error frame instead of grepping native
  messages.
- `kill()` is idempotent. After it the adapter MUST guarantee at most
  one terminal `onExit` event — subsequent `onExit(...)` subscribers
  receive an inert disposer.
- No production code outside `NodePtyAdapter.ts` imports `node-pty`.
  This is enforced by `pty-bridge.ts` now consuming `PtyAdapter` and is
  the gate G14-T10 will tighten further.
- Native PTY input is intentionally not exposed by the grouped attachment
  launcher yet. Installed node-pty's public `IPty.write(): void` offers no
  drain/completion or pending-capacity signal while its Unix implementation
  has a private asynchronous queue. Until an adapter/native helper provides a
  real bounded-write contract, interactive writes fail with
  `input-backpressure-unavailable`; this prevents stalled tmux readers from
  growing an unobservable queue without bound. Output uses public
  `IPty.pause()`/`resume()` and byte+frame caps.
- Read-only attachment clients are also fail-closed in this first launcher
  slice. They fail before PTY spawn with `read_only_unavailable` until the
  daemon proves the installed tmux version and continuously holds an
  interactive geometry owner with defined owner-loss behavior. The tmux
  `attach-session -r` flag alone is not treated as a geometry-safety proof.
- Successful attach/recover execution returns a first-class one-use
  `clientClaim` key through the executor and lease-manager result, so the next
  stream layer can adopt the exact PTY without intercepting the transport.
  Proof-ready clients remain paused and must be claimed within the bounded
  claim deadline (two seconds by default); otherwise the launcher terminates
  only that client and releases capacity.

## Roadmap notes

- **G14-T07** introduces Effect runtime. When that lands, this contract
  grows an `Effect.Effect<PtyProcess, PtySpawnError>` shape; the plain-
  TS interface here stays so adapters can implement either side.
- **G14-T10** moves chat reactor → Effect Stream. PTY bytes will flow
  through the same Stream pipeline; today's `EventEmitter`-based
  `pty-bridge` becomes the bottom of that Stream.
