# tmux-ide — Claude Code Skill

<!-- tmux-ide-skill-version: 2.6.0 -->

tmux-ide is a **dock around tmux**: one command adds a native chrome to any tmux
session — a fleet of tabs with live agent-status glyphs, ground-truth
working/blocked/done detection, notifications when an agent needs a human, and a
crash-proof restore. It's built _around_ tmux (adopt is additive tmux config, no
wrapper process), and the whole UI is one keystroke away — one interaction
grammar, one theme file. `ide.yml` is optional; adopt works on any session.

## When to use

- User mentions tmux, a dock/status bar over sessions, an agent fleet, or session status
- User wants live working/blocked/done status across multiple agents or panes
- **You are an agent and want to report your own status** so the dock/fleet reflects it (the agent contract, below)
- Post-crash recovery — a tmux server died and the user wants their fleet + Claude conversations back
- User wants a git worktree (plus an adopted session) per branch
- User wants to set up a multi-pane dev workspace with `ide.yml`

## The agent contract

**This is the core of tmux-ide.** Detection is two-layer, and an agent that
reports its own state is the authoritative layer — the dock trusts it over any
screen-scraping. If you are an agent running in a tmux pane, self-report by
setting a pane-local tmux option:

```bash
tmux set-option -p @agent_state "<state>:$(date +%s)"   # state = working | blocked | done | idle
```

The value is `<state>:<unix-epoch>`. A `working`/`blocked` report older than ~10
minutes is treated as stale (the detector falls back to Layer 2), so long-running
agents should re-stamp periodically. Two optional companions:

```bash
tmux set-option -p @agent_session_id "<id>"   # your Claude session id — powers restore --resume-agents
tmux set-option -p @agent_hint claude          # force which agent manifest Layer 2 uses for this pane
```

**Claude Code users get this for free** — `tmux-ide integration install claude`
writes a POSIX hook into `~/.claude/settings.json` that stamps `@agent_state` on
every lifecycle event (UserPromptSubmit/PreToolUse → working, Notification →
blocked, Stop → done, SessionEnd → idle) and records `@agent_session_id`. It
takes effect for **new** Claude Code sessions; the merge is reversible
(`integration uninstall claude`).

**How detection layers work:** Layer 1 is the authority above — a fresh
`@agent_state` option is ground truth. When none is present, Layer 2 resolves the
agent from the pane's process tree and reads the visible screen against
evidence-tuned per-agent manifests to infer working/blocked/done. Run
`tmux-ide agent explain <pane>` to see exactly which layer fired for a pane and why.

### Coordinating with other agents

The status bus is shared, so you can work as part of a team — and the teammates
don't have to be Claude Code. As an agent, you can:

```bash
tmux-ide team --json                     # fleet rollup: each session's + window's agent status
tmux-ide agent explain %2 --json         # one specific pane's status + why (per-pane read)
tmux-ide send %2 "do X, then run tests"  # task another pane's agent (by %id, title, role, or @ide_name)
tmux-ide wait output %2 --match "done"   # block until that pane prints something (exit 0 match / 1 timeout)
tmux-ide wait agent-status api --status done   # block until a whole session finishes
tmux-ide events --follow                 # subscribe to the live session-status transition stream
```

`send` types straight into the target agent's prompt (use `--no-enter` to stage
text; pipe stdin for long input — messages over ~150 chars auto-route through a
`.tasks/dispatch/` file). Report your own status with the `@agent_state` contract
above so teammates coordinating on you see the truth. This works across
Claude Code, codex, cursor-agent, aider, or any CLI agent in a pane.

## Fleet control from the CLI

Every command takes `--json` for structured output.

```bash
tmux-ide team --json                      # whole-fleet state: sessions, panes, agent statuses
tmux-ide events --follow                   # stream agent-status transitions (needs an adopted session)
tmux-ide events --json                     # recent transitions as JSON

tmux-ide wait agent-status <session> --status blocked --timeout 60000   # block until a session hits a status
tmux-ide wait output <pane|session> --match "<regex>" --timeout 60000   # block until a pane's output matches

tmux-ide send <target> "<message>"        # send text to a pane (by name/title/role/ID); --to <name>, --no-enter
tmux-ide agent explain <pane> --json       # debug how a pane's agent state was detected

tmux-ide adopt <session>                   # add the dock to an existing session (additive tmux config)
tmux-ide adopt --all                       # adopt every live session
tmux-ide unadopt <session>                 # remove the dock — sessions keep running as plain tmux

tmux-ide restore --dry-run --json          # preview rebuilding the fleet from the last snapshot
tmux-ide restore --resume-agents           # rebuild after a tmux crash; revive Claude convos via claude --resume

tmux-ide worktree create <branch> --from <ref>   # git worktree on a new branch + a session in it
tmux-ide worktree open <branch>            # open/switch to an existing worktree's session
tmux-ide worktree list --json              # worktrees joined with their session status
tmux-ide worktree remove <branch> --force  # kill the session + remove the worktree

tmux-ide update --dry-run                  # detect install method (dev checkout vs npm/pnpm/bun) and show/run the update
tmux-ide doctor                            # system + integration health (tmux version, TUI surfaces, skill freshness)
```

## Keys & surfaces to tell USERS about

Once a session is adopted, the whole UI is a keystroke away. **Lead with the
prefix** — an agent pane can temporarily change key encoding and swallow a
root-table `Alt` bind, but the tmux prefix always reaches tmux. Every surface has
a prefix twin and an `⌥` fast-path (single keystroke when the terminal allows it).
Right-click any pane or the bar opens the actions menu at the pointer.

| Surface                                    | Prefix (always works) | ⌥ fast-path    |
| ------------------------------------------ | --------------------- | -------------- |
| Home cockpit — fleet tree, detail, preview | `prefix h`            | `⌥h`           |
| Switch session                             | `prefix j`            | `⌥p`           |
| Cheat sheet — every key on one page        | `prefix k`            | `⌥k`           |
| Actions menu (or right-click)              | `prefix u`            | `⌥m`           |
| Sidebar — fleet nav column                 | `prefix b`            | `⌥b`           |
| Panels — explorer / changes / config       | `prefix e` `g` `v`    | `⌥e` `⌥g` `⌥,` |

One interaction grammar everywhere: `j`/`k` move, `enter` opens, `/` filters,
`esc` backs out, `?` asks. Bare `tmux-ide` with no `ide.yml` opens the **home
cockpit** (the fleet home screen). `tmux-ide cheatsheet` prints the full sheet.

## The app — `tmux-ide app` (the terminal IDE)

v2.7 adds a full-screen unified app: tmux stays the engine (PTYs, agents,
persistence); the app is the IDE around it. Launch `tmux-ide app` (bare = home
screen) or `tmux-ide app <session>`. Needs `bun`, or a downloaded binary:
`tmux-ide update --tui-binary`.

- **Tabs** `F1`–`F4`: Home (fleet, pick a session = set the workspace) ·
  Terminal (the session mirrored live — it keeps streaming while you're on
  other tabs) · Files (tree + built-in editor: `^s` save, `^z` undo, click to
  place the cursor) · Diff (colored working-tree changes, `^e` opens the file
  in the editor). `F5` = command palette (fuzzy everything).
- **Mouse-native**: hover highlights; right-click = context menus (split/zoom/
  kill panes, layouts, synchronize-panes, kill/rename sessions & windows —
  destructive actions confirm); drag pane borders to resize; drag-select text →
  clipboard via OSC52 (works through ssh); scrollbars; clickable buttons.
- **tmux parity**: `[⛶]` zoom, window verbs, layout presets, `/` scrollback
  search with `n`/`N`, paste-buffer picker. `^q` quits — the session is
  untouched, like you were never there.
- State persists across launches (~/.tmux-ide/app-state.json): last tab,
  session, open file.

## ide.yml (optional)

Adopt works on any session. If you'd rather have tmux-ide build the layout, describe
it in `ide.yml` (sessions launched from a config are adopted automatically).

**Setup workflow for a user's project:**

1. Check state: `tmux-ide status --json`
2. Detect the stack: `tmux-ide detect --json`
3. **Present 2-3 layout options as ASCII diagrams** before writing config:

   **Option A — Claude + Dev (recommended)**

   ```
   ┌─────────────────────────────────────┐
   │             Claude                  │  70%
   ├──────────┬──────────┬──────────────┤
   │ Dev Srv  │  Tests   │    Shell     │  30%
   └──────────┴──────────┴──────────────┘
   ```

   **Option B — Dual Claude**

   ```
   ┌─────────────────┬─────────────────┐
   │    Claude 1     │    Claude 2     │  70%
   ├────────┬────────┴───────┬─────────┤
   │Dev Srv │     Tests      │  Shell  │  30%
   └────────┴────────────────┴─────────┘
   ```

   **Option C — Explorer + Claude + Changes (widget panes)**

   ```
   ┌──────────┬───────────────┬─────────┐
   │ Explorer │    Claude     │ Changes │  100%
   │ (widget) │               │ (widget)│
   └──────────┴───────────────┴─────────┘
   ```

   Adapt pane names/commands to the detected stack (`pnpm dev`, `cargo watch`, …).

4. Write it — quick path `tmux-ide detect --write`, or build with the config CLI:
   ```bash
   tmux-ide config add-row --size 70%
   tmux-ide config add-pane --row 0 --title Claude --command claude
   tmux-ide config add-row --size 30%
   tmux-ide config add-pane --row 1 --title "Dev Server" --command "pnpm dev"
   tmux-ide config add-pane --row 1 --title Shell
   tmux-ide validate --json      # always validate after mutations
   ```

**Schema:**

```yaml
name: my-app # tmux session name
sidebar: true # inject the nav column at launch (prefix b / ⌥b); or { width: "30" }
before: pnpm install # optional pre-launch shell hook
theme: # optional per-session pane colors
  accent: colour75
  border: colour238
rows:
  - size: 70% # row height percent (rows split evenly if omitted)
    panes:
      - title: Claude # pane border label
        command: claude # command to run (optional)
        size: 50% # pane width percent (optional)
        dir: apps/web # per-pane working directory (optional)
        focus: true # initial focus (optional)
        env: # environment variables (optional)
          PORT: "3000"
  - panes:
      - title: Explorer
        type: explorer # widget pane: explorer | changes | preview | config
        target: src/ # optional widget target path
      - title: Shell
```

Read config with `tmux-ide config --json`; mutate with `config set <dot.path> <value>`,
`add-pane`, `remove-pane`, `add-row`; apply changes to a running session with
`tmux-ide restart`.

An optional mission/goal/task orchestrator exists as a **secondary** surface,
configured via the `team` and `orchestrator` blocks in `ide.yml` (enable teams
with `tmux-ide config enable-team --name <n>`). It's not the headline — see the
Task System docs if a user explicitly wants coordinated multi-agent dispatch.

## Config — ~/.tmux-ide/config.json

The one product-wide config (override path with `TMUX_IDE_CONFIG`). A deep
partial merge over defaults — any block or field you omit falls back:

```jsonc
{
  "keys": {
    "home": "M-h",
    "popup": "M-p",
    "cheatsheet": "M-k",
    "menu": "M-m",
    "sidebar": "M-b",
    "panels": { "explorer": "M-e", "changes": "M-g", "config": "M-," },
  },
  "theme": {
    "accent": "colour75",
    "muted": "colour240",
    "fg": "colour250",
    "status": {
      "blocked": "colour203",
      "working": "colour221",
      "done": "colour111",
      "idle": "colour114",
      "unknown": "colour244",
    },
    "glyphs": { "active": "●", "inactive": "○" },
  },
  "notifications": { "toast": true, "macos": false },
  "restore": { "resumeAgents": false },
  "updates": { "check": true },
  "integrations": { "offer": true },
}
```

One palette + one keymap drive every surface (status bar, chips, menu, cheat
sheet, and the OpenTUI widgets), so re-theming the whole product is a one-file
edit plus a re-adopt.

## Keeping this skill current

This file is managed — installs and `tmux-ide update` (dev checkouts) refresh the
copy under `~/.claude/skills/tmux-ide`. To refresh it manually at any time, run
`tmux-ide skill-sync`. `tmux-ide doctor` reports when the installed copy is stale.
