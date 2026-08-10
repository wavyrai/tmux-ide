# GUI and TUI release quality

“Bug free” is treated as an evidence standard: no known critical defects, no
uncaught errors or lifecycle warnings, and the real daemon/tmux paths must pass
within explicit latency budgets. Preview fixtures are not release evidence.

## Web GUI gate

```bash
pnpm test:web-live
```

The test owns an isolated tmux server, canonical daemon, Vite gateway, and
browser. It proves the runtime shell, fleet catalog, event socket, passive pane
stream, and interactive terminal attachment. Console warnings/errors fail the
run. Defaults:

- live runtime shell: at most 5,000 ms
- interactive terminal settled: at most 12,000 ms from navigation

Use `WEB_BUDGET_LIVE_SHELL_MS` and `WEB_BUDGET_TERMINAL_READY_MS` only to make
a local gate stricter or to diagnose a known slow host.

For a human/browser test against the canonical local daemon:

```bash
node bin/cli.js --headless
pnpm dev:web
```

Then open `http://127.0.0.1:5173/?devHost=1`. The development gateway keeps the
owner bearer out of browser JavaScript.

## OpenTUI gates

```bash
pnpm test:tui-renderer
pnpm test:tui-live -- --target <session> --source
pnpm test:tui-perf
```

The renderer suite owns and destroys every OpenTUI renderer. Cross-file listener
accumulation is a defect, not accepted test noise. The live test-drive proves a
real attach and responsive frames at 100x30, 160x44, and 200x60; defaults are a
10,000 ms attach budget and 1,000 ms per resize settle.

The performance test measures real tmux control-feed parse, framebuffer
snapshot, and keyboard echo-to-paint paths under idle, flood, and alternate
screen workloads. Default p95 ceilings are:

| Path                        | p95 budget |
| --------------------------- | ---------: |
| flood feed parse            |       1 ms |
| alternate-screen feed parse |       1 ms |
| flood snapshot              |       4 ms |
| alternate-screen snapshot   |       6 ms |
| input echo                  |      15 ms |
| input paint                 |      50 ms |

Each measured path also has a minimum sample count so an inactive or broken tap
cannot pass with zeroes.

## Shared-core invariant

The browser GUI and OpenTUI may differ in rendering and input adaptation, but
they consume the same contracts, semantic application shell, workspace action
authority, and daemon resources. A feature is incomplete until its contract and
authority tests pass and both adapters have either acceptance coverage or an
explicit unsupported-state surface.
