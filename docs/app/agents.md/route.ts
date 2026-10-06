import { SITE_URL, SOFTWARE_VERSION } from "@/lib/site";

export const revalidate = false;

/**
 * A manual written for AI agents: what tmux-ide is, how to install and wire
 * it up, and the commands an agent uses to report and coordinate. Facts come
 * from the CLI's --help, the agent contract and the product-truth ledger; keep
 * it to surfaces the current release ships.
 */
const manual = `# tmux-ide — manual for AI agents

tmux-ide ${SOFTWARE_VERSION}. Docs: ${SITE_URL}/docs · Index for LLMs: ${SITE_URL}/llms.txt · Full text: ${SITE_URL}/llms-full.txt

## Quick reference

\`\`\`bash
tmux set-option -p @agent_state "working:$(date +%s)"                 # report state: working|blocked|done|idle
tmux-ide team --json                                                  # every session, window and per-pane agent state
tmux-ide send <target> "message"                                      # type into another pane and press Enter (--no-enter to stage)
tmux-ide wait agent-status <session> --status done --timeout 600000   # exit 0 on match, 1 on timeout
tmux-ide agent explain <pane> --json                                  # why a pane has its state
tmux-ide validate --json                                              # after any workspace.yml change
\`\`\`

tmux-ide is an open-source (MIT) agent workspace built around tmux, by Prototyper. tmux keeps
owning processes, PTYs, sessions, windows and panes; tmux-ide adds a terminal app with live
agent status, named agents and panes, and exact pane navigation, plus an optional status-bar chrome
for plain tmux clients. If tmux-ide stops, every session is still ordinary tmux.

## Install

\`\`\`bash
curl -fsSL ${SITE_URL}/install.sh | sh   # macOS and glibc Linux; installs under ~/.local, no sudo
npm install -g tmux-ide                   # alternative when Node.js 20+ is already installed
tmux-ide doctor                           # check tmux version, runtime and integrations
\`\`\`

The installer prints a PATH instruction if \`~/.local/bin\` is not on PATH. Existing tmux
sessions are preserved.

## Set up a project

\`\`\`bash
tmux-ide app [session]                  # open the app (bare \`tmux-ide\` does the same outside a configured project)
tmux-ide adopt <session>                # add the status-bar chrome to an existing tmux session
tmux-ide adopt --all                    # adopt every live session; \`unadopt <session>\` reverts
tmux-ide integration install claude     # Claude Code hooks: ground-truth agent status + skill
tmux-ide integration install opencode   # capture opencode session ids for restore --resume-agents
tmux-ide integration status --json      # what is detected and wired up
\`\`\`

The app has two surfaces: Home (F1: agents across local and SSH machines, search, needs-attention
filter) and Terminals (F2: the live session, window tabs, pane headers). F5 opens Commands; Ctrl+Q
quits and leaves every session running.

A \`.tmux-ide/workspace.yml\` layout is optional. To create one: \`tmux-ide detect --json\`, propose
two or three layouts to the user, then \`tmux-ide detect --write\` or the \`tmux-ide config\`
commands, and always finish with \`tmux-ide validate --json\`.

## Report your own state (the agent contract)

If you run inside a tmux pane, set pane-local options. A fresh self-report is the
authoritative signal; screen scraping is only the fallback.

\`\`\`bash
tmux set-option -p @agent_state "working:$(date +%s)"    # working | blocked | done | idle
tmux set-option -p @agent_status_text "refactoring auth"  # optional, plain text, max 32 chars
tmux set-option -p @agent_display_name "reviewer"         # optional name shown in the UI
tmux set-option -p @agent_hint <manifest-id>              # force a detection manifest (e.g. claude, codex)
tmux set-option -p @agent_session_id "<id>"               # set only to your harness's real resume id; restore --resume-agents uses it
\`\`\`

The status text and display name are honored only while \`@agent_state\` is fresh.

The value of \`@agent_state\` is \`<state>:<unix-epoch>\`. A working or blocked report older than
about 10 minutes is treated as stale, so re-stamp while you work. Claude Code gets this
automatically after \`tmux-ide integration install claude\` (new sessions only).

## Observe and coordinate

Commands that list \`--json\` in \`tmux-ide --help\` return structured output; prefer it.

\`\`\`bash
tmux-ide team --json                               # every session, pane and agent status
tmux-ide agent explain <pane> --json               # how a pane's status was detected
tmux-ide send <target> "message"                   # type into another pane's agent (%id, title or name)
tmux-ide wait agent-status <session> --status done # block until a session reaches a status
tmux-ide wait output <pane> --match "<regex>" [--timeout <ms>]  # block until a pane prints a match
tmux-ide events --follow --json                    # stream agent-status transitions
tmux-ide serve                                     # local control socket for long-running loops
tmux-ide team assign <%pane> "<team>"              # group panes into a named team; team unassign <%pane> removes
tmux-ide automation panes --json                   # scoped, attributed pane reads/sends with retry-safe handles
tmux-ide mcp                                       # the same automation tools over MCP stdio
\`\`\`

Both waits exit 0 on match, 1 on timeout. Use \`send\`/\`wait\` for quick messages; use
\`automation\` or \`mcp\` when you need exact pane identity, attribution and retry-safe handles (${SITE_URL}/docs/automation).

Claude Code agent teams: set \`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1\` and \`teammateMode\`
\`"tmux"\` (or \`"auto"\` inside tmux) in \`~/.claude/settings.json\`; releases after 2.9.3 set this up
in the installer; split-pane teammates then appear in tmux-ide grouped under their team, named as the
lead named them, with normal agent status. tmux-ide reads
\`~/.claude/teams/<team>/config.json\` read-only; Claude Code owns spawning, tasks and messaging.
Docs: ${SITE_URL}/docs/claude-code-agent-teams

## Recover and branch

\`\`\`bash
tmux-ide restore --dry-run --json      # preview rebuilding the fleet after a tmux server crash
tmux-ide restore --resume-agents       # rebuild and resume agent conversations
tmux-ide worktree create <branch>      # git worktree on a new branch with its own session
\`\`\`

## Rules for agents

- Never kill, unadopt or rename a user's sessions unless asked; use scratch sessions for tests.
- Do not present task or mission orchestration as available; it is not part of this release.
- Use \`tmux-ide send\`, not raw \`tmux send-keys\`, so the target resolves by id, title or name and long
  messages go through a dispatch file.
- When unsure about a command, run \`tmux-ide --help\` or read ${SITE_URL}/docs/commands.
- Docs for depth: ${SITE_URL}/docs/agent-detection · ${SITE_URL}/docs/multi-agent-teams ·
  ${SITE_URL}/docs/restore-resume · ${SITE_URL}/docs/automation
`;

export function GET() {
  return new Response(manual, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
