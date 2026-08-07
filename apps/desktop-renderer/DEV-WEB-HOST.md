# Running the renderer in a plain browser (m44.2)

The desktop renderer normally reaches the daemon through the Electron preload,
which publishes `window.tmuxIdeHost`. For app-level browser testing there is a
second, **development-only** implementation of that same interface —
`src/runtime/dev-web-host.ts` — which reaches a real daemon through Vite's
same-origin development gateway. No Electron, no mocks, no fixtures: a real
tmux fleet behind a real daemon, rendered by the real app.

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
4. `VITE_TMUX_IDE_DEV_GATEWAY=1` selects the same-origin gateway.
5. Vite receives `TMUX_IDE_DEV_DAEMON_URL` and `TMUX_IDE_DEV_OWNER_TOKEN`.
   Neither value is exposed through `import.meta.env` or browser JavaScript.

The policy itself is `src/runtime/dev-web-host-config.ts`, unit-tested in
`dev-web-host-config.test.ts`. Each refusal has a named reason.

## The other gate: the dev server's CSP

The Vite dev server keeps `connect-src` at `'self'`. It proxies the reviewed
`/api`, `/ws`, and one-use terminal redemption routes to the selected loopback
daemon. A malformed or non-loopback daemon origin is a hard startup error.
`vite build` output is untouched; the packaged renderer's CSP is still owned by
`apps/electron-shell/src/packaged-renderer-protocol.ts`.

`TMUX_IDE_DEV_SERVER_PORT` moves the dev server and its CSP together. Prefer it
over `vite --port`, which would move the server but leave the CSP naming 5173.

## Where the credential comes from

The daemon writes a canonical record to `$TMUX_IDE_DAEMON_INFO_DIR/daemon.json`
containing `port`, `pid`, `instanceId`, and `authToken` — the owner bearer. The
harness starting the daemon reads that file and exports the values; it is the
same credential `apps/electron-shell/scripts/smoke-test.mjs` uses in its
`daemonClient()` helper.

Like Electron main, the development gateway owns the daemon bearer and injects
it only on proxied daemon requests. The page receives one-use terminal
redemption tickets, never the reusable owner credential.

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
VITE_TMUX_IDE_DEV_GATEWAY=1 \
TMUX_IDE_DEV_DAEMON_URL="http://127.0.0.1:$PORT" \
TMUX_IDE_DEV_OWNER_TOKEN="$TOKEN" \
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

- **No Electron process supervision.** It publishes `connection.changed`, never
  `transport.changed`: the latter belongs to Electron main's daemon-child
  supervisor. The browser event socket does reconnect through the shared
  renderer-neutral runtime supervisor, preserving the last usable snapshot
  while the daemon is temporarily unavailable.
- **No native directory picker.** `workspace.openProjectDirectory` returns null;
  a browser has no real filesystem path to offer, and the daemon would not
  accept a renderer-authored one.
- **No window, menu, quit, or update control.** Those are Electron verbs; the
  methods exist and are inert.
