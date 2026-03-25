# tmux-ide

A CLI tool that turns any project into a tmux-powered terminal IDE using a simple `ide.yml` config file.

## Quick Start

```bash
tmux-ide              # Launch IDE from ide.yml
tmux-ide init         # Scaffold ide.yml (auto-detects stack)
tmux-ide inspect      # Show resolved config + live tmux state
tmux-ide stop         # Kill session
tmux-ide attach       # Reattach to running session
```

## ide.yml Format

```yaml
name: project-name # tmux session name

before: pnpm install # optional pre-launch hook

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

team: # optional agent team config
  name: my-team

theme: # optional color overrides
  accent: colour75
  border: colour238
  bg: colour235
  fg: colour248
```

### Agent Team Pane Fields

```yaml
panes:
  - title: Lead
    command: claude
    role: lead # optional layout metadata: "lead" or "teammate"
    focus: true
  - title: Frontend
    command: claude
    role: teammate
    task: "Work on components" # suggested task text for your prompts
```

### Orchestrator Config

```yaml
orchestrator:
  enabled: true
  auto_dispatch: true # auto-assign tasks to idle agents
  dispatch_mode: tasks # "tasks" or "goals"
  poll_interval: 5000 # ms between ticks
  stall_timeout: 300000 # ms before nudging idle agent
  max_concurrent_agents: 10
  worktree_root: .worktrees/ # git worktree per task
  master_pane: Master # lead pane excluded from dispatch
  before_run: pnpm install # hook before task starts
  after_run: pnpm lint # hook after task completes
  cleanup_on_done: false # remove worktree after completion
  webhooks: # fire-and-forget event notifications
    - url: https://example.com/hook
      events: [completion, dispatch] # filter (omit = all events)
      secret: my-signing-key # HMAC-SHA256 via X-Signature-256
```

### Widget Pane Types

```yaml
panes:
  - title: War Room
    type: warroom # explorer | changes | preview | tasks | warroom | costs | config
  - title: Explorer
    type: explorer
    target: src/ # optional target path
```

## Architecture

The project is written in TypeScript. Source lives in `src/`, compiled output in `dist/`. Tests run via Node's `--experimental-strip-types`; the published package ships compiled JS from `tsc`.

### Core CLI

- `bin/cli.js` — CLI entry point and top-level error boundary (stays JS, imports from `dist/`)
- `src/launch.ts` — Launch orchestration for tmux sessions
- `src/restart.ts` — Stop + relaunch flow
- `src/init.ts` — Scaffolds ide.yml with smart detection
- `src/stop.ts` — Kills the tmux session
- `src/attach.ts` — Reattach to running session
- `src/send.ts` — Send messages to panes by name/title/role/ID
- `src/orchestrator-status.ts` — Orchestrator status display (agents, tasks, events)
- `src/config.ts` — Programmatic config mutations
- `src/task.ts` — Mission/goal/task CRUD commands
- `src/status.ts`, `src/inspect.ts`, `src/validate.ts`, `src/detect.ts`, `src/ls.ts`, `src/doctor.ts`

### Daemon & Process Lifecycle

- `src/lib/daemon.ts` — Unified background process: pane monitor + orchestrator + command-center HTTP server. Entry: `node dist/lib/daemon.js <session> [port]`
- `src/lib/daemon-watchdog.ts` — Crash recovery wrapper: respawns daemon on crash with exponential backoff (1s→30s cap, 5 crashes/60s limit). Zero business imports.
- `src/lib/session-monitor.ts` — Pure helper functions (computePortPanes, computeAgentStates) used by daemon.ts

### Orchestrator & Task System

- `src/lib/orchestrator.ts` — Autonomous task dispatch engine (dispatch, stall detection, completion, retry, reconciliation, hot reload)
- `src/lib/task-store.ts` — Mission/goal/task CRUD with JSON file persistence in `.tasks/` (atomic writes via temp+rename)
- `src/lib/event-log.ts` — Append-only event log with structured events and webhook integration
- `src/lib/webhook.ts` — Fire-and-forget webhook dispatcher with HMAC signing
- `src/lib/token-tracker.ts` — Agent time/cost accounting
- `src/lib/worktree.ts` — Git worktree creation per task (with orphan cleanup on startup)
- `src/lib/github-pr.ts` — Auto-PR creation on task completion

### Schemas

- `src/schemas/ide-config.ts` — Zod schemas for ide.yml (IdeConfig, Row, Pane, OrchestratorYamlConfig, WebhookConfig)
- `src/schemas/domain.ts` — Zod schemas for tasks, goals, events, panes, agent details

### Command Center (REST API + SSE + WebSocket)

- `src/command-center/server.ts` — Hono REST API with SSE event streaming
- `src/command-center/discovery.ts` — Session discovery, project detail, orchestrator snapshots
- `src/command-center/pane-mirror.ts` — WebSocket terminal mirroring (raw ANSI)
- `src/command-center/schemas.ts` — Request validation schemas

### Widgets (OpenTUI/Solid TUI)

- `src/widgets/resolve.ts` — Widget type → entry point resolution
- `src/widgets/lib/` — Shared: theme, pane-comms, watcher, git, files, config-model
- `src/widgets/explorer/` — File tree navigator
- `src/widgets/tasks/` — Task list/detail/form
- `src/widgets/warroom/` — Agent coordination dashboard
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

# Enable agent teams
tmux-ide config enable-team --name "my-team"

# Disable agent teams
tmux-ide config disable-team
```

### Pane Messaging

```bash
tmux-ide send <target> <message>        # Send message to pane by name/title/role/ID
tmux-ide send --to "Agent 1" <message>  # Target by --to flag
tmux-ide send <target> --no-enter msg   # Send text without pressing Enter
echo "msg" | tmux-ide send <target>     # Pipe from stdin
```

### Orchestrator

```bash
tmux-ide orchestrator [--json]    # Show orchestrator status (agents, tasks, events)
tmux-ide orch                     # Alias
```

### Settings TUI

```bash
tmux-ide settings                 # Interactive TUI config editor (tabs: Layout, Team, Orch, Theme)
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

1. Check if `ide.yml` exists: `tmux-ide status --json`
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

For coordinated multi-agent development:

1. `tmux-ide config enable-team --name "my-team"` or `tmux-ide init --template agent-team`
2. Assign tasks: `tmux-ide config set rows.0.panes.1.task "Work on frontend"`
3. Validate: `tmux-ide validate --json`
4. Launch: `tmux-ide` or `tmux-ide restart`
5. In the lead pane, ask Claude to create and organize the team in natural language

tmux-ide prepares the tmux layout and enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` when `team` is configured. It does not synthesize hidden Claude CLI flags for team creation.

The team lead can self-configure the workspace layout with `tmux-ide config ...`, then `restart` to apply changes.

## Contributor Workflow

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
pnpm pack:check
```

- Main release gate: `pnpm check`
- Live tmux coverage: `pnpm test:integration`
- Docs build: `pnpm docs:build`

### Best practices

- Always use `--json` for programmatic access
- Always run `validate --json` after config mutations
- Prefer `inspect --json` when debugging config/runtime mismatches
- Top row should be ~70% height for Claude panes
- 2-3 Claude panes in the top row (or lead + 2 teammate-ready panes for agent teams)
- Dev servers + shell in the bottom row
- Use `detect --json` first to understand the project stack
- For agent teams: assign specific tasks to teammate panes for focused parallel work

## Task Management

tmux-ide provides structured task management for coordinated multi-agent work.

### Mission & Goals

```bash
tmux-ide mission set "title" --description "..."   # Set the project mission
tmux-ide mission show                               # Show current mission
tmux-ide mission clear                              # Clear the mission

tmux-ide goal create "title" --priority N --acceptance "criteria"
tmux-ide goal list [--json]                         # List all goals
tmux-ide goal show <id> [--json]                    # Show goal with tasks
tmux-ide goal update <id> --status done
tmux-ide goal done <id>                             # Mark goal complete
tmux-ide goal delete <id>
```

### Tasks

```bash
tmux-ide task create "title" --goal NN --priority N --assign "Agent" --tags "a,b" --depends "001,002"
tmux-ide task list [--status todo --goal NN] [--json]
tmux-ide task show <id> [--json]                    # Full mission→goal→task context
tmux-ide task update <id> --status review --proof '{"tests":{"passed":10,"total":10}}'
tmux-ide task claim <id> --assign "Agent Name"      # Claim and start a task
tmux-ide task done <id> --proof "description"       # Mark task complete with proof
tmux-ide task delete <id>
```

### Proof Format

The `--proof` flag accepts either a plain string (stored as `notes`) or a JSON object:

```json
{
  "tests": { "passed": 10, "total": 10 },
  "pr": { "number": 42, "url": "https://...", "status": "merged" },
  "ci": { "status": "passing", "url": "https://..." },
  "notes": "Additional context"
}
```

### Task Dependencies

Use `--depends "001,002"` to declare that a task depends on other tasks. The orchestrator will not dispatch a task until all its dependencies are complete.

### Orchestrator Auto-Dispatch

When `orchestrator.enabled: true` and `auto_dispatch: true` in ide.yml, the orchestrator automatically:

1. Finds idle agent panes (not the master/lead pane)
2. Picks the highest-priority unblocked todo task
3. Creates a git worktree (`task/{id}-{slug}`)
4. Builds a single-line prompt with mission/goal/task context
5. Sends it to the idle agent via `tmux send-keys`
6. On completion (`tmux-ide task done <id> --proof "..."`): records time, creates PR, notifies master

**Usage flow:**

```bash
tmux-ide mission set "Ship v2" -d "description"
tmux-ide goal create "Auth system" -p 1 --acceptance "JWT + refresh tokens"
tmux-ide task create "Implement JWT" -g 01 -p 1 -d "detailed description"
tmux-ide task create "Add tests" -g 01 -p 2 --depends "001"
tmux-ide   # Launch — orchestrator auto-dispatches tasks to agents
tmux-ide orch   # Monitor progress
```

### Command Center API

```bash
tmux-ide command-center   # Start on port 4000

# REST endpoints:
# GET  /api/sessions                    — List all sessions
# GET  /api/project/:name               — Full project detail (tasks, agents, goals)
# GET  /api/project/:name/panes         — Live pane listing
# GET  /api/project/:name/events        — Recent orchestrator events
# POST /api/project/:name/task          — Create task
# POST /api/project/:name/task/:id      — Update task
# GET  /api/events                      — SSE stream (real-time updates)
# WS   /ws/mirror/:session/:paneId      — Terminal mirroring (raw ANSI)
```
