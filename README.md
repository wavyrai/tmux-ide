# tmux-ide

[![CI](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml)

**The terminal that understands your agents.**

Other tools rebuild the terminal to understand agents. tmux-ide teaches the terminal you already use to understand them. One command adds a native chrome to any tmux session: a fleet of tabs with live agent-status glyphs, ground-truth working/blocked/done detection, notifications when an agent needs you, and a crash-proof restore that rebuilds your whole fleet — including your Claude conversations. It's built _around_ tmux, so there's nothing to migrate and nothing to lock into.

## Install

```bash
npm install -g tmux-ide
```

Global install also registers the bundled Claude Code skill and enables `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in `~/.claude/settings.json` if Claude Code is installed locally.

## Quick start

```bash
tmux-ide adopt work                    # add the dock to a session you already have
tmux-ide integration install claude    # ground-truth agent status via Claude Code hooks
tmux-ide events --follow               # stream agent-status transitions
tmux-ide unadopt work                  # revert — it was only tmux options
```

`adopt` is purely additive tmux configuration. If tmux-ide ever crashes or is uninstalled, your sessions keep running as ordinary tmux — no wrapper process, no lock-in. And because the chrome lives server-side, it renders from any client, including over SSH.

## The three-beat story

**Adopt in place.** `tmux-ide adopt <session>` drops a status bar onto any existing session: clickable fleet tabs, per-agent glyphs, and `[ ⌂ home ] [ ⧉ switch ] [ ? keys ]` triggers.

**Know your fleet.** Install the Claude Code integration and working/blocked/done come from the agent's own lifecycle. A toast fires on every attached client the moment an agent goes blocked or done; per-pane border chips read `claude · working`. Any agent can self-report with one pane option:

```bash
tmux set-option -p @agent_state "working:$(date +%s)"
```

**Survive anything.** Continuous snapshots mean a tmux server death isn't a lost afternoon. `tmux-ide restore` rebuilds every session, window, layout, cwd, and title; `--resume-agents` revives your Claude conversations from their recorded session ids.

## One app, one keystroke away

Once a session is adopted, the whole UI is a modifier key away — one interaction grammar (`j`/`k` move, `enter` opens, `/` filters, `esc` backs out, `?` asks) and one theme file (`~/.tmux-ide/config.json`).

| Key | Surface |
| --- | --- |
| `⌥h` | Home cockpit — fleet tree, detail, live preview, rollup header |
| `⌥b` | Sidebar — a fleet nav column in any session |
| `⌥e` `⌥g` `⌥,` | Floating panels — file explorer, git changes, config editor |
| `⌥m` | Actions menu — native tmux menu at the pointer (or right-click) |
| `⌥p` | Switch session |
| `⌥k` | Cheat sheet — every key on one page |

## Optional: describe a layout with ide.yml

Adopt works on any session. If you'd rather have tmux-ide build the layout, scaffold an `ide.yml`:

```bash
tmux-ide init          # auto-detects your stack
tmux-ide               # launch (the session is adopted automatically)
```

```yaml
name: my-app
sidebar: true # ⌥b nav column

rows:
  - size: 70%
    panes:
      - title: Claude
        command: claude
        focus: true
      - title: Shell
  - panes:
      - title: Dev Server
        command: pnpm dev
```

## More

tmux-ide also has a `worktree` flow (a git worktree plus an adopted session per branch), `wait` coordination primitives, a `--json` surface on every command, and an optional task/mission orchestrator for coordinated multi-agent work. See the docs:

- [Getting started](https://github.com/wavyrai/tmux-ide) and the full docs site
- Run `tmux-ide --help` for the complete command list

## Requirements

- **tmux** — 3.2+ recommended (`tmux-ide doctor` requires ≥ 3.0; 3.6 is the smoothest)
- **Node.js** — ≥ 20
- **Bun** — only for the TUI surfaces (home cockpit, sidebar, floating panels)

Run `tmux-ide doctor` to check your machine.

## Contributor workflow

The repo is a pnpm workspace with a root CLI package and a separate docs app package:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm test
pnpm docs:build
pnpm pack:check
```

`pnpm check` is the intended local pre-push command and matches the default release checklist.

## Open source project files

- [CONTRIBUTING.md](CONTRIBUTING.md) — local setup and contribution workflow
- [RELEASE.md](RELEASE.md) — publish checklist
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [SECURITY.md](SECURITY.md) — vulnerability reporting

## License

[MIT](LICENSE)
