# tmux-ide

A CLI tool that turns any project into a tmux-powered terminal IDE using `.tmux-ide/workspace.yml`.

## Quick Start

```bash
tmux-ide              # Launch IDE from .tmux-ide/workspace.yml, or compatible ide.yml
tmux-ide init         # Scaffold .tmux-ide/workspace.yml (auto-detects stack)
tmux-ide inspect      # Show resolved config + live tmux state
tmux-ide stop         # Kill session
tmux-ide attach       # Reattach to running session
```

## .tmux-ide/workspace.yml Format

```yaml
version: 1
name: project-name # tmux session name

before: pnpm install # optional pre-launch hook

terminal:
  theme: # optional color overrides
    accent: colour75
    border: colour238
    bg: colour235
    fg: colour248
  rows:
    - size: 70% # row height percentage
      panes:
        - title: Claude 1 # pane border label
          command: claude # command to run (optional)
          size: 50% # pane width percentage (optional)
          dir: apps/web # per-pane working directory (optional)
          focus: true # initial focus (optional)
          env: # environment variables (optional)
            PORT: 3000

    - panes:
        - title: Dev Server
          command: pnpm dev
        - title: Shell
```

Legacy `ide.yml` files are still supported through a compatibility adapter. Use
`tmux-ide migrate --dry-run` to preview conversion and `tmux-ide migrate --write`
to create `.tmux-ide/workspace.yml`.

WorkspaceConfigV1 can declare `harnesses`, `agents`, and `missions` data, but
mission runtime wiring is future work. Do not add legacy `team`, pane
`role`/`task`, `sidebar`, or `orchestrator` fields to `.tmux-ide/workspace.yml`.

### Widget Pane Types

```yaml
panes:
  - title: Explorer
    type: explorer # explorer | changes | preview | setup | config | sidebar
    target: src/ # optional target path
```

## Architecture

The project is written in TypeScript. Source lives in `src/`, compiled output in `dist/`. Tests run via Node's `--experimental-strip-types`; the published package ships compiled JS from `tsc`.

### Core CLI

- `bin/cli.js` — CLI entry point and top-level error boundary (stays JS, imports from `dist/`)
- `src/launch.ts` — Launch orchestration for tmux sessions
- `src/restart.ts` — Stop + relaunch flow
- `src/init.ts` — Scaffolds `.tmux-ide/workspace.yml` with smart detection
- `src/stop.ts` — Kills the tmux session
- `src/attach.ts` — Reattach to running session
- `src/send.ts` — Send messages to panes by name/title/role/ID
- `src/config.ts` — Programmatic config mutations
- `src/status.ts`, `src/inspect.ts`, `src/validate.ts`, `src/detect.ts`, `src/ls.ts`, `src/doctor.ts`

### Daemon & Process Lifecycle

- `src/lib/daemon.ts` — Unified background process: pane monitor + command-center HTTP server. Entry: `node dist/lib/daemon.js <session> [port]`
- `src/lib/daemon-watchdog.ts` — Crash recovery wrapper: respawns daemon on crash with exponential backoff (1s→30s cap, 5 crashes/60s limit). Zero business imports.
- `src/lib/session-monitor.ts` — Pure helper functions (computePortPanes, computeAgentStates) used by daemon.ts

### Schemas

- `src/schemas/ide-config.ts` — Zod schemas for legacy `ide.yml` compatibility
- `src/schemas/domain.ts` — Zod schemas for runtime events, panes, and agent details

### Command Center (REST API + SSE + WebSocket)

- `src/command-center/server.ts` — Hono REST API with SSE event streaming
- `src/command-center/discovery.ts` — Session discovery and project detail
- `src/command-center/pane-mirror.ts` — WebSocket terminal mirroring (raw ANSI)
- `src/command-center/schemas.ts` — Request validation schemas

### Widgets (OpenTUI/Solid TUI)

- `src/widgets/resolve.ts` — Widget type → entry point resolution
- `src/widgets/lib/` — Shared: theme, pane-comms, watcher, git, files, config-model
- `src/widgets/explorer/` — File tree navigator
- `src/widgets/costs/` — Token/cost tracking
- `src/widgets/changes/` — Git diff viewer
- `src/widgets/preview/` — File preview
- `src/widgets/config/` — Interactive TUI config editor
- `src/widgets/setup/` — Setup wizard

### Native macOS App (in development)

- `app/` — Swift/SwiftUI native gateway app with Ghostty terminal embedding
- `app/project.yml` — XcodeGen build config
- `app/TmuxIde/` — App source (services, models, UI, terminal bridge)
- Consumes command-center REST/SSE/WebSocket APIs
- Infinite canvas UI (workspace > columns > tiles)

### Other

- `src/lib/tmux.ts` — Shared tmux process helpers
- `src/lib/yaml-io.ts` — Config read/write
- `src/lib/errors.ts` — Error class hierarchy
- `templates/` — Preset configs
- `docs/content/docs/` — User-facing docs site
- `.github/workflows/ci.yml` — CI quality gates

## Programmatic CLI Reference

All commands support `--json` for structured output.

### Read Commands

```bash
# Session status
tmux-ide status --json
# → { "session": "...", "running": true, "configExists": true, "panes": [...] }

# Validate config
tmux-ide validate --json
# → { "valid": true, "errors": [] }

# Detect project stack
tmux-ide detect --json
# → { "detected": { "packageManager": "pnpm", "frameworks": ["next", "convex"], ... }, "suggestedConfig": {...} }

# Dump config as JSON
tmux-ide config --json
# → { "name": "...", "rows": [...] }

# List sessions
tmux-ide ls --json
# → { "sessions": [{ "name": "...", "created": "...", "attached": true }] }

# System check
tmux-ide doctor --json
# → { "ok": true, "checks": [...] }

# Inspect resolved config + live tmux data
tmux-ide inspect --json
# → { "valid": true, "session": "...", "resolved": {...}, "tmux": {...} }
```

### Write Commands

```bash
# Detect and write config
tmux-ide detect --write

# Set a config value by dot path
tmux-ide config set name "my-app"
tmux-ide config set rows.0.size "70%"
tmux-ide config set rows.1.panes.0.command "npm run dev"

# Add a pane to a row
tmux-ide config add-pane --row 1 --title "Tests" --command "pnpm test"

# Remove a pane
tmux-ide config remove-pane --row 1 --pane 2

# Add a new row
tmux-ide config add-row --size "30%"

```

### Pane Messaging

```bash
tmux-ide send <target> <message>        # Send message to pane by name/title/role/ID
tmux-ide send --to "Agent 1" <message>  # Target by --to flag
tmux-ide send <target> --no-enter msg   # Send text without pressing Enter
echo "msg" | tmux-ide send <target>     # Pipe from stdin
```

### Orchestrator

The historical orchestrator/task runtime is not a current surface. Treat mission
runtime wiring as future work.

### Settings TUI

```bash
tmux-ide settings                 # Interactive TUI config editor
```

### Session Commands

```bash
tmux-ide              # Launch (or re-launch) IDE
tmux-ide stop         # Kill session
tmux-ide attach       # Reattach
tmux-ide init         # Scaffold config (auto-detects stack)
tmux-ide init --template nextjs  # Use specific template
```

### Command Center

```bash
tmux-ide command-center [--port 4000]   # Start REST API + SSE + WebSocket server
```

## Claude Skill

### When to suggest tmux-ide

- User mentions multi-pane, tmux, terminal IDE, dev environment
- User wants to set up a development workspace
- User asks about running multiple terminals/tools side-by-side
- User wants coordinated multi-agent development (agent teams)
- User mentions team lead, teammates, or task delegation

### Setup workflow

1. Check config state: `tmux-ide status --json`
2. Auto-detect the project: `tmux-ide detect --json`
3. **Present 2-3 layout options to the user using ASCII diagrams** before writing any config. Show the pane arrangement visually so the user can pick or tweak. Example:

   **Option A — Dual Claude + Dev (recommended)**

   ```
   ┌─────────────────┬─────────────────┐
   │                 │                 │
   │    Claude 1     │    Claude 2     │  70%
   │                 │                 │
   ├────────┬────────┴────────┬────────┤
   │Dev Srv │  Tests  │ Shell │        │  30%
   └────────┴─────────┴───────┘────────┘
   ```

   **Option B — Triple Claude**

   ```
   ┌───────────┬───────────┬───────────┐
   │           │           │           │
   │ Claude 1  │ Claude 2  │ Claude 3  │  70%
   │           │           │           │
   ├───────────┴─────┬─────┴───────────┤
   │    Dev Server    │     Shell       │  30%
   └─────────────────┴─────────────────┘
   ```

   **Option C — Single Claude + wide dev**

   ```
   ┌─────────────────────────────────────┐
   │             Claude                  │  60%
   ├──────────┬──────────┬──────────────┤
   │ Dev Srv  │  Tests   │    Shell     │  40%
   └──────────┴──────────┴──────────────┘
   ```

   Adapt pane names/commands to the detected stack (e.g., `pnpm dev`, `cargo watch`, `go run`). Always tailor the options to the project.

4. Once the user picks an option, write the config:
   - Quick path: `tmux-ide detect --write` then modify as needed
   - Or build custom:
     ```bash
     tmux-ide config add-row --size "70%"
     tmux-ide config add-pane --row 0 --title "Claude 1" --command "claude"
     tmux-ide config add-pane --row 0 --title "Claude 2" --command "claude"
     tmux-ide config add-row
     tmux-ide config add-pane --row 1 --title "Dev" --command "pnpm dev"
     tmux-ide config add-pane --row 1 --title "Shell"
     tmux-ide validate --json
     ```

### Modification workflow

1. Read current config: `tmux-ide config --json`
2. Modify: `tmux-ide config set <path> <value>` or `add-pane`/`remove-pane`
3. Validate: `tmux-ide validate --json`

### Agent Teams workflow

Use multi-pane workspace layouts for agent teams. Legacy `team`, pane
`role`/`task`, and orchestrator runtime wiring are not current workspace config
surfaces.

## Contributor Workflow

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
pnpm pack:check
```

- Main release gate: `pnpm check`
- Docs build: `pnpm docs:build`

### Best practices

- Always use `--json` for programmatic access
- Always run `validate --json` after config mutations
- Prefer `inspect --json` when debugging config/runtime mismatches
- Top row should be ~70% height for Claude panes
- 2-3 Claude panes in the top row (or lead + 2 teammate-ready panes for agent teams)
- Dev servers + shell in the bottom row
- Use `detect --json` first to understand the project stack
- Mission runtime wiring is future work; avoid documenting legacy pane task metadata as current.

### Command Center API

```bash
tmux-ide command-center   # Start on port 4000

# REST endpoints:
# GET  /api/sessions                    — List all sessions
# GET  /api/project/:name               — Full project detail
# GET  /api/project/:name/panes         — Live pane listing
# GET  /api/events                      — SSE stream (real-time updates)
# WS   /ws/mirror/:session/:paneId      — Terminal mirroring (raw ANSI)
```
