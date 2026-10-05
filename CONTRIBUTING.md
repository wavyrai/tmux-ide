# Contributing

## Setup

Requirements:

- A supported Node.js runtime (see `package.json`); use the same executable and ABI for installation, builds and tests
- The pnpm version pinned in `packageManager` and Bun version in `.bun-version`
- Native compiler prerequisites and the pinned, patched tmux bundle for TUI and installed-runtime checks (see the worktree guide below)

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

## Development Workflow

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

## Testing Notes

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

For a manual tmux smoke test:

```bash
node bin/cli.js init
node bin/cli.js inspect --json
node bin/cli.js
```

Then in another shell:

```bash
node bin/cli.js status --json
node bin/cli.js stop --json
```

## Pull Requests

- Keep behavior changes covered by tests.
- Update README and docs when the CLI contract changes.
- Keep `CHANGELOG.md` changes under `Unreleased` until the release is actually cut.
- Prefer focused PRs over large mixed changes.
- Run `pnpm check` before opening or updating a PR.
