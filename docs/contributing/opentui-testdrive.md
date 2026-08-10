# OpenTUI test-drive workflow

The development harness runs the real tmux-ide OpenTUI inside the hidden
`_tmux-ide-testdrive` tmux session. It uses tmux's default socket, so the TUI
can mirror a real workspace, but it isolates its UI preferences under
`.tasks/tui-testdrive/home` and never mutates or kills the target workspace.

## Fresh local stack

Build every workspace package, the bundled CLI, and the standalone TUI:

```bash
pnpm build:workspace
pnpm build:cli
pnpm build:tui
```

Start the canonical daemon in one terminal:

```bash
node bin/cli.js --headless
```

Start the browser renderer in another terminal:

```bash
pnpm dev:web
```

`dev:web` reads the owner-only canonical daemon record and starts Vite with the
same-origin development gateway. Open
`http://127.0.0.1:5173/?devHost=1`. A plain `vite` invocation deliberately
falls back to illustrative preview data because it has no daemon authority.

## Test-drive the compiled TUI

```bash
pnpm tui:testdrive start --target my-session --cols 160 --rows 44
pnpm tui:testdrive capture
pnpm tui:testdrive key F2
pnpm tui:testdrive resize 100 30
pnpm tui:testdrive attach
```

`attach` opens the same hidden host that automation drives. Detach with the
normal tmux detach sequence if the app remains open. `Ctrl-Q` exits the app
cleanly through OpenTUI's renderer teardown.

Use `--source` to run the current TSX directly through Bun while iterating:

```bash
pnpm tui:testdrive restart --source --target my-session
```

Use `--debug` to enable OpenTUI's console overlay. Stderr is always retained at
`.tasks/tui-testdrive/stderr.log` and can be read with:

```bash
pnpm tui:testdrive logs
```

## Programmatic interaction

The harness gives agents and CI deterministic controls over the live renderer:

```bash
pnpm tui:testdrive text "printf 'hello from the pane\\n'"
pnpm tui:testdrive key Enter
pnpm tui:testdrive mouse click 42 8
pnpm tui:testdrive mouse drag 94 12 104 12
pnpm tui:testdrive capture --history 100
pnpm tui:testdrive status --json
pnpm tui:testdrive stop
```

For gesture assertions, the low-level mouse phases let a test inspect the
renderer while capture is still active:

```bash
pnpm tui:testdrive mouse move 94 12
pnpm tui:testdrive mouse down 94 12
pnpm tui:testdrive mouse hold 104 12
pnpm tui:testdrive capture --ansi # includes the active divider guide
pnpm tui:testdrive mouse up 104 12 # commits through daemon authority
```

Coordinates are zero-based screen cells. `hold` emits an SGR drag-motion event
without releasing the button, matching a modern mouse-capable terminal.

Run the live resize and navigation smoke check against an existing workspace:

```bash
pnpm test:tui-live -- --target my-session
```

Component-level OpenTUI snapshots remain the faster inner loop:

```bash
pnpm test:tui-renderer
```

## Optional black-box PTY drive with Pilotty

[Pilotty](https://github.com/msmps/pilotty) is useful as an independent,
framework-agnostic acceptance driver. It owns a real PTY, exposes screen hashes,
and can wait for the frame to change and settle after an input. It is deliberately
optional: tmux-ide does not import it and the built-in harness remains the normal
developer workflow.

Run the compiled TUI from a directory outside the checkout so Bun does not apply
the repository's source-mode preload to the standalone binary:

```bash
mkdir -p .tasks/pilotty/home
pilotty spawn --name tmux-ide-tui --cwd "$PWD/.tasks/pilotty/home" \
  env TMUX_IDE_CWD="$PWD" TMUX_IDE_HOME="$PWD/.tasks/pilotty/home" \
  TMUX_IDE_CLI="$PWD/bin/cli.js" \
  "$PWD/packages/daemon/dist/tui/tmux-ide-tui" app --target=my-session
pilotty resize -s tmux-ide-tui 160 44
pilotty snapshot -s tmux-ide-tui --settle 150 --format text
```

Drive one transition without a timing sleep:

```bash
HASH=$(pilotty snapshot -s tmux-ide-tui --format compact | jq -r '.content_hash')
pilotty key -s tmux-ide-tui F3
pilotty snapshot -s tmux-ide-tui --await-change "$HASH" --settle 150 --format text
```

The shared core stays renderer-neutral. The harness exercises the OpenTUI
adapter and tmux transport; it does not introduce a browser, canvas, or
closed-source SDK dependency into core.
