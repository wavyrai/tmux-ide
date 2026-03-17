# tmux-ide — Claude Code Skill

tmux-ide turns any project into a tmux-powered terminal IDE using a simple `ide.yml` config file.

## When to use

- User mentions multi-pane, tmux, terminal IDE, or dev environment
- User wants to set up a development workspace
- User asks about running multiple terminals/tools side-by-side
- User wants to coordinate multiple Claude Code instances as a team
- User mentions agent teams, team lead, or multi-agent workflows

## Setup workflow

1. Check if `ide.yml` exists: `tmux-ide status --json`
2. Auto-detect the project: `tmux-ide detect --json`
3. **Present 2-3 layout options using ASCII diagrams** before writing config. Example:

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

   Adapt pane names/commands to the detected stack.

4. Once the user picks, write the config:
   - Quick: `tmux-ide detect --write` then modify
   - Or build custom with `tmux-ide config` subcommands

## Agent Teams workflow

Agent teams coordinate multiple Claude Code instances where a lead delegates tasks to teammates. Each gets its own tmux pane, and tmux-ide prepares that layout before Claude starts the actual team workflow.

### When to suggest agent teams

- User wants coordinated multi-agent development
- User mentions team lead, teammates, or task delegation
- User wants parallel work with inter-agent communication
- User's task benefits from specialized roles (e.g., frontend + backend + review)

### Prerequisites

Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. The tmux-ide install hook enables this in Claude Code settings, and tmux-ide also sets it automatically inside tmux sessions when `team` is configured in `ide.yml`.

### Setup from scratch

1. **Scaffold with agent team template:**

   ```bash
   tmux-ide init --template agent-team
   ```

2. **Or enable teams on an existing config:**

   ```bash
   tmux-ide config enable-team --name "my-team"
   ```

   This finds all `command: claude` panes and assigns the first as `lead`, the rest as `teammate`.

3. **Assign initial task hints to teammate panes:**

   ```bash
   tmux-ide config set rows.0.panes.1.task "Work on frontend components"
   tmux-ide config set rows.0.panes.2.task "Work on API routes"
   ```

4. **Validate and launch the layout:**

   ```bash
   tmux-ide validate --json
   tmux-ide
   ```

5. **Inside the lead pane, ask Claude to form the team:**

   ```text
   Start an agent team named my-team. Use the Frontend pane for components and the Backend pane for API routes.
   ```

### Present team layout options

When suggesting agent team layouts, show the roles and note that Claude will create the team after launch:

**Option A — Lead + 2 Teammates**

```
┌───────────┬───────────┬───────────┐
│           │           │           │
│   Lead    │Teammate 1 │Teammate 2 │  70%
│ (claude)  │ (claude)  │ (claude)  │
├───────────┴─────┬─────┴───────────┤
│   Dev Server    │     Shell       │  30%
└─────────────────┴─────────────────┘
```

**Option B — Lead + 3 Specialized Teammates**

```
┌────────┬────────┬────────┬────────┐
│        │Frontend│Backend │ Review │
│  Lead  │ Agent  │ Agent  │ Agent  │  70%
│        │        │        │        │
├────────┴────────┴──┬─────┴────────┤
│    Dev Server      │    Shell     │  30%
└────────────────────┴──────────────┘
```

### Team lead self-configuration

When running as the team lead inside a tmux-ide session, you can reconfigure the layout for the team:

```bash
# Read current config
tmux-ide config --json

# Add a new teammate pane
tmux-ide config add-pane --row 0 --title "Reviewer" --command "claude"
tmux-ide config set rows.0.panes.3.role teammate
tmux-ide config set rows.0.panes.3.task "Review all PRs and check for issues"

# Or remove a teammate
tmux-ide config remove-pane --row 0 --pane 2

# Validate and restart to apply
tmux-ide validate --json
tmux-ide restart
```

### Disable teams

```bash
tmux-ide config disable-team
```

Removes the `team` config and all `role`/`task` fields from panes.

## Session features (v1.2.0)

tmux-ide sessions include these built-in features:

### Mouse support

Mouse is enabled by default. Users can click to focus panes, scroll with trackpad, and drag pane borders to resize.

### Two-line status bar

```
Line 0:  MY-PROJECT IDE            ●            14:30 │ Mar 17
Line 1:  ⏺ Claude 1 │ ● Claude 2 │ ⏺ Dev Server │ Shell
```

- Line 0: session name, window indicators, time/date
- Line 1: clickable pane tabs (click to switch panes)
- Green `⏺` next to panes with a running dev server (listening TCP port)
- Pulsing `⏺` next to panes where Claude/Codex is actively working
- Dim `●` next to panes where Claude/Codex is idle

### Config drift detection

If `ide.yml` is edited while a session is running, `tmux-ide` warns the user and suggests `tmux-ide restart` to apply changes.

### Debugging

```bash
tmux-ide --verbose          # Log all tmux commands to stderr
TMUX_IDE_DEBUG=1 tmux-ide   # Same via env var
```

## Programmatic CLI

All commands support `--json` for structured output.

### Read commands

```bash
tmux-ide status --json      # Session status
tmux-ide validate --json    # Validate config
tmux-ide detect --json      # Detect project stack
tmux-ide config --json      # Dump config as JSON
tmux-ide ls --json          # List sessions
tmux-ide doctor --json      # System health check
```

### Write commands

```bash
tmux-ide detect --write                                    # Detect and write config
tmux-ide config set name "my-app"                          # Set config value by dot path
tmux-ide config set rows.0.size "70%"
tmux-ide config add-pane --row 0 --title "Claude" --command "claude"
tmux-ide config remove-pane --row 1 --pane 2
tmux-ide config add-row --size "30%"
tmux-ide config enable-team --name "my-team"               # Enable agent teams
tmux-ide config disable-team                               # Disable agent teams
```

### Session commands

```bash
tmux-ide              # Launch (or re-launch) IDE
tmux-ide stop         # Kill session
tmux-ide restart      # Stop and relaunch
tmux-ide attach       # Reattach
tmux-ide init         # Scaffold config
tmux-ide --verbose    # Launch with tmux command tracing
```

## Modification workflow

1. Read: `tmux-ide config --json`
2. Modify: `tmux-ide config set <path> <value>` or `add-pane`/`remove-pane`
3. Validate: `tmux-ide validate --json`
4. Apply: `tmux-ide restart` (needed if session is already running)

## Best practices

- Always use `--json` for programmatic access
- Always run `validate --json` after config mutations
- Top row ~70% height for Claude panes
- 2-3 Claude panes in the top row (or lead + 2 teammates for teams)
- Dev servers + shell in the bottom row
- Use `detect --json` first to understand the project stack
- For agent teams: assign specific tasks to teammate panes so your prompts stay focused
- The team lead should have `focus: true` for easy access
- Use `tmux-ide --verbose` or `TMUX_IDE_DEBUG=1` when debugging layout issues

## ide.yml format

```yaml
name: project-name
before: pnpm install # optional pre-launch hook
team: # optional agent team config
  name: my-team
rows:
  - size: 70%
    panes:
      - title: Lead
        command: claude
        role: lead # optional layout metadata: "lead" or "teammate"
        focus: true
      - title: Teammate 1
        command: claude
        role: teammate
        task: "Work on frontend" # suggested task text for your prompts
      - title: Teammate 2
        command: claude
        role: teammate
        task: "Work on backend"
  - panes:
      - title: Dev Server
        command: pnpm dev
        dir: apps/web # per-pane working directory
        env:
          PORT: 3000
      - title: Shell
theme:
  accent: colour75
  border: colour238
```
