# tmux-ide control surface

A small, scriptable API over the tmux-ide fleet. Meant for agents and scripts
that need to read cockpit state or block on a session's status.

## `tmux-ide team --json`

Prints the whole fleet as JSON (no TUI). Shape:

```json
{
  "projects": [
    {
      "name": "web",
      "dir": "/workspace/web",
      "registered": true,
      "running": true,
      "status": "working",
      "sessions": [{ "name": "web", "status": "working", "panes": 3, "attached": true }]
    }
  ]
}
```

`status` is one of `blocked | working | done | idle | unknown`. `dir` may be
`null` for ad-hoc sessions. Projects with no live session have `running:false`
and an empty `sessions` array.

## `tmux-ide wait agent-status <session> --status <status> [--timeout <ms>]`

Blocks until `<session>` reaches `<status>`, polling every ~750ms.

- `--status` — required, one of `blocked | working | done | idle | unknown`.
- `--timeout` — milliseconds, default `60000`.
- Exit `0` on match (prints a success line, or JSON with `--json`).
- Exit `1` on timeout (message to stderr).

A session that does not exist yet is not an error — `wait` keeps polling until
it appears or the timeout elapses. `done` is a working→idle transition, so the
poller keeps one status tracker alive across ticks to observe it.

```bash
tmux-ide wait agent-status build --status done --timeout 120000 && echo "build finished"
```

## `TMUX_IDE=1` env marker

Sessions created by the cockpit have `TMUX_IDE=1` set in the tmux session
environment. Agents inside a pane can check `$TMUX_IDE` to detect that they are
running under tmux-ide.
