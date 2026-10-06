<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/icon-dark.png" />
    <img src="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/icon-light.png" alt="tmux-ide" width="112" height="112" />
  </picture>
</p>

<h1 align="center">tmux-ide</h1>

<p align="center"><strong>The open-source workspace for coding agents.</strong></p>

<p align="center">An open-source project by <a href="https://www.prototyper.co">Prototyper</a> · <a href="https://github.com/wavyrai/tmux-ide/blob/main/LICENSE">MIT license</a> · <a href="https://tmux-ide.com/docs">Docs</a></p>

Run and coordinate a team of coding agents, such as Claude Code and Codex, in the
tmux sessions you already use. tmux-ide shows what every agent is doing, and lets
you jump straight to the one that needs you. tmux keeps owning every process and
pane, so closing tmux-ide never stops an agent.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/docs/public/tui-demo.svg" />
    <img src="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/docs/public/tui-demo-light.svg" alt="Animated tmux-ide app demo showing Home, named coding agents, live status, terminal panes, and Commands" width="960" />
  </picture>
</p>

## Install

```bash
curl -fsSL https://tmux-ide.com/install.sh | sh
tmux-ide app
```

Or, with Node.js 20+ already installed:

```bash
npm install -g tmux-ide
tmux-ide app
```

Runs on macOS 26+ (ARM64), macOS 15+ (x64) and glibc Linux (ARM64/x64; use WSL on
Windows). Both installs bundle tmux 3.7c, and the installer brings its own
Node.js, so you need no sudo and no system tmux. tmux servers you already run must
be tmux 3.7 or newer; tmux-ide never replaces a running server.
[Getting started](https://tmux-ide.com/docs/getting-started) has the details.

## What you get

- **Home** (`F1`) lists every agent across your local and SSH machines, with
  search and All / Working / Needs attention filters.
- **Terminals** (`F2`) mirrors the live tmux session with window tabs, pane
  headers and mouse controls. Splits, resizes, renames and closes are real tmux
  operations.
- **Agent status** for each pane: working, blocked, done or idle. It comes from
  Claude Code hooks or any agent's one-line self-report, and falls back to
  reading the screen.
- **Notifications** when an agent is blocked or done: tmux toasts, macOS and
  terminal banners, and sound.
- **Remote machines** over SSH, side by side with your local sessions.
- **Restore** after a tmux crash or reboot, including Claude Code, Codex, Cursor
  and opencode conversations.
- **Scripting**: `send`, `wait` and `team --json` from the CLI, plus scoped pane
  reads and sends over MCP and an SDK.
- **tmux chrome**: `tmux-ide adopt` adds a status bar, sidebar and keys to plain
  tmux clients.

## Agent teams

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/agent-teams-dark.gif" />
    <img src="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/agent-teams-light.gif" alt="An agent team in five tmux panes: a Claude Code orchestrator hands a goal to a Codex goal agent, which splits research across Claude Code, opencode and Codex panes; you answer the one that needs input, and the outcome flows back up." width="974" />
  </picture>
</p>

Run several coding agents as a team, each in its own tmux pane. With
[Claude Code agent teams](https://tmux-ide.com/docs/claude-code-agent-teams), a
Claude Code lead spawns teammates in split panes, and tmux-ide shows each one by
name, grouped under its team, with live status. To mix Claude Code, Codex and
other agents, group panes with `tmux-ide team assign` and coordinate them with
`send` and `wait`; see
[Multi-agent teams](https://tmux-ide.com/docs/multi-agent-teams). tmux-ide shows
and connects the agents; it does not orchestrate them.

```bash
tmux-ide team --json                               # every session, pane and agent status
tmux-ide send %2 "Run the tests and report back"   # type into another agent's prompt
tmux-ide wait agent-status api --status done       # block until a session's agent is done
```

## Keys

| Key                 | Action                                      |
| ------------------- | ------------------------------------------- |
| `F1` / `F2`         | Home / Terminals                            |
| `F5`                | Commands                                    |
| `F6` / `F7`         | Sessions / Attention (agents that need you) |
| `F10`               | Show or hide the sidebar                    |
| `Ctrl+O` / `Ctrl+T` | Next pane / next window                     |
| `Alt+Arrow`         | Resize the focused pane                     |
| Right-click a pane  | Select text, rename, split, zoom, close     |
| `Ctrl+Q`            | Quit, or detach a detachable app            |

See [every keyboard shortcut](https://tmux-ide.com/docs/getting-started#keyboard-shortcuts).

## Get exact Claude Code status

```bash
tmux-ide integration install claude
```

This installs Claude Code lifecycle hooks, so new Claude Code sessions report
working, blocked, done and idle exactly. Any other agent can report its own state
with one tmux option:

```bash
tmux set-option -p @agent_state "working:$(date +%s)"   # working | blocked | done | idle
```

## Optional workspace layout

tmux-ide works with the tmux sessions you already have. To describe a repeatable
layout for a project, add `.tmux-ide/workspace.yml`:

```bash
tmux-ide init              # scaffold from your detected stack
tmux-ide validate --json
tmux-ide start
```

See [Configuration](https://tmux-ide.com/docs/configuration) and
[Workspace templates](https://tmux-ide.com/docs/templates).

## How it works

| Layer           | Owns                                                      |
| --------------- | --------------------------------------------------------- |
| tmux            | Processes, PTYs, sessions, windows, panes and persistence |
| tmux-ide daemon | Discovery, agent state and pane streams, one per machine  |
| tmux-ide app    | Home, Terminals, chrome and mouse and keyboard input      |

tmux has years of coverage for terminal modes, resizes, disconnects and SSH.
tmux-ide builds on it instead of replacing it, and never puts your work behind a
proprietary session format. If the app or daemon stops, your sessions are still
ordinary tmux.

## Documentation

- [Getting started](https://tmux-ide.com/docs/getting-started)
- [App tour](https://tmux-ide.com/docs/app-surfaces)
- [Agent status detection](https://tmux-ide.com/docs/agent-detection)
- [Claude Code agent teams](https://tmux-ide.com/docs/claude-code-agent-teams) and
  [Multi-agent teams](https://tmux-ide.com/docs/multi-agent-teams)
- [Remote machines over SSH](https://tmux-ide.com/docs/remote-machines)
- [Restore and resume](https://tmux-ide.com/docs/restore-resume)
- [tmux chrome](https://tmux-ide.com/docs/the-dock)
- [CLI reference](https://tmux-ide.com/docs/commands)
- [Troubleshooting](https://tmux-ide.com/docs/troubleshooting)

Agents can read [tmux-ide.com/agents.md](https://tmux-ide.com/agents.md) for a
setup manual written for them.

## Contributing

See [CONTRIBUTING.md](https://github.com/wavyrai/tmux-ide/blob/main/CONTRIBUTING.md)
and [Contributing to tmux-ide](https://tmux-ide.com/docs/contributing). Release
notes are in [CHANGELOG.md](https://github.com/wavyrai/tmux-ide/blob/main/CHANGELOG.md),
and security reports go through
[SECURITY.md](https://github.com/wavyrai/tmux-ide/blob/main/SECURITY.md).

## License

[MIT](https://github.com/wavyrai/tmux-ide/blob/main/LICENSE) © Thijs Verreck
