# Desktop renderer

This package owns the browser-native tmux-ide desktop UI. It is a standard
SolidJS/Vite application and must remain runnable without Electron.

- Do not import `electron`, Node built-ins, or `@tmux-ide/electron-shell`.
- Request native behavior only through `HostCapabilities` from
  `@tmux-ide/contracts`.
- Keep terminal and mission truth behind daemon contracts; this package renders
  projections rather than starting processes.

Run `pnpm --filter @tmux-ide/desktop-renderer dev` for browser development.
The browser fallback implements the same narrow host shape with safe no-op
native capabilities.

## Native terminal transport boundary

`src/terminal/native-terminal-websocket-transport.ts` is the renderer-owned
direct WebSocket adapter for a future native terminal issue capability. Its
only privileged dependency is an injected `issueAttachment(request)` function:

- the request is validated by the shared semantic terminal-attachment contract;
- the result remains `unknown` and is accepted only by a card-local untrusted
  parser; this does not establish a new shared/public wire contract;
- the parsed value must be an exact, short-lived
  loopback `ws:`/`wss:` descriptor with the one supported subprotocol;
- the one-use ticket is sent in exactly one bounded first control frame and is
  never placed in the URL, an error, retained attachment state, or reconnect;
- binary daemon output crosses directly to the Solid terminal listener through
  a fixed frame/count/byte queue;
- resize is a bounded, latest-value-coalesced control operation; and
- `write()` remains fail-closed with `input-backpressure-unavailable` until the
  daemon recovery/no-replay gate is enabled in a separate reviewed change.

The adapter has no Electron import, host capability implementation, daemon
credential, raw tmux identity, process API, or automatic reconnect loop. A
retry creates a new issue request, ticket, socket, and real tmux redraw.
