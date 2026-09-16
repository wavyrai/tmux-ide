# Contributing

## Setup

Requirements:

- Node.js 20 or newer
- pnpm 10 or newer
- tmux 3.0 or newer for manual CLI smoke tests

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

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
