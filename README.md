<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/icon-dark.png"
    />
    <img
      src="https://raw.githubusercontent.com/wavyrai/tmux-ide/main/.github/assets/icon-light.png"
      alt="tmux-ide"
      width="120"
      height="120"
    />
  </picture>
</p>

<h1 align="center">tmux-ide</h1>

<p align="center"><strong>The terminal that understands your agents.</strong></p>

<p align="center">
  <a href="https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml"><img src="https://github.com/wavyrai/tmux-ide/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

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

## Teams of any agents

Run a heterogeneous fleet — Claude Code, codex, cursor-agent, aider, anything — in one set of sessions, and let them coordinate. Every agent's status is on a shared bus every other agent can read; one agent can task another by typing into its prompt; and any agent can block until a teammate finishes. It's agent-agnostic by design: Claude Code reports automatically, everyone else self-reports with a one-line pane option.

```bash
tmux-ide team --json                                   # read the fleet's status
tmux-ide send %2 "implement /login, then run the tests" # task another agent
tmux-ide wait output %2 --match "tests passed"          # block until it finishes
tmux-ide wait agent-status api --status done            # or wait on a whole session
```

`send` types straight into another agent's prompt (target by pane ID, title, role, or name; long messages auto-route through a dispatch file). `wait` exits `0` on match, `1` on timeout, so it scripts cleanly. See the multi-agent teams docs for a worked lead-dispatches-to-codex example.

## One app, a keystroke away

Once a session is adopted, the whole UI is a keystroke or two away — one interaction grammar (`j`/`k` move, `enter` opens, `/` filters, `esc` backs out, `?` asks) and one theme file (`~/.tmux-ide/config.json`).

Every surface has a **prefix twin** (`prefix` then a letter) that works under every keyboard protocol, plus an `⌥` fast-path for a single keystroke when your terminal allows it. Lead with the prefix — an agent pane can temporarily change how the terminal encodes keys and swallow a root-table `Alt` bind, but the tmux prefix always reaches tmux. Right-click anywhere opens the actions menu at the pointer.

| Surface                                        | Prefix (always works) | Alt fast-path  |
| ---------------------------------------------- | --------------------- | -------------- |
| Home cockpit — fleet tree, detail, preview     | `prefix h`            | `⌥h`           |
| Switch session                                 | `prefix j`            | `⌥p`           |
| Cheat sheet — every key on one page            | `prefix k`            | `⌥k`           |
| Actions menu — at the pointer (or right-click) | `prefix u`            | `⌥m`           |
| Sidebar — a fleet nav column                   | `prefix b`            | `⌥b`           |
| Panels — explorer / changes / config           | `prefix e` `g` `v`    | `⌥e` `⌥g` `⌥,` |

## Optional: describe a layout with ide.yml

Adopt works on any session. If you'd rather have tmux-ide build the layout, scaffold an `ide.yml`:

```bash
tmux-ide init          # auto-detects your stack
tmux-ide               # launch (the session is adopted automatically)
```

```yaml
name: my-app
sidebar: true # nav column (prefix b / ⌥b)

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
- **Bun** — only needed for the TUI surfaces (home cockpit, sidebar, floating
  panels) **when running from a dev checkout**. Installed releases ship a
  compiled `tmux-ide-tui` binary instead, so no bun runtime is required.

Run `tmux-ide doctor` to check your machine — the "TUI surfaces" row reports
whether they resolve via a dev checkout (bun) or the compiled binary.

### TUI surfaces & the compiled binary

The cockpit/sidebar/widget surfaces are OpenTUI/Solid (`.tsx`). In a dev checkout
they run under `bun` (the bunfig preload supplies the JSX transform). For
installed users there is no checkout and often no bun, so those surfaces run from
a single self-contained executable built with `bun build --compile`:

```bash
pnpm build:tui   # → packages/daemon/dist/tui/tmux-ide-tui (requires bun to build)
```

It bundles every surface behind a `tmux-ide-tui <surface> [flags]` dispatcher,
embeds the native OpenTUI dylib, and pre-transforms JSX at build time — so it
needs no runtime. The CLI resolves surfaces checkout-first, then a shipped/local
compiled binary, then a per-platform binary downloaded on demand.

**Per-platform binaries.** The npm tarball does _not_ carry the ~70MB binary (a
surprise on every install). Instead each release publishes one per platform
(darwin-arm64, darwin-x64, linux-x64, linux-arm64) as a GitHub release asset. On
a machine with no `bun` and no shipped binary, fetch the right one on demand:

```bash
tmux-ide update --tui-binary   # downloads it to ~/.tmux-ide/bin/ (verified, chmod +x)
```

Nothing is downloaded automatically on install. `tmux-ide doctor`'s "TUI
surfaces" row spells out how surfaces currently resolve on your machine.

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
