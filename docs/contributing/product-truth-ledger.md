# Product-truth ledger

The website documents what the current release actually ships. This ledger maps
every user-facing feature to the source that defines it, its status, and the
docs page that covers it. Update it in the same change that adds, retires or
quarantines a surface, and update the page it points to.

Baseline: `main` at 2.9.3.

## Status vocabulary

| Status          | Meaning                                                                                                                                           | How docs present it                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **shipped**     | Reachable in the default product and covered by tests.                                                                                            | Document as current behavior.                                               |
| **tmux chrome** | Shipped, but part of the tmux-native chrome added by `tmux-ide adopt` (`tui/chrome/`), not the 2.9 app. It runs inside plain tmux clients.        | Document under "tmux chrome" pages; never imply it appears inside the app.  |
| **quarantined** | Source exists but is deliberately kept out of navigation, bootstrap, input and reconnect (`runtime/product-surface-policy.ts`).                   | Do not present as available. Mention only to say it is not in this release. |
| **legacy**      | Older code path still in the tree but not used by the production app (e.g. `tui/mirror/input-lifecycle.ts`, `mirror/application-keybindings.ts`). | Never cite as truth.                                                        |
| **schema-only** | Accepted and validated by the workspace schema, but no runtime consumes it yet.                                                                   | Document as "validated, not used by the current app".                       |

Paths below are relative to `packages/daemon/src/` unless they start with
`packages/`, `bin/` or `docs/`.

## The app (`tmux-ide` / `tmux-ide app`)

Production entry: `tui/mirror/runtime/application-entry.ts` →
`application-root-v2.tsx`. Root surfaces come from `CATALOG_VIEWS` in
`runtime/application-shell-catalog.tsx` and `DEFAULT_PRODUCT_CANVAS_PANELS` in
`runtime/product-surface-policy.ts`.

| Feature                                                                                                                                                                                                        | Source                                                                                                                               | Status      | Docs page                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------- |
| Home (agents across machines, search, All/Working/Needs attention)                                                                                                                                             | `runtime/application-shell-home.tsx`, `workspace/application-action-descriptions.ts`                                                 | shipped     | app-surfaces, getting-started |
| Home quick actions, **Learn tmux-ide** guided tour                                                                                                                                                             | `runtime/application-shell-home.tsx`, `runtime/guided-tour*.ts`                                                                      | shipped     | app-surfaces                  |
| Home recent pane activity (attributed reads/sends)                                                                                                                                                             | `runtime/application-shell-home.tsx`, `runtime/application-pane-activity-owner.ts`                                                   | shipped     | app-surfaces, automation      |
| Terminals (live tmux mirror, window tabs, pane headers)                                                                                                                                                        | `runtime/application-terminal-workspace.tsx`                                                                                         | shipped     | app-surfaces                  |
| Pane action menu (right-click a pane): Select text, Rename R, Split → / D, Zoom Z, Close X                                                                                                                     | `workspace/pane-action-menu-model.ts`, `runtime/application-terminal-workspace.tsx`                                                  | shipped     | app-surfaces                  |
| Pane and agent names: manual rename > Claude teammate / agent name > meaningful title > program > generated `adjective-noun` fallback for plain panes; unnamed agents show their harness (Claude Code / Codex) | `packages/daemon/src/terminal/protocol/pane-display-name.ts`, `command-center/resources/application-shell.ts` (`resolvedAgentLabel`) | shipped     | app-surfaces                  |
| Commands palette (F5)                                                                                                                                                                                          | `runtime/application-palette-input.ts` (`BASE_COMMANDS`)                                                                             | shipped     | app-surfaces                  |
| Sessions switcher (F6) / Attention (F7)                                                                                                                                                                        | `runtime/application-machine-navigation.ts`, `runtime/application-fleet-switcher.tsx`                                                | shipped     | app-surfaces                  |
| Machine sidebar (F10), Add machine, SSH machines                                                                                                                                                               | `runtime/application-machine-sidebar.tsx`, `runtime/application-sidebar-shortcuts.ts`                                                | shipped     | app-surfaces                  |
| New agent… (named Claude Code / Codex agent)                                                                                                                                                                   | `runtime/application-new-agent-dialog.tsx`                                                                                           | shipped     | app-surfaces                  |
| Appearance… (System/Dark/Light + 22 presets, automatic contrast)                                                                                                                                               | `runtime/application-appearance-owner.ts`, `packages/contracts/src/visual-theme-presets.ts`                                          | shipped     | theming                       |
| Using tmux-ide (help), Keyboard shortcuts (Ctrl+K), What's new (Ctrl+B)                                                                                                                                        | `runtime/application-reference-sheet.tsx`, `workspace/application-shortcuts.ts`                                                      | shipped     | getting-started               |
| Selection, copy (OSC 52 / macOS clipboard), links                                                                                                                                                              | `runtime/terminal-links.ts`, `runtime/application-terminal-selection-owner.ts`                                                       | shipped     | app-surfaces                  |
| Detachable / hosted app (`--detachable`, `app.detachable`)                                                                                                                                                     | `bin/cli.ts`, `lib/app-config.ts`                                                                                                    | shipped     | commands, configuration       |
| **Files** surface / editor                                                                                                                                                                                     | `runtime/product-surface-policy.ts` (`QUARANTINED_PRODUCT_SURFACES`)                                                                 | quarantined | (not documented as current)   |
| **Diff / Changes** surface                                                                                                                                                                                     | same                                                                                                                                 | quarantined | (not documented as current)   |
| **Missions** surface                                                                                                                                                                                           | same                                                                                                                                 | quarantined | (not documented as current)   |
| **Activity** dock tool                                                                                                                                                                                         | same                                                                                                                                 | quarantined | (not documented as current)   |
| F12 performance HUD, Ctrl+P palette, Ctrl+E editor, F8/Ctrl+Tab composite focus                                                                                                                                | `tui/mirror/input-lifecycle.ts` — not wired into `application-root-v2.tsx`                                                           | legacy      | none                          |
| `tmux-ide web`                                                                                                                                                                                                 | `bin/cli.ts` (explicitly unavailable)                                                                                                | quarantined | commands                      |

### Canonical app keys

Truth: `workspace/application-shortcuts.ts`,
`workspace/application-action-descriptions.ts`,
`workspace/application-command-description.ts`, and the handlers in
`runtime/application-root-v2.tsx`, `runtime/application-shell-view.tsx`,
`runtime/application-machine-navigation.ts` (`handleFleetShortcut`),
`runtime/application-sidebar-shortcuts.ts`,
`runtime/application-terminal-interaction-controller.ts` (`routeWorkspaceKey`).
Do **not** use `tui/mirror/application-keybindings.ts` or
`tui/mirror/input-lifecycle.ts`.

| Key                              | Action                                                              | Context                   |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| `F1`                             | Home                                                                | anywhere                  |
| `F2`                             | Terminals                                                           | anywhere                  |
| `F5`                             | Commands                                                            | anywhere                  |
| `F6`                             | Sessions (switch session)                                           | anywhere                  |
| `F7`                             | Attention (sessions needing you)                                    | anywhere                  |
| `F8` / `Shift+F8`                | Back / forward through session history                              | anywhere                  |
| `F9` / `Shift+F9`                | Next / previous session tab                                         | anywhere                  |
| `F10`                            | Show / hide sidebar                                                 | anywhere                  |
| `Ctrl+G`                         | Focus sidebar (opens Sessions on Home or when hidden)               | anywhere                  |
| `Ctrl+Q`                         | Quit (detach when hosted)                                           | anywhere                  |
| `Ctrl+O`                         | Next pane                                                           | Terminals                 |
| `Ctrl+T`                         | Next window                                                         | Terminals                 |
| `Alt/Meta+Arrow`                 | Resize focused pane                                                 | Terminals                 |
| `Shift+click`                    | Open link (Ctrl/⌘+click also opens)                                 | Terminals                 |
| `Shift+drag`                     | Select text locally in a mouse-enabled app                          | Terminals                 |
| Right-click                      | Pane action menu                                                    | Terminals                 |
| `/` `f` `0` `w` `a` `Enter`      | Search, machine filter, All, Working, Needs attention, open         | Home                      |
| `N`                              | Create a local session (when none exist)                            | Home                      |
| `Tab`, `?` `R` `D` `A`           | Switch sections, Help, Retry, Disconnect, Add machine               | Sidebar focused           |
| `Ctrl+K`, `Ctrl+B`               | Keyboard shortcuts, What's new                                      | Commands / Sessions menus |
| `Ctrl+Space`                     | Toggle search / navigation mode (`j k g G i`)                       | menus                     |
| `Ctrl+H/F/P/E/N/X/R`, `Ctrl+←/→` | Hosts, favorite, preview, expand, new, close, retry, browse windows | Sessions                  |

## Workspace file (`.tmux-ide/workspace.yml`)

| Feature                                                                                                  | Source                                                       | Status      | Docs page     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------- | ------------- |
| `terminal.rows` / panes / `before` / theme                                                               | `packages/contracts/src/workspace-config.ts`                 | shipped     | configuration |
| Widget pane `type:` (explorer, changes, preview, config, sidebar) — programs that run inside a tmux pane | `widgets/resolve.ts`, `packages/contracts/src/ide-config.ts` | shipped     | configuration |
| `app.views` (home, terminals, files, diff, missions)                                                     | `packages/contracts/src/workspace-config.ts`                 | schema-only | configuration |
| `harnesses`, `agents`, `missions` blocks                                                                 | `packages/contracts/src/workspace-config.ts`                 | schema-only | configuration |
| Templates (`init --template`)                                                                            | `templates/`, `bin/cli.ts`                                   | shipped     | templates     |
| Legacy `ide.yml` + `migrate`                                                                             | `bin/cli.ts`                                                 | shipped     | configuration |

## Global config (`~/.tmux-ide/config.json`)

Truth: `lib/app-config.ts` (`AppConfig`, `DEFAULT_APP_CONFIG`). Override path:
`TMUX_IDE_CONFIG`. Sections: `keys` (tmux chrome only), `theme`
(`mode`, `preset`, `automaticContrast`, chrome tokens), `updater`,
`notifications` (`toast`, `macos`, `terminal`, `delaySeconds`, `sound`),
`restore`, `updates` (`check`, `manifests`), `welcome`, `integrations`,
`worktrees`, `app` (`frontDoor`, `detachable`, `dragSelect`, `newAgentCwd`,
`kittyKeys`). There is no `notifications.quietHours` and no in-app "settings"
palette group in 2.9.3. Docs page: configuration (reference section).

## tmux chrome (`tmux-ide adopt`)

Positioning: a **shipped, tmux-native companion** to the app for people who work
in plain tmux clients. It is not part of the 2.9 app's UI. Its background updater
(`_tmux-ide-chrome`, `tui/chrome/updater.ts`) also powers snapshots,
notifications and the event log. The updater starts on `adopt`; sessions and
agents created from the app also start it (`lib/fleet-lifecycle-authority.ts`).

| Feature                                                   | Source                                             | Status      | Docs page            |
| --------------------------------------------------------- | -------------------------------------------------- | ----------- | -------------------- |
| Status bar, fleet tabs, glyphs, pane chips, adopt/unadopt | `tui/chrome/statusline.ts`                         | tmux chrome | the-dock             |
| Prefix + Alt keys (h j k u b e g v)                       | `tui/chrome/statusline.ts` (`prefixKeyBinds`)      | tmux chrome | the-dock             |
| Actions menu, cheat sheet, switcher, sidebar, panels      | `tui/chrome/menu.ts`, `cheatsheet.ts`, `panels.ts` | tmux chrome | the-dock             |
| Home cockpit popup (`team` TUI)                           | `tui/team/`                                        | tmux chrome | the-dock             |
| Toasts, macOS/terminal banners, sound                     | `tui/chrome/notify.ts`, `updater.ts`               | tmux chrome | notifications-events |
| Event log (`events`)                                      | `tui/chrome/events.ts`                             | tmux chrome | notifications-events |
| Snapshots → `restore`                                     | `tui/chrome/snapshot.ts`, `restore.ts`             | tmux chrome | restore-resume       |

## CLI

| Feature                                               | Source                             | Status  | Docs page                                                    |
| ----------------------------------------------------- | ---------------------------------- | ------- | ------------------------------------------------------------ |
| Every command in `tmux-ide --help`                    | `bin/cli.ts` (`printHelp`)         | shipped | commands (enforced by `docs/scripts/check-product-docs.mjs`) |
| Agent detection, `agent explain`, integrations        | `tui/detect/`, `tui/integrations/` | shipped | agent-detection                                              |
| `send`, `wait`, `team --json`, `team assign`          | `bin/cli.ts`                       | shipped | multi-agent-teams                                            |
| `automation`, `mcp`, `@tmux-ide/sdk`                  | `bin/cli.ts`, `packages/sdk`       | shipped | automation                                                   |
| `worktree`                                            | `lib/worktree.ts`                  | shipped | worktrees                                                    |
| `machines`, `servers`, `--headless`, `daemon service` | `bin/cli.ts`                       | shipped | app-surfaces, commands                                       |
| Mission/task orchestration runtime                    | —                                  | future  | not documented as current                                    |

## Enforcement

`docs/scripts/check-product-docs.mjs` (run by `pnpm docs:build`) checks:

- `commands.mdx`, `templates.mdx` and the current release page name the package version;
- every public command in `tmux-ide --help` appears in `commands.mdx`;
- every implemented widget type appears in `configuration.mdx`;
- every workspace panel kind appears in `configuration.mdx`, which must state
  that the app does not read `app.views` while any kind is outside
  `DEFAULT_PRODUCT_CANVAS_PANELS`;
- `index.mdx` and `app-surfaces.mdx` name each default app surface;
- `getting-started.mdx` lists every `CHROME_ACTIONS` function key and none of
  the unbound legacy keys (`F3`, `F4`, `F11`, `F12`);
- `index.mdx` and `getting-started.mdx` never present a quarantined surface in bold;
- no page uses an unrendered `mermaid` block;
- every internal `/docs/...` link and `#anchor` resolves to an existing page and heading.
