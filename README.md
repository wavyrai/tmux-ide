# tmux-ide

[![CI](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml)

Turn any project into a tmux-powered terminal IDE with a simple `ide.yml` config file.

## Install

Prerequisites:

- `tmux` >= 3.0
- `Node.js` >= 18
- `bun` on your `PATH` (`tmux-ide` is published with a `#!/usr/bin/env bun` entrypoint)

On macOS:

```bash
brew install tmux bun
```

Then install `tmux-ide`:

```bash
npm install -g tmux-ide
```

Or run it with `npx` without a global install:

```bash
npx tmux-ide --version
```

`npx` still requires `bun` to be installed locally because it executes the same published CLI entrypoint.

Global install also registers the bundled Claude Code skill and enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json` if Claude Code is installed locally on the machine.

## Quick Start

```bash
tmux-ide init         # Scaffold ide.yml (auto-detects your stack)
tmux-ide doctor       # Check tmux + runtime prerequisites in this project
tmux-ide              # Launch the IDE
tmux-ide stop         # Kill the session
tmux-ide restart      # Stop and relaunch
tmux-ide attach       # Reattach to a running session
tmux-ide inspect      # Inspect effective config + runtime state
```

`tmux-ide init` writes both `ide.yml` and built-in role files under `.tmux-ide/skills/`.

The default scaffold includes panes that run `claude`. If Claude Code is not installed on the machine, edit `ide.yml` before the first `tmux-ide` launch and replace or remove those commands.

## ide.yml Format

```yaml
name: project-name # tmux session name

before: pnpm install # optional pre-launch hook

rows:
  - size: 70% # row height percentage
    panes:
      - title: Editor # pane border label
        command: vim # command to run (optional)
        size: 60% # pane width percentage (optional)
        dir: apps/web # per-pane working directory (optional)
        focus: true # initial focus (optional)
        env: # environment variables (optional)
          PORT: 3000
      - title: Shell

  - panes:
      - title: Dev Server
        command: pnpm dev
      - title: Tests
        command: pnpm test

theme: # optional color overrides
  accent: colour75
  border: colour238
  bg: colour235
  fg: colour248
```

## Commands

| Command                                            | Description                             |
| -------------------------------------------------- | --------------------------------------- |
| `tmux-ide`                                         | Launch IDE from `ide.yml`               |
| `tmux-ide <path>`                                  | Launch from a specific directory        |
| `tmux-ide init [--template <name>]`                | Scaffold a new `ide.yml`                |
| `tmux-ide stop`                                    | Kill the current IDE session            |
| `tmux-ide restart`                                 | Stop and relaunch the IDE session       |
| `tmux-ide attach`                                  | Reattach to a running session           |
| `tmux-ide ls`                                      | List all tmux sessions                  |
| `tmux-ide status`                                  | Show session status                     |
| `tmux-ide inspect`                                 | Show effective config and runtime state |
| `tmux-ide doctor`                                  | Check system requirements               |
| `tmux-ide validate`                                | Validate `ide.yml`                      |
| `tmux-ide detect`                                  | Detect project stack and explain why    |
| `tmux-ide detect --write`                          | Detect and write `ide.yml`              |
| `tmux-ide config`                                  | Dump config as JSON                     |
| `tmux-ide config set <path> <value>`               | Set a config value                      |
| `tmux-ide config add-pane --row <N>`               | Add a pane to a row                     |
| `tmux-ide config remove-pane --row <N> --pane <M>` | Remove a pane                           |
| `tmux-ide config add-row [--size <percent>]`       | Add a new row                           |
| `tmux-ide config enable-team --name <name>`        | Enable agent teams                      |
| `tmux-ide config disable-team`                     | Disable agent teams                     |

All commands support `--json` for structured output.

`tmux-ide detect` now includes reasoning about the package manager, language, framework, and dev-command signals it used. `tmux-ide inspect` combines config validation, resolved layout details, and live tmux state in one command.

## Templates

Use `tmux-ide init --template <name>` with one of:

- `default` - General-purpose layout
- `nextjs` - Next.js development
- `convex` - Convex + Next.js
- `vite` - Vite project
- `python` - Python development
- `go` - Go development
- `agent-team` - Agent team with lead + teammates
- `agent-team-nextjs` - Agent team for Next.js
- `agent-team-monorepo` - Agent team for monorepos

## Contributor Workflow

The repo now uses a pnpm workspace with a root CLI package and a separate docs app package:

```bash
pnpm install
pnpm test
pnpm docs:build
pnpm check
pnpm pack:check
```

`pnpm check` is the intended local pre-push command and matches the default release checklist. `npm publish` is still guarded by `prepublishOnly`, so publishing runs the same full check path automatically.

## CI

GitHub Actions validates:

- the Node CLI test suite on Node 18, 20, and 22
- the docs site production build
- the package can be packed successfully with `npm pack --dry-run`

That keeps the release surface small but catches the main regressions for a CLI-first package.

## Open Source Project Files

- [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and contribution workflow
- [RELEASE.md](RELEASE.md) for the publish checklist
- [CHANGELOG.md](CHANGELOG.md) for release notes
- [SECURITY.md](SECURITY.md) for vulnerability reporting

Release note convention:

- Keep the next version under an `Unreleased` heading in `CHANGELOG.md` until the tag is cut.
- Move it to a dated release entry when the release is actually published.

## Requirements

- **tmux** >= 3.0
- **Node.js** >= 18
- **Bun** on your `PATH`

## License

[MIT](LICENSE)
