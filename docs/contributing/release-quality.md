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
pnpm test:performance-qualification
```

The renderer suite owns and destroys every OpenTUI renderer. Cross-file listener
accumulation is a defect, not accepted test noise. The live test-drive proves a
real attach and responsive frames at 100x30, 160x44, and 200x60; defaults are a
10,000 ms attach budget and 1,000 ms per resize settle.

The performance qualification gate uses the canonical SessionRuntime and both
renderer adapters. It proves one control connection, 2/4/8-client convergence,
bounded slow/hidden-client delivery, NACK reseeding, generation rollover,
authenticated mutation outcomes, and demand-only HUD lifecycle. CI writes
`artifacts/performance-qualification.json` and uploads it as build evidence.

Portable CI never treats test-suite duration as UI latency. The checked-in
reference baseline at `performance/qualification-baseline.json` reserves the
wall-clock gate for a pinned Apple-silicon macOS reference host:

| Path                         | p95 budget |
| ---------------------------- | ---------: |
| local leading input to paint |   16.67 ms |

Input and paint endpoints must be measured on the same client monotonic clock.
The stage trace still publishes input → tmux → parse → reduce → transport →
paint durations, but cross-process timestamps are never subtracted.

## Shared-core invariant

The browser GUI and OpenTUI may differ in rendering and input adaptation, but
they consume the same contracts, semantic application shell, workspace action
authority, and daemon resources. A feature is incomplete until its contract and
authority tests pass and both adapters have either acceptance coverage or an
explicit unsupported-state surface.
