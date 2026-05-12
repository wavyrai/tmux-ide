# Architecture

## Overview

`tmux-ide` is a small Node.js CLI that turns an `ide.yml` file into a tmux session layout.

The codebase is intentionally simple:

- [bin/cli.js](/Users/thijs/Developer/tmux-ide/bin/cli.js) is the CLI edge
- [src/](/Users/thijs/Developer/tmux-ide/src) contains command modules and runtime helpers
- [templates/](/Users/thijs/Developer/tmux-ide/templates) contains starter configs
- [docs/](/Users/thijs/Developer/tmux-ide/docs) is the public docs app

## Runtime Model

The main runtime flow is:

1. Parse CLI arguments in [bin/cli.js](/Users/thijs/Developer/tmux-ide/bin/cli.js)
2. Load and validate `ide.yml`
3. Resolve pane layout and tmux session structure
4. Create or inspect the tmux session
5. Send commands, apply titles, theme, focus, and optional team behavior

Key modules:

- [src/validate.js](/Users/thijs/Developer/tmux-ide/src/validate.js): config validation
- [src/launch.js](/Users/thijs/Developer/tmux-ide/src/launch.js): launch orchestration
- [src/lib/tmux.js](/Users/thijs/Developer/tmux-ide/src/lib/tmux.js): shared tmux command boundary
- [src/lib/launch-plan.js](/Users/thijs/Developer/tmux-ide/src/lib/launch-plan.js): pure launch planning logic
- [src/inspect.js](/Users/thijs/Developer/tmux-ide/src/inspect.js): effective config + runtime inspection

## Dashboard architecture

The Next.js dashboard under `dashboard/` follows the **RSC-shell +
siloed-blocks** rule: RSC by default, React client where state/refs
demand it, and foreign-framework UI (Solid today: `@tmux-ide/chat-solid`,
`@tmux-ide/v2-solid-widgets`) lives in named silo packages mounted via
a single bridge component each. The rule, the decision matrix, the
canonical bridge template, and the planned lint enforcement live in
[`docs/adr/0001-rsc-shell-and-siloed-blocks.md`](docs/adr/0001-rsc-shell-and-siloed-blocks.md);
the copy-pasteable bridge template plus the *why `[]`-deps* explainer
live in [`docs/contributing/bridge-template.md`](docs/contributing/bridge-template.md).
PRs touching dashboard ↔ silo boundaries should cite ADR-0001 instead
of restating the rule.

## PTY layer (T087)

The daemon's terminal surface — `/ws/pty/:id` and the `PtyBridge`
ring-buffer/replay layer — talks to PTY processes through a thin
abstraction:

- `packages/daemon/src/terminal/PtyAdapter.ts` is the interface
  (`spawn`/`spawnSync` → `PtyProcess` with `onData`/`onExit`).
- `packages/daemon/src/terminal/NodePtyAdapter.ts` is the only place
  `node-pty` is imported. Ports t3's `ensureNodePtySpawnHelperExecutable`
  chmod-on-helper trick so a fresh install boots cleanly.
- `packages/daemon/src/terminal/__tests__/MockPtyAdapter.ts` is the
  test double; the contract test parameterises every assertion across
  every registered adapter.
- `packages/daemon/src/server/pty-bridge.ts` consumes `PtyAdapter` via
  constructor injection — it no longer imports `node-pty` directly.

The daemon process MUST run under `node`/`tsx`, never `bun`: under Bun,
`node-pty`'s `onData` callback never fires (the PTY spawns and exits
silently). All daemon spawn sites pin the runtime to `tsx`
(`daemon-watchdog.ts`, `packages/tmux-bridge/src/monitor.ts`,
`src/lib/tmux.ts`). Production is `node dist/lib/daemon.js`.

See `packages/daemon/src/terminal/README.md` for long-form notes plus
roadmap links to G14-T07 (Effect runtime) and G14-T10 (reactor → Stream).

## Error Boundary

Structured command failures should reach the CLI edge as `CommandError` instances from [src/lib/output.js](/Users/thijs/Developer/tmux-ide/src/lib/output.js).

That keeps:

- human output and `--json` output consistent
- exit behavior centralized in the CLI entrypoint
- command modules easier to test

## tmux Boundary

[src/lib/tmux.js](/Users/thijs/Developer/tmux-ide/src/lib/tmux.js) is the shared wrapper for tmux operations.

It currently owns:

- session existence/state checks
- session creation and kill behavior
- pane listing
- pane splitting, titles, selection, and command injection
- tmux error classification

The direction of the codebase is to keep more tmux child-process handling here rather than in individual command modules.

## Testing Strategy

The project uses the Node.js built-in test runner.

Test layers:

- pure unit tests for helpers under [src/lib/](/Users/thijs/Developer/tmux-ide/src/lib)
- CLI contract tests in [src/cli.test.js](/Users/thijs/Developer/tmux-ide/src/cli.test.js)
- targeted command tests such as [src/inspect.test.js](/Users/thijs/Developer/tmux-ide/src/inspect.test.js)
- live tmux integration coverage in [src/integration.test.js](/Users/thijs/Developer/tmux-ide/src/integration.test.js)

The highest-risk path is still the launch lifecycle, so changes there should prefer:

- extracting pure helpers first
- adding unit coverage for decision-making
- adding live tmux coverage with `attach: false` when possible

## Release Checks

The intended release path is:

```bash
npm run check
```

That should cover:

- lint
- formatting
- tests
- docs build
- package packing sanity
