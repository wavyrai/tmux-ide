# tmux-ide

**The terminal that understands your agents.** tmux-ide is a terminal-native IDE and agent cockpit built _around_ tmux: one command adds a native chrome (the dock) to any existing tmux session — fleet tabs with live agent-status glyphs, ground-truth working/blocked/done detection, notifications when an agent needs you, and crash-proof restore that revives whole fleets including Claude conversations. Nothing to migrate into, nothing to lock into: the chrome is tmux options; `unadopt` reverts; if tmux-ide dies your sessions are ordinary tmux.

Positioning: other tools rebuild the terminal to understand agents; tmux-ide teaches the terminal you already use to understand them. Never reference competitor projects by name in code, comments, commits, or docs.

## Quick start

```bash
tmux-ide adopt <session>            # add the dock to a session you already have
tmux-ide integration install claude # ground-truth agent status via Claude Code hooks (+ skill sync)
tmux-ide                            # home screen (fleet cockpit) — or launches ide.yml if present
tmux-ide restore --resume-agents    # after a tmux server death: rebuild everything, revive claudes
```

## Keys & surfaces (prefix-first)

The PRIMARY key form is the tmux prefix + letter — it survives every keyboard protocol. The ⌥ twins are a fast path that dies while a focused app (e.g. Claude Code) switches the terminal's key encoding (kitty protocol); kitty-encoded user-keys fallbacks are registered but coverage varies by terminal.

| Action                                                                              | Reliable               | Fast path          |
| ----------------------------------------------------------------------------------- | ---------------------- | ------------------ |
| Home cockpit (fleet tree + detail popup)                                            | `prefix h`             | `⌥h`               |
| Switcher popup                                                                      | `prefix j`             | `⌥p`               |
| Cheat sheet                                                                         | `prefix k`             | `⌥k`               |
| Actions menu (also: right-click anywhere — opens at the pointer, on button RELEASE) | `prefix u`             | `⌥m`               |
| Sidebar (fleet nav column)                                                          | `prefix b`             | `⌥b`               |
| Panels: explorer / git changes / config                                             | `prefix e` / `g` / `v` | `⌥e` / `⌥g` / `⌥,` |

All keys configurable via `~/.tmux-ide/config.json` (`keys.*`); re-adopt applies changes. Letters were chosen to never clobber tmux prefix defaults (hence menu=u, switcher=j, config=v).

## The agent contract (two-layer detection)

1. **Authority** (ground truth): lifecycle hooks stamp pane-local options. `tmux-ide integration install claude` wires Claude Code's hooks (UserPromptSubmit/PreToolUse→working, Notification→blocked, Stop→done, SessionEnd→idle; also records `@agent_session_id` — the `claude --resume` key restore uses). ANY agent can self-report the same way, no integration needed:
   ```bash
   tmux set-option -p @agent_state "working:$(date +%s)"   # working|blocked|done|idle
   ```
   Staleness guard: working/blocked older than 10 min fall back to scraping.
2. **Fallback** (scraping): process-tree resolution (pane_pid → the real agent, not `node`) → evidence-tuned screen manifests (claude/codex tuned from real captures; opencode/gemini/aider/copilot conservative). User overrides in `~/.tmux-ide/agent-detection/*.json`; per-pane `@agent_hint <id>` forces a manifest. Debug any pane: `tmux-ide agent explain <pane|session>`.

## CLI surface (everything supports --json)

- Fleet: `team --json` · `events [--follow]` · `wait agent-status <s> --status <x>` · `wait output <pane> --match <re>` · `send <target> <msg>` · `agent explain <pane>`
- Chrome: `adopt <s>` / `adopt --all` / `unadopt <s>` · `statusline` · `menu` · `cheatsheet` · `sidebar-toggle` · `popup <widget>` · `welcome`
- Lifecycle: `restore [--dry-run] [--run-commands] [--resume-agents]` · `worktree create|open|list|remove <branch>` · `update [--dry-run]` · `skill-sync` · `integration install|uninstall|status claude` · `doctor`
- Projects: launch (bare `tmux-ide`), `init`, `stop`, `restart`, `attach`, `ls`, `status`, `inspect`, `validate`, `detect [--write]`, `config` (get/set/add-pane/…)
- A de-emphasized task system still exists (`tmux-ide task --help`); it is not the product's pitch.

## ide.yml (optional — adopt works without it)

```yaml
name: my-project
sidebar: true # inject the fleet nav column (or { width: "30" })
before: pnpm install
rows:
  - size: 70%
    panes:
      - { title: Editor, command: claude, focus: true, size: 50% }
      - { title: Shell }
  - panes:
      - { title: Changes, type: changes } # widget panes: explorer|changes|preview|config|sidebar
      - { title: Dev, command: pnpm dev, dir: apps/web, env: { PORT: "3000" } }
```

Always `tmux-ide validate --json` after config mutations. When helping a user design a layout, present 2–3 ASCII-diagram options first (see skill/SKILL.md).

## Architecture (monorepo)

- `bin/cli.ts` → esbuild-bundled to `bin/cli.js` (`pnpm build`, scripts/build-cli.mjs). The published bin. All command cases live here.
- `packages/daemon/src/`
  - `tui/chrome/` — the dock: statusline (bar builder, adopt/unadopt, ALL key/mouse binds incl. prefix twins + kitty user-keys fallbacks + LEGACY_BINDS cleanup), updater (the `_tmux-ide-chrome` background tick: status vars, chips, events, notifications, snapshots, update checks), menu, cheatsheet, panels, sidebar, chip, notify, events, snapshot, welcome, kitty-keys.
  - `tui/detect/` — two-layer detection: classify (authority parse + tracker), process-tree, manifest(+loader/corpus), snapshot.
  - `tui/team/` — the cockpit app (index.tsx: standalone home screen / picker / popup modes), sessions/projects data layer, home, tree/fuzzy/nav/mouse/keymap, report (fleet JSON), CONTROL.md.
  - `tui/integrations/` — claude.ts (hooks install/uninstall, settings merge; `TMUX_IDE_CLAUDE_SETTINGS` override).
  - `tui/mirror/` — the control-mode (tmux -C) unified-render spike: proven, parked as the endgame option.
  - `tui/main.ts` + `tui/compiled.ts` + `scripts/build-tui.mjs` — the single-binary TUI (`bun build --compile` → dist/tui/tmux-ide-tui; resolution order: dev checkout → compiled binary → honest error).
  - `widgets/` — OpenTUI/Solid panels (explorer/changes/preview/config/setup/sidebar) + lib (theme mapped to app-config tokens, grammar, help-overlay); resolve.ts maps ide.yml `type:` panes (bundle-safe paths, spawns from REPO root for the bunfig preload).
  - `lib/` — app-config (THE typed config: keys/theme/updater/notifications/restore/updates/integrations; `TMUX_IDE_CONFIG` path override), restore, worktree, update(+check), agent-discovery, skill-sync, project-registry.
  - `command-center/` — HTTP API (secondary surface).
- `packages/tmux-bridge` (process helpers) · `packages/contracts` (ide.yml schema) · `skill/SKILL.md` (the agent-facing manual, version-marked, synced to `~/.claude/skills/tmux-ide/` by postinstall / `tmux-ide update` / `tmux-ide skill-sync` / `integration install`).
- `docs/` — the website (Next/fumadocs). Gate: `pnpm docs:build`.

## Conventions & hard-won gotchas

- **Pure core, thin io, everything tested.** New pure logic gets a colocated `*.test.ts` — and MUST be added to `packages/daemon/vitest.config.ts` include list if its path isn't covered; a test file outside the include silently never runs (this bit us twice).
- **Gates before any commit**: daemon `tsc --noEmit` (now covers the .tsx apps via tui/main.ts imports), `vitest run` (600+), `pnpm lint`, `pnpm build`; `pnpm docs:build` when docs change. Full release gate: `pnpm check`.
- **Live verification is part of done** for anything touching tmux: drive it against a real session. Scratch sessions are `zz-`-prefixed (auto-filtered as internal along with `_`-prefixed) and always cleaned up. NEVER mutate or unadopt a user's real sessions; refresh with `adopt` only.
- **Nested tmux in tests** needs `TMUX= TMUX_TMPDIR= tmux attach …` (stale env leaks break the socket path). Real input can be INJECTED: `tmux send-keys -H <hex>` with SGR mouse (`\e[<b;x;yM/m`) or key escapes — this is how mouse/keyboard behavior gets truly verified.
- **tmux binds**: root-table binds are SERVER-wide; bind args do NOT format-expand but `run-shell` command strings DO (at fire time — that's where `#{client_name}`/`#{mouse_x}` get captured). `#{mouse_x}` is PANE-relative (add `#{pane_left}` via `#{e|+:…}`); `display-menu -y` is the BOTTOM edge; menus opened via a CLI hop must bind on Mouse**Up** (a Down-bind's menu is killed by the user's own release). When retiring a bind, add it to `LEGACY_BINDS` in statusline.ts — adopt only ever adds otherwise.
- **Alt keys are not reliable** (kitty keyboard protocol) — any new action needs a prefix twin (prefixKeyBinds) and shows the prefix form in user-facing hints.
- **Widgets run via bun from the REPO root** (bunfig.toml JSX preload); the project dir travels as `--dir`. The compiled binary needs NO preload but trips on bunfig if run FROM the repo root (dev quirk).
- **Env overrides for safe testing**: `TMUX_IDE_CONFIG` (config path), `TMUX_IDE_HOME` (state: welcome/update-check markers), `TMUX_IDE_CLAUDE_SETTINGS` (hooks target), `TMUX_IDE_CLAUDE_DIR` (skill target). Use them; never point tests at real user state.
- **The updater** (`_tmux-ide-chrome` session) loads code at start — after changing chrome code, kill it and re-adopt to load the new build. Keep it running for the user at the end of any work.
- **Snapshots/restore are load-bearing**: the tmux server has genuinely crashed during development; `tmux-ide restore --resume-agents` is the recovery path (and dogfood test).

## Contributor workflow

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm test && pnpm pack:check   # or: pnpm check
pnpm build            # bin/cli.js
bun scripts/build-tui.mjs   # the compiled TUI binary (artifact, gitignored)
pnpm docs:build       # website
```
