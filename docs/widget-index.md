# Widget index

Comprehensive catalog of every widget in tmux-ide. Two categories:

- **Daemon TUI widgets** — render in OpenTUI inside tmux panes. Spawned via `ide.yml` `type:` field or `tmux-ide widget <name>`. Each lives at `packages/daemon/src/widgets/<name>/`.
- **Solid DOM widgets** — render in the dashboard via Solid signals. Each lives at `packages/v2-solid-widgets/src/widgets/<name>.tsx` with a thin React bridge in `dashboard/components/`.

## Daemon TUI widgets (8)

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

## Solid DOM widgets (16)

| Name                      | Path                                                 | Bridge                                            | Surface                                                             | Status                    |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| `Activity`                | `packages/v2-solid-widgets/src/widgets/Activity.tsx` | `dashboard/components/activity-bridge.tsx`        | Event timeline                                                      | ✅ shipped                |
| `Changes`                 | `Changes.tsx`                                        | —                                                 | Diff stats                                                          | ✅ shipped                |
| `CommandPalette`          | `CommandPalette.tsx`                                 | `dashboard/components/command-palette-bridge.tsx` | Cmd+K unified search (providers / skills / tasks / threads / views) | ✅ shipped                |
| `Costs`                   | `Costs.tsx`                                          | `dashboard/components/costs-bridge.tsx`           | Token + cost metrics                                                | ✅ shipped                |
| `CostsDashboard`          | `CostsDashboard.tsx`                                 | —                                                 | Richer cost composite                                               | ⚠️ exists, may be unwired |
| `DiffsViewer`             | `DiffsViewer.tsx`                                    | `dashboard/components/diffs-viewer-bridge.tsx`    | File diffs + hunk navigation                                        | ✅ shipped                |
| `Explorer`                | `Explorer.tsx`                                       | `dashboard/components/explorer-bridge.tsx`        | File tree                                                           | ✅ shipped                |
| `ExplorerDashboard`       | `ExplorerDashboard.tsx`                              | —                                                 | Richer explorer composite                                           | ⚠️ exists, may be unwired |
| `Inspector`               | `Inspector.tsx`                                      | `dashboard/components/inspector-bridge.tsx`       | Right-rail event stream (current scope)                             | ✅ shipped                |
| `KanbanBoard`             | `KanbanBoard.tsx`                                    | `dashboard/components/kanban-board-bridge.tsx`    | Task kanban w/ status columns                                       | ✅ shipped                |
| `MissionControl`          | `MissionControl.tsx`                                 | `dashboard/components/mission-control-bridge.tsx` | Agents + tasks + events composite                                   | ✅ shipped                |
| `MissionControlDashboard` | `MissionControlDashboard.tsx`                        | —                                                 | Richer mission composite                                            | ⚠️ exists, may be unwired |
| `PlansPanel`              | `PlansPanel.tsx`                                     | `dashboard/components/plans-panel-bridge.tsx`     | Plan body editor                                                    | ✅ shipped                |
| `PlansRail`               | `PlansRail.tsx`                                      | `dashboard/components/plans-rail-bridge.tsx`      | Plan list rail                                                      | ✅ shipped                |
| `SkillsView`              | `SkillsView.tsx`                                     | `dashboard/components/skills-view-bridge.tsx`     | Project skills rail + body                                          | ✅ shipped                |
| `TasksView`               | `TasksView.tsx`                                      | `dashboard/components/tasks-view-bridge.tsx`      | Filterable task list                                                | ✅ shipped                |

## Chat surface (chat-solid package — composite, not a single widget)

`packages/chat-solid/src/components/`:

- `ChatHeader`, `ChatThreadView`, `ChatComposer`, `MessagesTimeline` (+ `.logic.ts`)
- `MessageCopyButton`, `MessageRoleHeader`, `ToolCallCard`, `PlanCard`, `AttachmentChip`, `AttachmentPicker`
- `ProviderModelPicker`, `ProviderStatusBanner`, `ThreadErrorBanner`
- `ComposerBannerStack`, `ComposerPendingApprovalPanel`, `ComposerPlanFollowUpBanner`, `ComposerCommandMenu`, `ComposerMentionMenu`
- `ExpandedImageDialog`, `ExpandedImagePreview`, `TerminalContextInlineChip`, `ContextWindowMeter`, `PermissionDialog`, `WorkingIndicator`, `ChangedFilesTree`

Mounted via `mount(container, opts)` from `@tmux-ide/chat-solid`. Currently consumed by:

- Dashboard chat surface (in migration from React → chat-solid mount — see commit history)

## Gallery surface (proposed `/v2/widgets`)

A grid/tile view at `dashboard/app/v2/widgets/page.tsx` should:

- Render each Solid widget in a tile (~280×200 px) with live preview
- Render each daemon TUI widget in a small embedded Terminal tile
- Click a tile → fullscreen / pop out
- Filter by category (DOM / TUI / Composite)
- Search by name / description

Each tile shows: name, description (1-line), category badge, optional "shipped/orphan" status.
