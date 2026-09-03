# src/server/

v2.5.0 unified server. Single-binary HTTP + WS surface.

Legacy scope: loopback-only WebSocket PTY bridge endpoint at `/ws/pty/:id`. Spawns a shell via node-pty and bridges it to a local browser. This server is deprecated; new integrations use the authenticated canonical daemon started by `tmux-ide --headless`.

See `plans/v2.5.0-protocol.md` for the wire protocol.
See `plans/v2.5.0-architecture.md` for the v2.5.0 design.

## Files (slice 1)

- `index.ts` — Hono app, server bootstrap (`tmux-ide server` entry point)
- `pty-bridge.ts` — node-pty bridge: spawn, write, resize, lifecycle, cleanup
- `ws-route.ts` — WebSocket route handler implementing the protocol
- `*.test.ts` — Vitest unit tests
