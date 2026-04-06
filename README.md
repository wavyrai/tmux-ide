# tmux-ide

[![CI](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml)

Turn any project into a tmux-powered terminal IDE or autonomous multi-agent workspace with a simple `ide.yml` config file.

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

## Two Modes

- **Classic mode**: define panes in `ide.yml`, launch dev servers and shells, and manage the tmux session with `attach`, `restart`, `inspect`, and `status`.
- **Missions mode**: run an orchestrated multi-agent workspace with a lead, specialist teammates, milestone gating, validation contracts, a knowledge library, researcher audits, and a live dashboard.

## Quick Start

### Classic Mode

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

### Missions Mode

```bash
tmux-ide init --template missions
tmux-ide mission create "Build auth system" -d "JWT + refresh tokens"
tmux-ide
```

The `missions` template scaffolds:

- `ide.yml` with an orchestrator-enabled team layout
- `.tmux-ide/skills/` with built-in specialist roles
- `.tmux-ide/library/` for architecture notes and learnings
- `.tasks/validation-contract.md` for assertion-based verification
- `AGENTS.md` for project boundaries and conventions

Useful follow-up commands:

```bash
tmux-ide mission status       # Milestones, tasks, and validation progress
tmux-ide metrics              # Session and agent telemetry
tmux-ide validate coverage    # Check assertion coverage gaps
tmux-ide orchestrator         # Orchestrator state
```

The missions layout also starts the dashboard / command center, which by default is served at `http://localhost:6060`.

If you prefer guided setup over editing YAML directly, use:

```bash
tmux-ide setup
tmux-ide settings
```

## ide.yml Format

Classic pane layout:

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

Additional fields for agent teams and missions:

```yaml
team:
  name: missions

rows:
  - size: 70%
    panes:
      - title: Lead
        command: claude
        role: lead
      - title: Frontend
        command: claude
        role: teammate
        specialty: frontend
      - title: Validator
        command: claude
        role: validator
        skill: reviewer

orchestrator:
  enabled: true
  auto_dispatch: true
  dispatch_mode: missions
  poll_interval: 5000
  stall_timeout: 300000
  master_pane: Lead
```

Advanced config supports:

- `team` metadata to enable Claude Code agent teams in the tmux session
- per-pane `role`, `task`, `skill`, and `specialty` fields for dispatch-aware layouts
- an `orchestrator` block for autonomous dispatch, services, research triggers, and webhooks
- `.tmux-ide/skills/` and `.tmux-ide/library/` as project-local skill and knowledge sources

## Commands

### Session Lifecycle

- `tmux-ide` / `tmux-ide <path>`: launch from `ide.yml`
- `tmux-ide init [--template <name>]`: scaffold a config
- `tmux-ide attach`, `stop`, `restart`, `ls`, `status`, `inspect`
- `tmux-ide doctor`: check runtime prerequisites
- `tmux-ide detect [--write]`: infer a layout from the current project

### Setup and Config

- `tmux-ide setup`: interactive TUI setup wizard
- `tmux-ide settings`: interactive TUI config manager
- `tmux-ide config`: dump config as JSON
- `tmux-ide config set <path> <value>`: set a config value
- `tmux-ide config add-pane --row <N> --title <T> [--command <C>]`
- `tmux-ide config remove-pane --row <N> --pane <M>`
- `tmux-ide config add-row [--size <percent>]`
- `tmux-ide config enable-team [--name <name>]`
- `tmux-ide config disable-team`
- `tmux-ide config edit`: open the config tree editor

### Missions, Goals, and Tasks

- `tmux-ide mission`: create, show, clear, and advance the current mission lifecycle
- `tmux-ide milestone`: manage sequential execution phases
- `tmux-ide goal`: manage goals and their acceptance criteria
- `tmux-ide task`: create, claim, complete, update, delete, and inspect tasks
- `tmux-ide plan`: inspect planning state
- `tmux-ide research`: inspect or manually trigger researcher audits

### Validation, Skills, and Metrics

- `tmux-ide validate`: validate `ide.yml` or manage validation contract state
- `tmux-ide validate show|assert|report|coverage`
- `tmux-ide skill list|show|create|validate`
- `tmux-ide metrics`, `metrics agents`, `metrics timeline`, `metrics eval`, `metrics history`

### Messaging and Orchestration

- `tmux-ide send <target> <message>`: send a message to a pane by title, name, role, or pane ID
- `tmux-ide dispatch <task-id>`: print task context for dispatch
- `tmux-ide notify <message>`: send a notification to the lead pane
- `tmux-ide orchestrator` / `tmux-ide orch`: show orchestrator state
- `tmux-ide command-center --port <port>`: run the standalone command-center server

### Remote and Networking

- `tmux-ide tunnel start|stop|status|url`: expose a local session
- `tmux-ide remote register|machines|status`: register and inspect remote machine state

All commands support `--json` for structured output.

For the full command reference, see [docs/content/docs/commands.mdx](docs/content/docs/commands.mdx). For programmatic workflows, see [docs/content/docs/programmatic.mdx](docs/content/docs/programmatic.mdx).

## Templates

Use `tmux-ide init --template <name>` with one of:

- `default` - General-purpose layout
- `missions` - Full autonomous workflow with orchestrator, validator, researcher, and dashboard
- `nextjs` - Next.js development
- `convex` - Convex + Next.js
- `vite` - Vite project
- `python` - Python development
- `go` - Go development
- `agent-team` - Agent team with lead + teammates
- `agent-team-nextjs` - Agent team for Next.js
- `agent-team-monorepo` - Agent team for monorepos

## Docs

- [docs/content/docs/getting-started.mdx](docs/content/docs/getting-started.mdx) for first-run setup
- [docs/content/docs/configuration.mdx](docs/content/docs/configuration.mdx) for the full `ide.yml` reference
- [docs/content/docs/templates.mdx](docs/content/docs/templates.mdx) for template walkthroughs
- [docs/content/docs/agent-teams.mdx](docs/content/docs/agent-teams.mdx) for lead / teammate and missions concepts
- [docs/content/docs/missions-workflow.mdx](docs/content/docs/missions-workflow.mdx) for the full mission lifecycle
- [docs/content/docs/commands.mdx](docs/content/docs/commands.mdx) for the full CLI reference

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
