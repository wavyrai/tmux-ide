# Contributing

## Setup

Requirements:

- Node.js 18 or newer
- Bun 1.0 or newer
- pnpm 10 or newer
- tmux 3.0 or newer for manual CLI smoke tests

Install dependencies:

```bash
pnpm install --frozen-lockfile
npm link
```

`npm link` is optional, but it is the easiest way to exercise the locally checked-out CLI as `tmux-ide`.

## Development Workflow

Main commands:

```bash
pnpm test
pnpm docs:build
pnpm check
```

`pnpm check` is the default pre-push command. It runs the CLI test suite, builds the docs site, and verifies the package can be packed cleanly.

`npm publish` is guarded by `prepublishOnly`, so a publish attempt runs the same full check path automatically.

## Testing Notes

- `npm test` runs the Node test suite.
- `pnpm test:integration` exercises live tmux behavior and is skipped automatically when tmux is unavailable.
- `pnpm docs:build` validates the docs app production build.

For a manual tmux smoke test:

```bash
bun bin/cli.ts init
bun bin/cli.ts inspect --json
tmux-ide
```

Then in another shell:

```bash
tmux-ide status --json
tmux-ide stop --json
```

Run the launch step from a real interactive terminal. In headless or restricted PTYs, tmux can still create the session but the attach step may fail with terminal capability errors such as `open terminal failed: terminal does not support clear`.

## Pull Requests

- Keep behavior changes covered by tests.
- Update README and docs when the CLI contract changes.
- Keep `CHANGELOG.md` changes under `Unreleased` until the release is actually cut.
- Prefer focused PRs over large mixed changes.
- Run `pnpm check` before opening or updating a PR.
