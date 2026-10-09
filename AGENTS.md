# tmux-ide

A visual, agent-aware IDE for ordinary tmux sessions. `.tmux-ide/workspace.yml`
is an optional declarative layout preset.

## Quick Start

```bash
tmux-ide              # Visual tmux app; configless by default
tmux-ide app [session] # Explicit app entry; optionally open a live session
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

The project file is optional: the app discovers and manages ordinary live tmux
sessions without one. Legacy `ide.yml` files are still supported through a compatibility adapter. Use
`tmux-ide migrate --dry-run` to preview conversion and `tmux-ide migrate --write`
to create `.tmux-ide/workspace.yml`.

WorkspaceConfigV1 can declare `harnesses`, `agents`, and `missions` data, but
mission runtime wiring is future work. Do not add legacy `team`, pane
`role`/`task`, `sidebar`, or `orchestrator` fields to `.tmux-ide/workspace.yml`.

### Widget Pane Types

```yaml
panes:
  - title: Explorer
    type: explorer # explorer | changes | preview | config | sidebar
    target: src/ # optional target path
```

## Architecture

This TypeScript monorepo uses pnpm and Turbo. The terminal CLI/daemon is the
current npm release surface; the former web and desktop applications are retired. See `ARCHITECTURE.md` for import direction and
`eslint.config.js` for enforced package boundaries.

### CLI and daemon

- `bin/cli.ts` — CLI source; `scripts/build-cli.mjs` bundles it into `bin/cli.js`.
  Edit source rather than generated output.
- `packages/daemon/src/` — CLI operations (`launch.ts`, `init.ts`, `stop.ts`,
  `attach.ts`, `send.ts`, `config.ts`, `inspect.ts`) and daemon implementation.
- `packages/daemon/src/lib/canonical-daemon.ts` and
  `packages/daemon/src/lib/canonical-daemon-bootstrap.ts` — canonical ownership,
  discovery and bootstrap. Use the supported CLI rather than launching internal
  daemon modules directly.
- `packages/daemon/src/command-center/` — HTTP/WebSocket APIs and resource/action
  handlers; `server.ts` composes the server.
- `packages/daemon/src/terminal/` — tmux mirroring, canonical session runtime,
  terminal delivery and native-grid integration.
- `packages/daemon/src/schemas/` — daemon-local schemas and legacy config support.
- `packages/daemon/dist/` — compiled daemon output shipped with the root package.

### Contracts and shared packages

- `packages/contracts/` — shared wire schemas, resource vocabulary and visual tokens.
- `packages/core/` — renderer-neutral application models.
- `packages/daemon-client/` — client connections, resource replication and workspace clients.
- `packages/presentation/` — shared renderer-neutral presentation models.
- `packages/sdk/` — typed host-neutral SDK built from shared contracts.
- `packages/tmux-bridge/` — tmux bridge package.

### User interfaces

- `packages/daemon/src/tui/mirror/` — production OpenTUI/Solid Home and Terminals
  UI; `runtime/` owns application integration, `ui/` shared primitives,
  `workspace/` workspace presentation, and `features/` optional feature modules.
- `packages/daemon/src/widgets/` — explorer, changes, preview, config, setup and
  sidebar widgets; `resolve.ts` resolves entries and `lib/` holds shared helpers.
- The former Solid desktop renderer and Electron shell have been retired; a replacement is not yet shipped.
- Do not add an external or closed-source canvas SDK to the core, TUI or web GUI.

### Development, native inputs and documentation

- `docs/guides/development-worktrees.md` — isolated `pnpm dev:instance` workflow;
  keep development daemons/tmux servers separate from production sessions.
- `patches/README.md` — dependency/native maintenance inventory and upgrade proofs.
- `native/tmux/provenance.json` — bundled tmux source and patch identity.
- `scripts/` — build, installed-package, live testdrive and qualification tools.
- `templates/` — workspace presets; `docs/content/docs/` — user-facing docs.
- `.github/workflows/ci.yml` — contributor CI; `release-binaries.yml` and
  `release.yml` in the same directory own runtime and npm publication.

Tests use package-specific Vitest, Bun and Node runners. Use the scripts in
`package.json` and the affected package instead of assuming one universal runner.

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

- Broad contributor gate: `pnpm check`
- Terminal release gate: `pnpm release:opentui:check`; follow `RELEASE.md`.
  `prepublishOnly` runs this focused gate and the prepublish artifact check,
  not the broad contributor gate. Web/desktop checks remain independent signals.
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
