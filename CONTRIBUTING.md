# Contributing

tmux-ide is open source under the MIT license. This guide covers local setup,
the checks every pull request must pass, and how to work on the docs and demo.
The website version is [Contributing to tmux-ide](https://tmux-ide.com/docs/contributing).

## Setup

```bash
git clone https://github.com/wavyrai/tmux-ide
cd tmux-ide
```

Requirements:

- Node.js 20 or newer; use the same executable and ABI for installation, builds and tests
- The pnpm version pinned in `packageManager` and Bun version in `.bun-version`
- Native compiler prerequisites and the pinned, patched tmux bundle for TUI and installed-runtime checks (see the worktree guide below)

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

## Development workflow

Follow the [isolated worktree quickstart](docs/guides/development-worktrees.md) to run two branches with separate daemons, tmux servers, state and builds. It covers native setup, rebuild/apply, logs, stop/reset and the Docker/SSH workflow.

The [development-instance architecture contract](docs/development-instances.md) explains ownership and recovery. Durable worktree instances, the production daemon and disposable test fixtures have separate lifetimes.

Main commands:

```bash
pnpm test
pnpm docs:build
pnpm check
```

`pnpm check` is the main contributor gate: workspace lint/format/types, package and runtime tests, docs, packing, installed-runtime qualification and native/desktop smoke checks. `pnpm release:opentui:check` separately qualifies the terminal release artifacts and installed journey. Keep both results tied to the exact candidate commit.

`npm publish` is guarded by `prepublishOnly`, which runs `pnpm release:opentui:check` and `scripts/prepublish-opentui-check.mjs`, not the broad `pnpm check` gate. Follow [RELEASE.md](RELEASE.md) for the terminal release checklist. Deferred web/desktop checks remain independent CI signals.

Consult the [native and dependency maintenance inventory](patches/README.md) before changing OpenTUI, bundled tmux or terminal parser inputs. It records pins, patches, regression evidence and upgrade/removal conditions.

See [isolated development CI](scripts/development-ci.md) for scoped lanes,
resource bounds and evidence requirements.

## Testing notes

- `pnpm test` runs the selected workspace package test suites, including daemon unit/live tests.
- `pnpm test:daemon-bun` and `pnpm test:tui-renderer` select their separate Bun suites.
- `pnpm typecheck:workspace` checks package types; `pnpm build` bundles the CLI.
- Live tests require their declared tmux/native prerequisites; a skipped platform case is not a qualification pass.
- `pnpm docs:build` validates the docs app production build.

Run a focused Vitest test from its owning package so that its configuration and
runner exclusions apply. An unconfigured repository-root `vitest` search can
collect ignored historical copies under `plans/` or worktrees.

```bash
# Daemon unit test, using the daemon's Vitest configuration
pnpm --dir packages/daemon exec vitest run src/terminal/mirror/session-channel.test.ts
# Real-process daemon tests use the separate, serial live lane
pnpm --dir packages/daemon exec vitest run --config vitest.live.config.ts src/lib/__tests__/installed-daemon-upgrade-live.test.ts
# Gallery fixtures use Bun and the production OpenTUI preload
pnpm typecheck:tui-gallery
pnpm test:tui-gallery
```

Keep a fixture with the owner it exercises: daemon renderer fixtures and preloads
live in `packages/daemon/test-support`, shared package tests stay in that package,
and installed-product fixture helpers live in `scripts/lib`. Renderer tests must
not replace real-process ownership or installed-tarball qualification. Preserve the
package-specific Vitest include/exclude lists when adding a suite; Bun renderer
tests and real-process live tests have different runtime requirements.

For a manual smoke test, prepare the patched native bundle and pinned Bun using
the worktree guide, then create a named development instance:

```bash
pnpm --silent dev:instance rebuild --name smoke --bun /absolute/path/to/pinned/bun --json
pnpm --silent dev:instance up --name smoke --json
pnpm dev:instance app --name smoke
```

Inspect that same instance from another shell in the same worktree:

```bash
pnpm --silent dev:instance status --name smoke --json
pnpm --silent dev:instance diagnostics --name smoke --json
```

Closing the app preserves the instance and pane work. When its test processes
are no longer needed, `pnpm --silent dev:instance down --name smoke --json`
stops that instance, including its pane commands. Use an unused instance name
for disposable smoke work; commands with that name select the same durable
instance within this worktree.

## Docs and demo

- The website lives in `docs/`; `pnpm docs:build` builds it and runs every site
  check. Follow [the writing guide](docs/contributing/writing-guide.md) and keep
  [the product-truth ledger](docs/contributing/product-truth-ledger.md) current.
- `pnpm demo:tui` regenerates the animated demo from the production components;
  the docs build fails when it is out of date.
- `pnpm gallery:tui` opens real app components over fixture data, without
  touching your daemon or tmux sessions. See
  [the gallery guide](scripts/tui-gallery/README.md).

## Pull requests

- Keep behavior changes covered by tests.
- Update README and docs when the CLI contract changes.
- Keep `CHANGELOG.md` changes under `Unreleased` until the release is actually cut.
- Prefer focused PRs over large mixed changes.
- Run `pnpm check` before opening or updating a PR.
