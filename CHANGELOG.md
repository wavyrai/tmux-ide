# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 2.7.0

The unified app release: `tmux-ide app` is now a real terminal IDE over your fleet — panes feel native, agents are visible at a glance, and you can start it anywhere.

### Added

- **The unified app** (`tmux-ide app [session]`) — a full-screen IDE via tmux control mode: tmux keeps owning PTYs/layout/persistence, the app renders. Surfaces: Home cockpit, live Terminal, native file editor (^s/^z, click-cursor), diff viewer, command palette (F5)
- **Start it anywhere** — `tmux-ide app` works from any folder with no tmux server running; the home screen greets first-run users with a plain-language welcome and **Open folder…**: a real filesystem picker that opens your project in a terminal workspace, with optional "remember as project" and layout setup. Recently opened folders one click away. The optional `app.frontDoor` config flag makes bare `tmux-ide` launch the app
- **Agents at a glance** — a sidebar agents section lists every agent across your fleet (blocked first) and clicking one jumps straight to its pane; agent panes wear a status chip ("● claude", blocked shows bold red with age); the focused pane gets an accent hairline border; `team --json` now carries per-pane agent entries
- **Settings without JSON** — every setting is a palette command (F5 → "settings"): accent theme with live preview, notifications with quiet hours, update cadence, crash restore, a keybinding viewer, and a guarded reset. Changes persist atomically and say where they land
- **Select & copy inside agent panes** — right-click → "Select text…" (or shift+drag where your terminal passes it) pauses mouse forwarding so you can select and copy from claude/vim/htop panes; wheel scrolls history while selecting
- **Size honesty with co-attached terminals** — when another terminal sizes the shared window, the app centers the view and says so; palette → "Resize to fit this window" reclaims it, and detaching always leaves your other terminal's size intact
- **Mouse-native everywhere** — hover feedback, right-click context menus (pane/window/session verbs, layouts, synchronize-panes), border-drag resize, drag-select with SSH-transparent OSC52 copy, scrollbars, clickable buttons
- **Mouse-complete navigation** — the palette is fully mouse-driven (hover, wheel, click-to-run, click-outside dismiss); the home screen launches registered projects and creates named sessions by click; every sidebar/tab-bar affordance is clickable, keyboard twins preserved
- **Scrollback search** (`/`), paste-buffer picker, zoom fast-paths, pane ops and layout presets
- **Hardware cursor** — the focused pane drives the real terminal cursor: shape, blink, and hide/show follow the application (vim/claude behave natively); unfocused panes show a quiet marker
- **Per-platform TUI release binaries** with download-on-demand, so the app runs without a dev checkout
- Notification polish: dedupe, quiet hours, richer banners
- Agent-detection breadth: 6 more screen manifests, detection confidence surfaced
- Perf harness (`scripts/perf-mirror.mjs`) with env-gated taps measuring the full input→echo→paint path

### Changed

- **~20× faster pane rendering** — pane content blits xterm cell data straight into framebuffer typed arrays, incrementally: only changed rows repaint (an exact shadow compare, no hashes), scrolls take a shift fast path, quiet panes cost zero. Opt out one release with `TMUX_IDE_FB_PANES=0`
- **Input latency tail cut ~65%** — keystrokes are fire-and-forget and coalesced instead of awaiting a control-mode reply per key; parser writes are ack-paced so floods never stall input
- Paste is chunked at the measured tmux parser sweet spot (256B): 100KB pastes land byte-perfect in ~0.3s
- Scrollback seeding on attach deepened 300 → 2000 lines
- OpenTUI 0.1.88 → 0.4.3
- Blink attribute passes through to the host terminal

### Fixed

- Clicking the Files tab no longer starts a phantom sidebar drag (tab-bar row excluded from the boundary-drag check)
- A lone keystroke echo can no longer miss its paint frame (dirty state re-arms when bytes are parsed, not when they're queued)
- Seed content mojibake: latin1 reply bytes were fed to the VT parser as text
- npm installs get the full TUI (sources shipped, workspaces linked)

## 2.1.3

### Added

- **Full workspace scaffolding** — `tmux-ide init` now creates library stubs (architecture.md, learnings.md), validation contract template, and AGENTS.md for all agent-team and missions templates
- **Launch-time scaffolding** — `ensureTaskDocs()` creates library and validation stubs on first orchestrator launch for projects set up before this fix
- **Expanded lead agent prompt** — milestones, validation contracts, knowledge library, and `--fulfills` flag now included in the master agent startup prompt
- **General-worker skill fallback** — agents without a specific skill now receive the general-worker role context in dispatch prompts
- **Post-completion flow in skills** — all skills now explain what happens after task done (orchestrator notification, hooks, auto-dispatch)
- **Validation awareness in worker skills** — frontend and backend skills now reference the validation contract and knowledge library

### Fixed

- **Orphaned daemon cleanup** — `stop` and `launch` now kill ALL daemon processes for the session (by name matching), preventing zombie processes from holding the port
- **Daemon health check timeout** — `waitForDaemon()` fetch calls now have explicit 1s timeout to prevent indefinite blocking
- **Activity feed noise** — heartbeat events filtered from dashboard activity feed
- **Activity feed time column** — widened from 8ch to 10ch for readability

### Removed

- **Raw idle notifications** — monitor loop no longer sends `Agent "X" is now idle` to the Lead; orchestrator completion handler provides better context

## 2.1.0

### Added

- **Unified startup** — dashboard served from command center as pre-built static export; single process, single port
- **Daemon health-check gate** — launch polls `/health` before attaching to verify daemon is ready
- **Service recovery on re-attach** — dead daemons auto-restarted when re-attaching to existing sessions
- **Multi-session port sharing** — subsequent sessions detect and reuse an existing command center instead of failing silently
- **Static file middleware** — Hono serves dashboard with SPA fallback, MIME types, and immutable cache headers for hashed assets
- **Dashboard ships with npm** — `dashboard/out/` included in package via `prepublishOnly` build step

### Removed

- **Separate dashboard process** — `startDashboard()`, `stopDashboard()`, dashboard PID tracking all removed
- **`pnpm dev` runtime dependency** — dashboard no longer requires Next.js dev server at runtime

### Fixed

- **Flaky orchestrator tests** — `isAtAgentPrompt()` now uses mockable `captureLastLine()` instead of direct `execFileSync("tmux")` which leaked host tmux state into tests

## 2.0.0

### Added

- **Mission lifecycle** — autonomous pipeline: planning → active → validating → complete
- **Milestones** — sequential execution phases with automatic gating and progression
- **Validation contracts** — assertion-based verification with independent validator dispatch
- **Auto-remediation** — failed assertions auto-create remediation tasks
- **Skill-based dispatch** — match task specialty to agent capabilities via findBestAgent()
- **Rich dispatch prompts** — mission/milestone/AGENTS.md/skill/library context injection
- **Knowledge library** — auto-appended learnings, architecture docs, tag-matched references
- **Researcher agent** — continuous internal auditing with configurable triggers
- **Metrics engine** — session/task/agent/mission telemetry with timeline sampling
- **Metrics CLI** — `tmux-ide metrics`, `metrics agents`, `metrics eval`, `metrics history`
- **Web dashboard metrics panel** — KPIs, milestone timeline, agent utilization, validation
- **Coverage invariant** — assertion coverage enforcement with `validate coverage` command
- **Built-in skills** — 5 templates (general-worker, frontend, backend, reviewer, researcher)
- **Blocked assertion status** — assertions can be marked blocked with blockedBy reason
- **File-based send** — long messages written to dispatch files to avoid paste-mode
- **Dispatch file cleanup** — stale files removed on daemon startup
- **Services registry** — centralized commands/ports/healthchecks in ide.yml
- **Mission-level PR** — auto-creates PR on mission completion via createMissionPr()
- **Agent idle notifications** — master pane notified on busy→idle transitions
- **CLI commands** — mission create/plan-complete/status, milestone CRUD, validate assert/coverage, skill list/show/create/validate, research status/trigger, metrics subcommands
- **Command center API** — milestones, validation, skills, mission, metrics endpoints
- **Agent detection** — prefix matching for codex (codex-aarch64-a etc.)
- **Event types** — milestone_validating, milestone_complete, validation_dispatch, remediation, validation_failed, planning, mission_complete, discovered_issue, research_dispatch, research_finding, agent_heartbeat, session_start, session_end

### Changed

- `dispatch_mode` now accepts `"missions"` in addition to `"tasks"` and `"goals"`
- `buildTaskPrompt()` generates structured multi-section prompts with markdown headers
- `buildGoalPrompt()` includes milestone context and AGENTS.md
- `checkMilestoneCompletion()` routes through validation when contract exists
- `detectCompletions()` includes durationMs and structured handoff (salientSummary, discoveredIssues)
- `loadSkills()` merges project and personal (~/.tmux-ide/skills/) directories
- `init` scaffolds skills directory and AGENTS.md template for missions mode
- `inspect` output includes skills, pane→skill mapping, and unresolved references
- `doctor` checks pane skill references

### Removed

- **Git worktree isolation** — agents work in the project directory
- `task.branch` field removed from Task interface
- `worktree_root` and `cleanup_on_done` config options removed
- `src/lib/worktree.ts` and its tests deleted

### Fixed

- Unified slugify (consistent 40-char limit)
- Goal prompt newlines preserved
- Theme customization in widget createTheme()
- Config mutation validation (Zod re-validation after mutations)
- Dependency cycle detection in task creation
- PR creation failures surfaced in JSON output
- Event type enums aligned between domain schema and event-log
- PaneInfoSchemaZ role enum matches ide-config PaneSchema
- Library write failures wrapped in try-catch (don't crash task completion)
- Stale task.branch references removed from dashboard and TUI widgets

## 1.1.0

### Added

- `inspect` command for resolved config and runtime state
- detection reasoning in human and JSON output
- targeted CLI hardening tests for error handling and edge cases
- docs build validation in the release workflow
- contributor, release, and security project documentation

### Changed

- centralized tmux session state handling for several lifecycle commands
- improved config mutation validation and error reporting
- tightened npm packaging and CI coverage
- limited Claude integration postinstall changes to global installs with existing Claude config

### Fixed

- `inspect` now reports invalid config state instead of crashing on malformed pane arrays
- `restart --json` now preserves structured launch errors
- launch logic now uses returned tmux pane IDs instead of assuming sequential numbering
