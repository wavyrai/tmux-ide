# OpenTUI test-drive workflow

## Native Pilotty driver for an isolated development instance

Pilotty can host the real compiled app in a PTY and drive keyboard input,
ordinary clicks, scrolling and terminal resizing. The repository adapter uses
its own socket directory, `.tasks/pilotty-dev`, and the existing development
manager's `pilotty` instance. It never falls back to the installed production
daemon. Source and native binaries stay under the ignored `context/` directory:

```sh
# Only clone if this checkout is not already present.
git clone https://github.com/msmps/pilotty context/pilotty
pnpm dev:pilotty build

# Prepare the qualified tmux bundle as described in development-worktrees.md.
# Use the Bun version recorded in .bun-version, not an arbitrary global Bun.
pnpm dev:instance rebuild --name pilotty --bun /absolute/path/to/pinned/bun --json
pnpm dev:pilotty app
pnpm dev:pilotty snapshot -s ide --format text
pnpm dev:pilotty key -s ide F5
pnpm dev:pilotty snapshot -s ide --settle 100 --timeout 3000 --strict
pnpm dev:pilotty resize -s ide 120 36
pnpm dev:pilotty snapshot -s ide --settle 100 --timeout 3000 --strict
pnpm dev:pilotty key -s ide Escape
pnpm dev:pilotty key -s ide Ctrl+Q
pnpm dev:pilotty status -s ide
```

Wait for `status` to report an exited process; sending Ctrl+Q is not itself proof
of exit. `snapshot --strict` rejects a timeout or exited session, so capture final
exit evidence with `status` or a non-strict snapshot instead. Keep flags before
positional arguments. Every command must use the adapter so it reaches the same
private Pilotty namespace. Rebuilds do not replace a running app or daemon; use
the development manager's explicit activation workflow when testing new code.

After collecting evidence, stop the driver and its isolated development runtime:

```sh
pnpm dev:pilotty stop
pnpm dev:instance down --name pilotty --json
```

`stop` ends all PTYs in this worktree's Pilotty namespace. `down` also stops pane
work in the selected development instance. Neither command targets production.

The adapter also accepts the existing strict application-mouse JSON schema for
modifier clicks and individual drag phases. Coordinates are zero-based and
validated against the live PTY dimensions before SGR bytes are sent through
Pilotty's native `type` command:

```sh
pnpm dev:pilotty input -s ide '{"version":1,"kind":"application-mouse","action":"click","x":30,"y":6,"modifiers":["ctrl"]}'
pnpm dev:pilotty input -s ide '{"version":1,"kind":"application-mouse","action":"down","x":50,"y":10}'
pnpm dev:pilotty input -s ide '{"version":1,"kind":"application-mouse","action":"drag","x":60,"y":10}'
pnpm dev:pilotty input -s ide '{"version":1,"kind":"application-mouse","action":"up","x":60,"y":10}'
```

This is an interaction driver, not a physical display benchmark. Host-terminal
link handling, displayed frame pacing and visual contrast still need
real-terminal checks. A settled headless screen is not proof of smoothness.

## Existing tmux-hosted workflow

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

## Unified real-product rig

Use the product rig for isolated OpenTUI and tmux evidence. The former browser
client is retired; terminal-only reports do not claim cross-client coverage:

```bash
pnpm product:diagnose --journey session-recreate
pnpm product:testdrive status --json
pnpm product:testdrive capture --json
pnpm product:testdrive smoke --json
pnpm product:testdrive stop
```

`diagnose` defaults to `coherent-first-pane`. Each repetition uses a fresh private
runtime namespace:

```bash
pnpm product:testdrive diagnose --journey coherent-first-pane --repeat 3 --json
```

`--repeat` accepts 1–10 attempts. `inventory --json` lists retained journeys.
The former cross-client handoff, Card5 daemon-restart and monolithic
runtime-qualification journeys are retired and rejected before startup.
Daemon replacement remains covered by the terminal release gate and installed
journey; this retirement does not remove that product requirement.

Diagnostic bundle version 2 contains report, alignment, timeline, tmux truth,
daemon/client state, terminal ANSI, `scope.json`, stderr and reproduction script.
It explicitly declares terminal-only evidence and unmeasured browser coverage;
a historical browser bundle cannot silently qualify this scope. Missing terminal
or cleanup evidence remains a failure. Files are sealed after publication.

The rig owns a disposable namespace with a non-default tmux socket, daemon and
OpenTUI client. Browser/Electron clients are no longer launched. Captures retain
terminal ANSI, tmux layout truth and timestamps, not a browser screenshot.

Readiness deliberately names two separate boundaries:

- `appChromeFrameMs`: OpenTUI has painted application chrome;
- `coherentTerminalFrameMs`: a non-empty semantic terminal layout has reached
  the OpenTUI renderer.

The former is not counted as a usable terminal frame. Coherent startup requires
exact native, daemon and OpenTUI identity and visible terminal evidence. It does
not qualify a future GUI, browser parity, or terminal output timing.
