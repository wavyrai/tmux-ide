# src/server/

v2.5.0 unified server. Single-binary HTTP + WS surface.

Slice 1 scope: WebSocket PTY bridge endpoint at `/ws/pty/:id`. Spawns a shell via node-pty, bridges to wterm in the browser.

See `plans/v2.5.0-protocol.md` for the wire protocol.
See `plans/v2.5.0-architecture.md` for the v2.5.0 design.

## Files (slice 1)

- `index.ts` — Hono app, server bootstrap (`tmux-ide server` entry point)
- `pty-bridge.ts` — node-pty bridge: spawn, write, resize, lifecycle, cleanup
- `ws-route.ts` — WebSocket route handler implementing the protocol
- `*.test.ts` — Vitest unit tests
