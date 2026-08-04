# Running the renderer in a plain browser (m44.2)

The desktop renderer normally reaches the daemon through the Electron preload,
which publishes `window.tmuxIdeHost`. For app-level browser testing there is a
second, **development-only** implementation of that same interface —
`src/runtime/dev-web-host.ts` — which talks to a real daemon directly over its
HTTP API and WebSockets. No Electron, no mocks, no fixtures: a real tmux fleet
behind a real daemon, rendered by the real app.

This is the seam an automated browser suite drives. It is off by default and
cannot be turned on in a production build.

## What has to be true before it activates

All five, or the renderer keeps its existing honest preview surface:

1. `import.meta.env.DEV` — a Vite dev server, never a built bundle. The guard in
   `src/main.tsx` is a build-time constant, so the whole host is eliminated from
   production output rather than merely disabled in it.
2. No Electron preload already published `window.tmuxIdeHost`. The development
   host never replaces a production bridge.
3. An explicit opt-in: `VITE_TMUX_IDE_DEV_HOST=1` **or** `?devHost=1` on the URL.
4. `VITE_TMUX_IDE_DEV_DAEMON_URL` is a canonical loopback origin **with a port**
   (`http://127.0.0.1:8787`). Anything routable off this machine is refused.
5. `VITE_TMUX_IDE_DEV_OWNER_TOKEN` is non-empty.

The policy itself is `src/runtime/dev-web-host-config.ts`, unit-tested in
`dev-web-host-config.test.ts`. Each refusal has a named reason.

## The other gate: the dev server's CSP

The Vite dev server sends `connect-src 'self' ws://127.0.0.1:<dev port>`. That
alone refuses every daemon fetch and every daemon WebSocket, so a browser tab
cannot reach a daemon no matter what else is configured.

Setting `VITE_TMUX_IDE_DEV_DAEMON_URL` widens `connect-src` by **exactly one**
loopback origin — its `http:` and `ws:` forms — for the dev server only. A
malformed or non-loopback value is a hard startup error, not a silent widening.
`vite build` output is untouched; the packaged renderer's CSP is owned by
`apps/electron-shell/src/packaged-renderer-protocol.ts`.

`TMUX_IDE_DEV_SERVER_PORT` moves the dev server and its CSP together. Prefer it
over `vite --port`, which would move the server but leave the CSP naming 5173.

## Where the credential comes from

The daemon writes a canonical record to `$TMUX_IDE_DAEMON_INFO_DIR/daemon.json`
containing `port`, `pid`, `instanceId`, and `authToken` — the owner bearer. The
harness starting the daemon reads that file and exports the values; it is the
same credential `apps/electron-shell/scripts/smoke-test.mjs` uses in its
`daemonClient()` helper.

This mode deliberately puts the owner token in the page. That is a real
difference from production, where the bearer never leaves Electron main: here
the harness already owns the daemon it started, so simulating a privilege
boundary that does not exist would only obscure what is being tested. It is why
the mode is loopback-only, opt-in, and absent from every built bundle.

## By hand

```bash
# 1. A daemon over a scratch tmux server (never the user's real one).
TMUX_IDE_DAEMON_INFO_DIR=/tmp/my-daemon \
TMUX="/tmp/my-tmux.sock,$TMUX_SERVER_PID,0" \
  node bin/cli.js --headless

# 2. Its port and owner token.
PORT=$(jq -r .port  /tmp/my-daemon/daemon.json)
TOKEN=$(jq -r .authToken /tmp/my-daemon/daemon.json)

# 3. The dev server, pointed at that daemon.
cd apps/desktop-renderer
TMUX_IDE_DEV_SERVER_PORT=5173 \
VITE_TMUX_IDE_DEV_HOST=1 \
VITE_TMUX_IDE_DEV_DAEMON_URL="http://127.0.0.1:$PORT" \
VITE_TMUX_IDE_DEV_OWNER_TOKEN="$TOKEN" \
  pnpm dev

# 4. Open http://127.0.0.1:5173/?devHost=1
```

A session must be **adopted** (`@tmux_ide_adopted`) to appear in the fleet
catalog, and **promoted** (`POST /api/v2/action/workspace.promote` with an
`X-Tmux-Ide-Operation-Id` header) before its panes become attachable.

## The end-to-end proof

`scripts/dev-web-host-live-proof.mjs` builds all of the above from scratch and
drives it with headless Chromium, in four rungs:

- **a** the app boots live — `data-shell-source="runtime"`, not the preview
  fallback;
- **b** the fleet catalog reaches the page, the daemon event socket goes live,
  and the fleet sidebar store settles with the session rendered;
- **c** a pane-stream lease issues and its WebSocket seeds, from the page's own
  origin;
- **d** the interactive terminal attachment settles.

```bash
node apps/desktop-renderer/scripts/dev-web-host-live-proof.mjs
# TMUX_IDE_PROOF_ARTIFACTS=<dir> keeps the screenshot and DOM text.
```

Everything it creates is disposable and PID-scoped: an isolated tmux socket
under `/tmp`, one scratch session, temp HOME/registry/settings/daemon-info, and
only the daemon, Vite, and browser processes it started. Cleanup runs on every
exit path.

## What this host does not do

- **No transport supervision.** It publishes `connection.changed`, never
  `transport.changed`: the production `transport.changed` is Electron main's
  retry supervisor reporting itself, and claiming a phase here would make the
  renderer defer to a supervisor that does not exist instead of running its own
  bounded recovery. It does not reconnect the event socket after a close.
- **No native directory picker.** `workspace.openProjectDirectory` returns null;
  a browser has no real filesystem path to offer, and the daemon would not
  accept a renderer-authored one.
- **No window, menu, quit, or update control.** Those are Electron verbs; the
  methods exist and are inert.
