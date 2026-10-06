# Changelog

All notable changes to this project will be documented in this file.

## 2.9.3

- Recover SSH connections after daemon replacement and apply saved-machine edits in the running app, with clearer connection errors and lifecycle logs.
- Preserve supervised daemon ownership through restart and update, including interrupted or failed launcher recovery.
- Repair managed-window resizing and reject conflicting linked-window control with actionable recovery guidance.
- Fix duplicate link-event handling, stale agent completion identity, and silent interaction-observer loss.
- Improve the managed installer, update, rollback, and uninstall paths, including failed-download preservation and prefixes containing spaces.
- Use https://tmux-ide.com as the canonical website and installation entry point.
- Remove the retired experimental React web client and contributor test files from the published runtime package.

Existing tmux sessions are preserved. Performance budgets remain unchanged; this release does not claim native performance parity. Physical terminal-emulator modifier handling remains a separate manual qualification item.

## 2.9.2

- Promote the terminal-first Home and Terminals experience to the stable channel.
- Require tmux 3.7 or newer for clients and running servers; bundle 3.7c and preserve older servers for explicit migration.
- Bring local and SSH-connected agents together with consistent names, team groups, and pane activity.
- Ship shared dialogs, command search, keyboard controls, light/dark themes, and optional automatic contrast correction enabled by default.
- Support scoped CLI/MCP pane reads and sends, with named interactions where attribution is verified. Raw tmux observation remains experimental and opt-in.
- Add a user-owned one-command installer with a private Node runtime, bundled tmux, verified TUI downloads, and staged upgrades.
- Package and qualify native tmux for macOS and Linux on ARM64/x64. Linux bundles use the Ubuntu 24.04 baseline.

This release covers Home and Terminals; experimental web and desktop surfaces remain outside the stable product scope. Existing tmux servers are preserved. Claude owns its team orchestration; in-process teammates are not separate panes. Performance qualification limits documented in beta.46 remain applicable.

## 2.9.0-beta.50

- Keep the resize guide visible throughout continuous drags while confirmed tmux layouts arrive.
- Avoid invalidating session inventory for geometry-only layout changes, reducing avoidable pauses during resizing.
- Preserve identity fences for membership, zoom, and structural changes.

## 2.9.0-beta.49

- Carry verified native Claude teammate names and team membership into Home and the sidebar through a read-only adapter.
- Add `team assign %PANE "Team name"` and `team unassign %PANE` for mixed-harness groups, with explicit tmux socket selection.
- Keep team members together in Home and the sidebar, share their team context labels, and include team names in Home search.
- Preserve manual pane names and explicit group assignments over discovered defaults. Grouped support terminals remain custom terminals.
- Keep memberships scoped to a machine/server and invalidate explicit assignments when the pane process is replaced.

Claude retains orchestration ownership. Logical leads and in-process teammates are not guessed into separate panes. Cross-machine team groups and a graphical team-management dialog are not included. Existing beta.46 platform qualification limits remain applicable.

## 2.9.0-beta.48

- Use cohesive agent names across pane headers, the sidebar, Home and agent details, while preserving explicit manual aliases.
- Recognize native Claude split-pane teammate names through read-only team metadata matched to the live pane process. Removed or unknown metadata falls back to normal pane naming.
- Add Commands → New agent… to create independently named Claude Code or Codex agents in the selected local or remote workspace.
- Keep agent names separate from changing activity and status labels.

Claude team naming does not create native teammates or implement cross-harness team orchestration. In-process teammates share their lead's terminal. Existing beta.46 platform qualification limits remain applicable.

## 2.9.0-beta.47

- Keep pane headers and Home indicators quiet while you type: unknown tmux command observations remain in activity history instead of displacing named interactions.
- Show one brief, attributed interaction between panes; repeated reads reuse the indicator and viewer or same-pane activity stays out of chrome.
- Resolve the invoking pane automatically for CLI and MCP reads/sends when `source` is omitted. Reservations return the resolved intent for safe, unchanged execution and retries; explicit `source: null` keeps the caller unidentified.
- Resolve reader names across sessions using scoped fleet identities, and reject stale source credentials instead of guessing an identity.
- Fix a stale bundled-tmux test mock uncovered by the full check.

External desktop clients without a verified tmux pane still remain unidentified; external-client registration is not included. Native observation remains opt-in, and the beta.46 platform qualification limits still apply.

## 2.9.0-beta.46

- Add a shared automation API for scoped pane discovery, reads, sends, operation status and interaction history, with CLI and stdio MCP adapters and a packageable SDK.
- Preserve server generations and pane lifetimes across multi-server activity, and correlate cooperative operations with observed evidence without duplicate interactions.
- Keep unknown actors, incomplete observation coverage and uncertain outcomes explicit; retries reuse operation handles rather than blindly resending input.
- Add opt-in native interaction observation with bounded metadata and batched drains. Native observation remains off by default and does not replace running tmux servers.
- Bundle matching terminal descriptions with native tmux and select them for managed launches, fixing attachment failures on machines without the original build host's terminfo database.

This beta prioritizes Apple Silicon and Linux ARM qualification. Intel Mac performance qualification remains incomplete; Linux Intel metadata-tail latency exceeded the original 50 ms target (about 55–58 ms). Spark's terminal-resource functional assertions passed, but its full fixture retains a process-exit observation failure; exact container cleanup was confirmed. Stock viewer input can appear as an unknown command observation, without identifying it as another agent's action.

## 2.9.0-beta.45

- Unify agent and interaction status presentation across pane headers, Home and the sidebar, with explicit unknown and unavailable states.
- Show pending reads and input separately from observed interactions; name verified actors and keep receipt details available without implying message comprehension.
- Share delayed, reduced-motion-aware interaction animation and preserve urgent agent states in compact rows.
- Add explicit Back to live and Restore controls for scrollback and expanded panes while preserving terminal geometry.
- Scope interaction feedback to its daemon and session, and isolate Details dialogs from terminal input.

## 2.9.0-beta.44

- Group agents across machines in one sidebar section, with shared rows and quiet machine/session context. Keep separate destinations for agents in the same session.
- Refresh Home with a flat agent list, search accent rail, Quick actions, and a dismissible tip. Compact layouts preserve agent navigation.
- Simplify Home/Terminals tabs with clearer shortcuts and stable attention spacing. Reuse shared input surfaces in dialogs.
- Keep unavailable agents explicit and prevent navigation to stale panes.

## 2.9.0-beta.41

- Working sessions appear above machine discovery, with shared two-line session rows, machine/server context, and consistent status icons. Tab switches sidebar keyboard sections.
- Background sessions show new results after an observed agent completion. Successful opening acknowledges the result; unavailable activity coverage remains explicit.
- Using tmux-ide is discoverable through Commands. Help, shortcuts and What's new form a reversible navigation cycle, with Home activity filters included in shortcut help.
- Add a development gallery of production components, shared design-contract checks, and updated contributor/native-dependency guidance.

## 2.9.0-beta.35

- F10 toggles the sidebar, with the shortcut shown in Commands and keyboard help.
- The footer Commands button has a distinct surface and high-contrast F5 keycap.
- Shift-click opens links on release; Shift-drag selects and copies without opening them. Ctrl-click remains supported.
- Direct Ghostty sessions request Shift mouse reporting while the TUI is active, without changing global settings.

## 2.9.0-beta.34

- Fix stale or duplicated-looking rows while scrolling Claude Code and other applications that split synchronized redraws across multiple output chunks. All changed rows are retained until the redraw is published.

## 2.9.0-beta.33

- Working agents now have animated indicators across Home, sidebars, and pane headers. Done, blocked, and idle agents have distinct static indicators alongside their status labels.
- Agent animations share one clock, stop for stale observations, and respect reduced motion. Terminal contents remain retained during animation.

## 2.9.0-beta.7

### OpenTUI beta

- The installable beta is intentionally cut to Home and Terminals: ordinary
  tmux discovery/control, pane and window chrome, and textual agent states.
  The web client and optional legacy/experimental surfaces are deferred.
- `tmux-ide app` now acquires a matching macOS/Linux OpenTUI runtime on first
  launch, verifies bounded downloads against version/platform/commit-bound
  SHA-256 manifests, and gives an actionable retry command on failure.
- Agent state is readable without color: `IDLE`, `WORKING`, `BLOCKED`, `DONE`,
  `FAILED`, and `UNKNOWN` appear in sidebar, window, and pane chrome.
- The minimal F5 command palette provides Home/Terminals navigation, pane
  splitting, and confirmed pane close. `Ctrl+O` cycles panes, `Ctrl+T` cycles
  windows, and hosted `Ctrl+Q` puts the app away without destroying it.
- Beta publication uses the npm `beta` dist-tag and leaves the stable Homebrew
  formula untouched. Stable releases retain their full gate and notifier.

### Changed

- Consolidated OpenTUI keyboard handling behind one root-owned ingress and semantic component router, removing the distributed listener pattern that could trigger MaxListeners warnings.
- Deleted the retired 9,000-line OpenTUI root and its parallel authority, terminal adapter, and workspace handoff implementations.
- Rebuilt the marketing and documentation surface around the actual 2.9 release cut. The non-shipping browser TUI demo and obsolete release-tour pages are no longer part of the site.
- Replaced the legacy `/tmp`-file performance taps with shared, demand-only OpenTUI and web HUD telemetry plus a deterministic multi-client SessionRuntime qualification gate.

### Fixed

- Global npm installs no longer mistake packaged `.tsx` files for a development checkout when Bun is present; every direct TUI surface now acquires and verifies the matching compiled runtime automatically.
- The npm payload now excludes development scripts, declarations, and OpenTUI build-only dependencies, reducing a clean install from 137 packages to 33 and removing its deprecated Glob warning and reported production vulnerabilities.
- The legacy `tmux-ide server` compatibility surface is explicitly deprecated and restricted to loopback instead of listening on every network interface.
- Terminal window tabs and the add-window button now own their OpenTUI mouse input directly, switch through each window's canonical activation pane, and show immediate optimistic selection while daemon-owned tmux state reconciles.
- Standalone TUI binaries now embed OpenTUI's Tree-sitter worker and WebAssembly runtime, so `tmux-ide show` renders Markdown without leaking `/$bunfs/root/parser.worker.ts` errors into terminal panes.
- Chrome-updater pane snapshots now skip raw shells and carry short-lived, one-use daemon-owner proofs, preventing tmux-ide's own two-second status scan from producing permanent READ chrome or competing with terminal input; genuine external and agent reads remain visible.

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
