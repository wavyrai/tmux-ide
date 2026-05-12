# Handoff — 2026-05-08 ~09:35

Picking up from a long orchestration session. Read this first; act second.

## Current state of the world

**Goals 01–11 closed.** Goal 12 at 4/5; goal 13 (chat overhaul) sketched, not started.

| Goal | Status |
|---|---|
| 01–07 | ✅ (v2 shell, widgets, cleanup, cutover, sidebar migration, diffs fold, FileTree) |
| 08 Audit + relocate to single canonical tree | ✅ |
| 09 Real-IDE feel (diffs, file tree, activity bar) | ✅ |
| 10 t3-style consolidation | ✅ |
| 11 Boundary enforcement + tmux-bridge | ✅ |
| 12 Singleton daemon + multi-workspace registry | 🔄 (T065/T066/T067 done; T068 + T069 queued) |
| 13 Full t3 chat with tmux-as-a-tool | 📐 sketched, T070 schemas need design before any agent touches |

## What's broken right now

1. **Daemon is DOWN.** I killed bun PID 92146 to force a restart so it would pick up T065/T066 endpoints. Watchdog didn't respawn (we'd already pkill'd watchdogs earlier in the session). Port 6060 is empty.

2. **`tmux-ide` CLI broken** — `tmux-ide send`, `tmux-ide task claim`, `tmux-ide goal done` all fail with "Session 'tmux-ide' is not running". Likely a session-name resolution regression from T041 entry-point relocation or T065 registry. Diagnose before relying on it.

3. **A `bun test` is still running** (PID 53142, started 8:39am, ~62min CPU). Looks like an agent's test command that hung. Decide whether to kill before restarting daemon — it may complete soon.

4. **Daemon HTTP API endpoints `/api/workspaces` (T066)** are in source but were not live before I killed the daemon. Need a restart of `bun packages/daemon/src/lib/daemon.ts new-name 6060` (note: it executes TS directly via Bun, no compile step) to bring them up.

## Next actions in order

1. **Verify the bun test (PID 53142)** — `ps aux | grep 53142` to see if it's still alive. If it's been stuck >10min on its current state, kill it.
2. **Restart the daemon manually**:
   ```bash
   cd /Users/thijs/Developer/tmux-ide
   bun packages/daemon/src/lib/daemon.ts new-name 6060 &
   ```
   Verify with `curl http://localhost:6060/api/workspaces` — should return JSON, not 404.
3. **Diagnose the CLI break** — try `tmux-ide ls --json`. Likely fix: session-name resolution in `packages/daemon/src/cli.ts` reading the wrong source after T041/T065. Check what `tmux-ide send` does when it can't find the session.
4. **Dispatch T068 (CLI flip) and T069 (publish package)** to close goal 12. Three agents in tmux session `new-name` are idle:
   - pane 0 = Lead
   - pane 1 = Frontend
   - pane 2 = Backend
   - pane 3 = Validator

   Hand off via manual dispatch (CLI is broken):
   ```bash
   cat > /tmp/dispatch.txt <<'EOF'
   <prompt body>
   EOF
   tmux load-buffer -b dx /tmp/dispatch.txt
   tmux paste-buffer -b dx -t new-name:0.<pane> -p
   tmux send-keys -t new-name:0.<pane> Enter
   ```
5. **Sit down with the user on T070 schemas** before goal 13 dispatches. The Thread/Turn/Message/Plan/ActivityItem/Checkpoint shape is load-bearing. Don't let an agent invent it.

## Key facts the user has stated (paraphrased)

- **Chat = full t3 feature parity.** All of: thread/turn/plan/activity-stream, plan-approve-execute, turn-level checkpoint+revert, multi-agent threads, provider abstraction. *Not* a simple Claude.ai-with-tools.
- **BUT tmux operations show up in the chat as tool calls**, rendered as activity items in the turn stream like any other tool (`read_file`, `bash`, `send_to_pane`).
- **No migration needed** for existing chat data — clean break is fine.
- **tmux remains the agent execution substrate.** Lead/Frontend/Backend/Validator stay as Claude Code panes. The chat just has a `send_to_pane` (and friends) tool.
- **Manual dispatch only** for now — `tmux-ide send`/`task claim` are broken. Use tmux load-buffer + paste-buffer.
- **Don't restart daemon while agents are working.** Restart only between dispatch waves.

## Architectural state of the repo

Just landed (mostly today):
- One canonical daemon tree at `packages/daemon` (no more `src/` divergence)
- CLI co-located in `packages/daemon/src/cli.ts` + `bin.ts`
- `@tmux-ide/contracts` owns all wire schemas (Zod)
- `packages/tmux-bridge` owns all tmux shell calls; `TmuxSession`/`TmuxPane`/`TmuxPaneTarget` types in contracts
- `packages/daemon-client` has lock file + discovery (T067)
- ESLint boundaries enforced (zero violations baselined)
- Pre-commit + CI block new files in repo-root `src/`
- Typed HTTP/WS client from contracts replaces `dashboard/lib/api.ts`
- ARCHITECTURE.md at repo root — read this for the import-direction rules
- SQLite event-log behind env flag `TMUX_IDE_EVENT_LOG=sqlite` (T057)
- WorkspaceRegistry in daemon (T065)
- `/api/workspaces` endpoint + WS events (T066) — needs daemon restart to be live

## Open task IDs

- T068 — CLI flip: `tmux-ide` ensures-daemon + registers-workspace (depends on T065/T066/T067 — all done)
- T069 — Publish `@tmux-ide/daemon` as standalone npm package
- Goal 13 (T070–T079) — DO NOT DISPATCH YET. Sketch T070 schemas with user first.

## How to read fresh status (CLI is broken)

```bash
# Tasks via HTTP (after daemon restart)
curl -s http://localhost:6060/api/project/new-name | python3 -c "import json,sys; d=json.load(sys.stdin); [print(t['id'],t.get('status'),t.get('assignee'),t.get('title','')[:50]) for t in d.get('tasks',[]) if t.get('status') in ('todo','in-progress','review')]"

# Pane state
for i in 0 1 2 3; do
  echo "=== pane $i ==="
  tmux capture-pane -t new-name:0.$i -p -S -15 | tail -10
done
```

— end of handoff
