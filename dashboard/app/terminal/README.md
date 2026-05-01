# dashboard/app/terminal/[id]

v2.5.0 slice 1: browser-side terminal page.

Renders a wterm (or ghostty-web — Agent 2 picks based on integration ergonomics) terminal that connects to `WS /ws/pty/:id` on the v2.5.0 server.

See `plans/v2.5.0-protocol.md` for the wire protocol.

## Files (slice 1)

- `[id]/page.tsx` — terminal page; reads `:id` route param, opens WS, renders terminal
- `[id]/terminal.tsx` — client component wrapping the terminal renderer + protocol logic

## Renderer choice

Two options on the table:

1. `@wterm/react` + `@wterm/ghostty` (libghostty WASM backend) — well-documented React wrapper; matches our reference patterns
2. `ghostty-web@0.4.0` — already in dashboard package.json (unused); official ghostty web port

Pick whichever lands the e2e test green fastest. Document the choice in commit message.
