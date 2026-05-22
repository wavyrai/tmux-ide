# Widget index

Catalog of every widget in tmux-ide. The split mirrors [ARCHITECTURE.md §3](../ARCHITECTURE.md#§3--package-map): two widget ecosystems coexist by design and are **NOT duplicates** — same names, different runtimes.

|                      | Solid DOM widgets                                                                    | Daemon TUI widgets                                                           |
| -------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Path                 | `packages/v2-solid-widgets/src/widgets/<Name>.tsx`                                   | `packages/daemon/src/widgets/<name>/`                                        |
| Surface              | Browser at `localhost:3000` (Solid SPA)                                              | Tmux pane (OpenTUI)                                                          |
| Mount                | `mount(domNode, opts) → handle`                                                      | `tmux-ide widget <name>` (spawns Bun)                                        |
| Wired from           | `dashboard/src/components/*-bridge.tsx`, `dashboard/src/routes/v2/widget/[name].tsx` | `bin/cli.ts` (`tmux-ide config`, `tmux-ide setup`) + `ide.yml` `type:` field |
| Runtime              | Solid signals (`createSignal`/`createStore`/`createResource`); Effect at boundaries  | OpenTUI / Solid-TUI under Node or Bun                                        |
| Talks to daemon over | HTTP `/api/v2/action/:name` + WS `/ws/events`                                        | Same daemon contracts, plus argv (`--session`, `--dir`)                      |

Don't merge them — same name, different runtime.

For the full per-concern reference table (which upstream codebase informs us per widget family, where we diverge), see [ARCHITECTURE.md §5](../ARCHITECTURE.md#§5--per-concern-reference--divergence).

## Daemon TUI widgets (8)

Spawned via `ide.yml` `type:` field or `tmux-ide widget <name>`. Each lives at `packages/daemon/src/widgets/<name>/` and reads `--session` + `--dir` from argv. Each directory carries a `README.md` that points back at this row and at [ARCHITECTURE.md §3](../ARCHITECTURE.md#§3--package-map).

| Name              | Path                                           | Purpose                                      |
| ----------------- | ---------------------------------------------- | -------------------------------------------- |
| `changes`         | `packages/daemon/src/widgets/changes/`         | Git diff viewer for the working tree         |
| `config`          | `packages/daemon/src/widgets/config/`          | Interactive ide.yml editor (config tree TUI) |
| `costs`           | `packages/daemon/src/widgets/costs/`           | Token + cost tracking per agent / per thread |
| `explorer`        | `packages/daemon/src/widgets/explorer/`        | File tree navigator                          |
| `mission-control` | `packages/daemon/src/widgets/mission-control/` | Agent + task + event dashboard               |
| `preview`         | `packages/daemon/src/widgets/preview/`         | File content preview                         |
| `setup`           | `packages/daemon/src/widgets/setup/`           | Project setup wizard                         |
| `tasks`           | `packages/daemon/src/widgets/tasks/`           | Task list / detail / form                    |

**Embed surface:** `/v2/widget/[name]` mounts a daemon TUI widget in a web Terminal via `fetchWidgetSpawn` + xterm bridge.

## Solid DOM widgets (14)

Each Solid widget exports `mount(node, opts) → handle` per the convention in [ARCHITECTURE.md §6 — Solid widgets (DOM)](../ARCHITECTURE.md#§6--conventions). The package collects them under one directory; `packages/v2-solid-widgets/src/widgets/README.md` indexes them and links back to this table.

| Name                      | Path                                                 | Bridge                                            | Surface                                                             | Status                 |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- | ---------------------- |
| `Activity`                | `packages/v2-solid-widgets/src/widgets/Activity.tsx` | `dashboard/components/activity-bridge.tsx`        | Event timeline                                                      | shipped                |
| `Changes`                 | `Changes.tsx`                                        | —                                                 | Diff stats                                                          | shipped                |
| `CommandPalette`          | `CommandPalette.tsx`                                 | `dashboard/components/command-palette-bridge.tsx` | Cmd+K unified search (providers / skills / tasks / threads / views) | shipped                |
| `Costs`                   | `Costs.tsx`                                          | `dashboard/components/costs-bridge.tsx`           | Token + cost metrics                                                | shipped                |
| `CostsDashboard`          | `CostsDashboard.tsx`                                 | —                                                 | Richer cost composite                                               | exists, may be unwired |
| `DiffsViewer`             | `DiffsViewer.tsx`                                    | `dashboard/components/diffs-viewer-bridge.tsx`    | File diffs + hunk navigation                                        | shipped                |
| `Explorer`                | `Explorer.tsx`                                       | `dashboard/components/explorer-bridge.tsx`        | File tree                                                           | shipped                |
| `ExplorerDashboard`       | `ExplorerDashboard.tsx`                              | —                                                 | Richer explorer composite                                           | exists, may be unwired |
| `Inspector`               | `Inspector.tsx`                                      | `dashboard/components/inspector-bridge.tsx`       | Right-rail event stream (current scope)                             | shipped                |
| `KanbanBoard`             | `KanbanBoard.tsx`                                    | `dashboard/components/kanban-board-bridge.tsx`    | Task kanban w/ status columns                                       | shipped                |
| `MissionControlDashboard` | `MissionControlDashboard.tsx`                        | —                                                 | Richer mission composite                                            | exists, may be unwired |
| `PlansPanel`              | `PlansPanel.tsx`                                     | `dashboard/components/plans-panel-bridge.tsx`     | Plan body editor                                                    | shipped                |
| `PlansRail`               | `PlansRail.tsx`                                      | `dashboard/components/plans-rail-bridge.tsx`      | Plan list rail                                                      | shipped                |
| `SkillsView`              | `SkillsView.tsx`                                     | `dashboard/components/skills-view-bridge.tsx`     | Project skills rail + body                                          | shipped                |
| `TasksView`               | `TasksView.tsx`                                      | `dashboard/components/tasks-view-bridge.tsx`      | Filterable task list                                                | shipped                |

> Earlier revisions of this index listed a separate `MissionControl` (composite) row alongside `MissionControlDashboard`. Only `MissionControlDashboard.tsx` is on disk — the bridged composite has been folded into the dashboard route shell. Treat the dashboard variant as the live one.

## Chat surface (`chat-solid` package — composite, not a single widget)

Per [ARCHITECTURE.md §3](../ARCHITECTURE.md#§3--package-map), `chat-solid` is a reusable Solid surface (not a v2-solid-widget). `packages/chat-solid/src/components/`:

- `ChatHeader`, `ChatThreadView`, `ChatComposer`, `MessagesTimeline` (+ `.logic.ts`)
- `MessageCopyButton`, `MessageRoleHeader`, `ToolCallCard`, `PlanCard`, `AttachmentChip`, `AttachmentPicker`
- `ProviderModelPicker`, `ProviderStatusBanner`, `ThreadErrorBanner`
- `ComposerBannerStack`, `ComposerPendingApprovalPanel`, `ComposerPlanFollowUpBanner`, `ComposerCommandMenu`, `ComposerMentionMenu`
- `ExpandedImageDialog`, `ExpandedImagePreview`, `TerminalContextInlineChip`, `ContextWindowMeter`, `PermissionDialog`, `WorkingIndicator`, `ChangedFilesTree`

Mounted via `mount(container, opts)` from `@tmux-ide/chat-solid`. Consumed by the dashboard chat surface.

## Gallery surface (proposed `/v2/widgets`)

A grid/tile view at `dashboard/src/routes/v2/widgets/page.tsx` should:

- Render each Solid widget in a tile (~280×200 px) with live preview
- Render each daemon TUI widget in a small embedded Terminal tile
- Click a tile → fullscreen / pop out
- Filter by category (DOM / TUI / Composite)
- Search by name / description

Each tile shows: name, description (1-line), category badge, optional "shipped/orphan" status.
