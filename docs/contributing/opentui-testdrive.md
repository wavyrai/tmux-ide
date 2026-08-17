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

Start the browser renderer. This command discovers or starts the canonical
daemon itself:

```bash
pnpm dev:web
```

`dev:web` ensures the daemon, then reads the owner-only canonical record and starts Vite with the
same-origin development gateway. Open
`http://127.0.0.1:5173/?devHost=1`. A plain `vite` invocation deliberately
falls back to illustrative preview data because it has no daemon authority.

## Unified real-product rig

Use the product rig when a change must be proven in Web, OpenTUI, and tmux at
the same time:

```bash
pnpm product:testdrive start
pnpm product:testdrive status --json
pnpm product:testdrive capture --json
pnpm product:testdrive smoke --json
pnpm product:testdrive stop
```

The rig owns exactly one disposable runtime namespace under `/tmp`: one
non-default tmux socket and target session, one daemon generation, one real
OpenTUI process hosted in a PTY, and one real Chromium page behind the reviewed
same-origin development gateway. It never reads or mutates the default tmux
socket or canonical user catalog. Every capture writes terminal ANSI, a Web
screenshot and DOM summary, tmux layout truth, and a timestamped JSONL timeline
under `.tasks/product-test-rig/artifacts`.

Readiness deliberately names two separate boundaries:

- `appChromeFrameMs`: OpenTUI has painted application chrome;
- `coherentTerminalFrameMs`: a non-empty semantic terminal layout has reached
  the OpenTUI renderer.

The former is not counted as a usable terminal frame. Rig startup now proves a
real Web and OpenTUI coherent terminal frame, shared daemon/session identity,
multi-client authority convergence, generation-fenced writes, atomic workspace
handoff, and recovery of both clients across a daemon generation restart.
`smoke` additionally proves viewport resize, evidence capture, tmux layout
agreement, and bounded cleanup. The rig still does **not** qualify input to
consumed paint, operation-correlated drag settlement, or packed-install first
run; those remain explicitly unmeasured in the checked-in M59 baseline.

Inspect the source/metric baseline without starting the rig:

```bash
pnpm product:testdrive inventory --json
```

Inventory is side-effect free. It includes the checked-in product scope, known
defects, measured and unmeasured performance boundaries, rig capabilities, and
architecture-debt counts.

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

Protocol-sensitive input uses one strict versioned JSON command. It injects
exact bytes through the host pane PTY with `load-buffer`/`paste-buffer`, not
tmux key-name translation:

```bash
pnpm tui:testdrive input '{"version":1,"kind":"paste","text":"first line\nsecond line"}'
pnpm tui:testdrive input '{"version":1,"kind":"focus","state":"blur"}'
pnpm tui:testdrive input '{"version":1,"kind":"focus","state":"focus"}'
pnpm tui:testdrive input '{"version":1,"kind":"application-mouse","action":"click","x":42,"y":8}'
pnpm tui:testdrive input '{"version":1,"kind":"selection-drag","from":{"x":42,"y":8},"to":{"x":55,"y":8},"contentRect":{"x":40,"y":6,"width":80,"height":24}}'
pnpm tui:testdrive input '{"version":1,"kind":"copy-capture","timeoutMs":2000}'
```

`paste` sends an explicit bracketed-paste sequence to OpenTUI. Application
mouse input is intentionally separate from the legacy divider-drag helper.
Coordinates are zero-based and must fit the immutable host pane's current
geometry. Paste is capped at 64 KiB, clipboard evidence at 1 MiB, and one
monotonic timeout covers the complete operation. `selection-drag` first enters
and validates OpenTUI's pane-local select mode, proves the highlight, then
captures the release-triggered copy. Its required `contentRect` is the exact
projected pane-content rectangle; multi-row selection wraps inside that box and
never treats sidebar or chrome columns as terminal content. `copy-capture`
sends Ctrl-C through the same PTY path. Both clipboard operations use an
operation-scoped, pane-scoped tmux hook tied to the exact pane and operation
nonce. It remains armed through a bounded quiet window so missing, unrelated,
multiple, or callback-overflow events fail.
Successful JSON reports only clipboard byte count and SHA-256—no clipboard
plaintext or base64.

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

## Diagnose a blank or stale TUI

Use the causal diagnostic before debugging a blank terminal surface by eye:

```bash
pnpm tui:diagnose --target my-session
```

It starts the compiled TUI against the canonical daemon, waits for the first
terminal-frame publication, captures the framebuffer, and checks the complete
path in order:

1. the canonical daemon record agrees with the live `/identity` endpoint;
2. Catalog V2 pane counts agree with exact tmux session truth;
3. Application Shell V3 exposes every pane as semantically attachable;
4. the OpenTUI runtime applies inventory and a non-empty active-window layout;
5. runtime connection precedes the first terminal-frame publication;
6. stable text captured from tmux is present in the final OpenTUI framebuffer.

The command prints the first broken boundary and writes a machine-readable
bundle under `.tasks/tui-diagnostics/latest/`: `report.json`, the rendered
`frame.txt`, runtime `timeline.jsonl`, `stderr.log`, exact `tmux-truth.json`,
`catalog.json`, and `application-shell.json`. This distinguishes “the app
painted chrome” from “terminal cells reached the renderer.”

Use the current build while iterating, or keep the hidden host alive for manual
inspection:

```bash
pnpm tui:diagnose --target my-session --no-build
pnpm tui:diagnose --target my-session --keep
pnpm tui:testdrive attach
pnpm tui:testdrive stop
```

The focused analyzer contract runs without tmux or a daemon:

```bash
pnpm test:tui-diagnose
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
