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

The performance qualification gate uses the canonical SessionRuntime and dedicated
OpenTUI and web suites. It proves one control connection, 2/4/8-client convergence,
bounded slow/hidden-client delivery, NACK reseeding, generation rollover, terminal
mutation outcomes, authenticated-versus-external interaction identity, resize/drag
coalescing, terminal color fidelity, and demand-only HUD lifecycle. CI writes the
machine-readable `artifacts/performance-qualification.json`, publishes
`artifacts/performance-qualification-summary.md`, and uploads both as build evidence.

Every covered scenario in the JSON names the suites and files that actually ran.
Known gaps are evidence too: cold/warm startup, production-path stage timings, and
process RSS/heap slope are reported as `not-covered` or `not-measured`, never inferred
from a passing test command.

Portable CI never treats test-suite duration as UI latency. The checked-in reference
baseline at `performance/qualification-baseline.json` declares only this budget:

| Path                         | p95 budget |
| ---------------------------- | ---------: |
| local leading input to paint |   16.67 ms |

The separate reference result is nullable. It may be populated only with a host,
commit, ISO-8601 measurement time, positive sample count, and observed p95 from a real
reference run. A result from any commit other than the report commit is marked stale.
Input and paint endpoints must use the same client monotonic clock.
Portable CI currently reports input → tmux → parse → reduce → transport → paint stage
timings as `not-measured`; cross-process timestamps and suite durations are never
subtracted or relabeled as UI latency.

## Shared-core invariant

The browser GUI and OpenTUI may differ in rendering and input adaptation, but
they consume the same contracts, semantic application shell, workspace action
authority, and daemon resources. A feature is incomplete until its contract and
authority tests pass and both adapters have either acceptance coverage or an
explicit unsupported-state surface.
