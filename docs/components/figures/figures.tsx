import {
  PaneFigure,
  type Pane,
  type PaneLink,
  type PaneRow,
} from "@/components/figures/pane-figure";
import { TreeFigure } from "@/components/figures/tree-figure";

/**
 * The site's "how it works" figures. Every claim stays within the current
 * release: tmux-ide shows and routes to agents; it does not orchestrate them.
 * Pane screens are illustrative; the pairings and task text are examples.
 */

const TEAM_SUBTITLE = (
  <>
    One agent per tmux pane, across harnesses. Coordinate them with <code>tmux-ide send</code> and{" "}
    <code>wait</code>, or use Claude Code agent teams for all-Claude teams; tmux-ide shows every
    agent and its status. It does not orchestrate them.
  </>
);
const TEAM_CAPTION =
  "A goal goes to an execution agent, which splits bounded questions across three researchers; findings and the finished outcome flow back up for review.";
const TEAM_NOTES = [
  {
    letter: "a",
    label: "Coordination",
    text: "Turns your goal into focused tasks and hands them to the team.",
  },
  {
    letter: "b",
    label: "Goal ownership",
    text: "Owns one goal and asks specialists to resolve specific questions.",
  },
  {
    letter: "c",
    label: "Parallel research",
    text: "Each researcher works one bounded question in parallel.",
  },
] as const;

/* The team builds over one loop: the orchestrator opens and takes the goal,
   the goal agent opens, three researchers open in parallel, results flow
   back up, and the outcome reaches the orchestrator. */
const RESEARCH: readonly Pane[] = [
  {
    id: "%3",
    cmd: "claude",
    role: "Research · A",
    mark: "claude-code",
    open: "o39",
    lines: [{ text: "$ claude" }, { text: "› architecture & existing code", tone: "dim" }],
    states: [
      { status: "working", text: "researching…", t: "v39-56", spin: true },
      { status: "done", text: "findings sent", t: "v56-94" },
    ],
  },
  {
    id: "%4",
    cmd: "opencode",
    role: "Research · B",
    mark: "opencode",
    open: "o42",
    lines: [{ text: "$ opencode" }, { text: "› APIs & documentation", tone: "dim" }],
    states: [
      { status: "working", text: "researching…", t: "v42-60", spin: true },
      { status: "done", text: "findings sent", t: "v60-94" },
    ],
  },
  {
    id: "%5",
    cmd: "codex",
    role: "Research · C",
    mark: "codex",
    open: "o45",
    alert: "v62-94",
    lines: [{ text: "$ codex" }, { text: "› edge cases & validation", tone: "dim" }],
    states: [
      { status: "working", text: "researching…", t: "v45-62", spin: true },
      { status: "blocked", text: "needs your input", t: "v62-94" },
    ],
  },
];

const TEAM_ROWS: readonly PaneRow[] = [
  {
    win: "1:orchestrate",
    tab: "v4-94",
    panes: [
      {
        id: "%1",
        cmd: "claude",
        role: "Orchestrator",
        mark: "claude-code",
        open: "o4",
        lines: [
          { text: "$ claude" },
          { text: "› add rate limiting to /api/upload", typed: true, t: "t8-18" },
        ],
        states: [
          { status: "idle", text: "ready", t: "v4-14" },
          { status: "working", text: "planning the team…", t: "v14-27", spin: true },
          { status: "idle", text: "waiting for results", t: "v27-78" },
          { status: "done", text: "outcome + proof received", t: "v78-94" },
        ],
      },
    ],
  },
  {
    win: "2:goal",
    tab: "v27-94",
    panes: [
      {
        id: "%2",
        cmd: "codex",
        role: "Goal agent",
        mark: "codex",
        open: "o27",
        lines: [{ text: "$ codex" }, { text: "› plan · delegate · integrate", tone: "dim" }],
        states: [
          { status: "working", text: "working…", t: "v27-66", spin: true },
          { status: "working", text: "integrating findings…", t: "v66-74", spin: true },
          { status: "done", text: "outcome + proof sent", t: "v74-94" },
        ],
      },
    ],
  },
  { win: "3:research", tab: "v39-94", panes: RESEARCH },
];

const TEAM_LINKS: readonly PaneLink[] = [
  {
    down: "goal + acceptance criteria",
    up: "outcome + proof",
    t: { down: "d22", dl: "v24-94", up: "u74", ul: "v76-94" },
  },
  {
    down: "scoped research tasks",
    up: "findings + recommendations",
    t: { down: "d34", dl: "v36-94", up: "u58", ul: "v60-94" },
  },
];

export function AgentTeamsFigure() {
  return (
    <PaneFigure
      id="agent-teams-figure"
      story="pf-loop"
      number="5"
      kicker="Systems / Agent coordination"
      title="Claude Code, Codex and opencode"
      accent="in one agent team."
      subtitle={TEAM_SUBTITLE}
      session="agent-team"
      label="An agent team in five tmux panes: a Claude Code orchestrator hands a goal to a Codex goal agent, which splits research across Claude Code, opencode and Codex panes; findings flow back up and one researcher needs your input."
      rows={TEAM_ROWS}
      links={TEAM_LINKS}
      notes={TEAM_NOTES}
      caption={TEAM_CAPTION}
      reading={{
        lead: "Reading the figure.",
        text: "Each frame is an agent process in its own pane, with the command it runs. Pairings and tasks are illustrative.",
      }}
    />
  );
}

/** The docs column gets the same team as a fleet tree: lighter and static. */
export function AgentTeamsTree() {
  return (
    <TreeFigure
      id="docs-agent-teams-figure"
      number="1"
      kicker="Systems / Agent coordination"
      title="Claude Code, Codex and opencode in one agent team."
      session="~/project · agent-team"
      rows={[
        {
          depth: 0,
          status: "idle",
          mark: "claude-code",
          name: "claude",
          role: "Orchestrator",
          meta: "%1",
          note: TEAM_NOTES[0],
        },
        {
          depth: 1,
          status: "working",
          mark: "codex",
          name: "codex",
          role: "Goal agent",
          meta: "%2",
          flow: "↓ goal + acceptance criteria  ↑ outcome + proof",
          note: TEAM_NOTES[1],
        },
        {
          depth: 2,
          status: "done",
          mark: "claude-code",
          name: "claude",
          role: "Research · A",
          meta: "%3",
          flow: "↓ scoped research tasks  ↑ findings + recommendations",
          note: TEAM_NOTES[2],
        },
        {
          depth: 2,
          status: "working",
          mark: "opencode",
          name: "opencode",
          role: "Research · B",
          meta: "%4",
          duty: "Investigate APIs & documentation",
        },
        {
          depth: 2,
          status: "blocked",
          mark: "codex",
          name: "codex",
          role: "Research · C",
          meta: "%5",
          duty: "Probe edge cases & validation options",
        },
      ]}
      foundation={[
        "tmux-ide",
        "persistent panes",
        "send · wait · read output",
        "live agent status",
      ]}
      caption={TEAM_CAPTION}
      reading={{
        lead: "Reading the figure.",
        text: "Each row is an agent process in its own pane; indentation shows who delegates to whom. Pairings are illustrative.",
      }}
    />
  );
}

/* Architecture: every pane is present; one loop shows output and state
   flowing from tmux to the clients, then a command flowing back. */
const ARCH_ROWS: readonly PaneRow[] = [
  {
    win: "0:tmux",
    panes: [
      {
        id: "server",
        cmd: "tmux",
        role: "Local or SSH",
        lines: [
          { text: "processes · PTYs · panes · layout", tone: "dim" },
          { text: "%3 claude  ✓ tests passed", tone: "done", t: "v8-94" },
          { text: "%4 ⏎ run tests", t: "v76-94" },
        ],
      },
    ],
  },
  {
    win: "1:daemon",
    panes: [
      {
        id: "per machine",
        cmd: "tmux-ide daemon",
        role: "Authority",
        lines: [
          { text: "discovery · agent state · streams", tone: "dim" },
          { text: "→ %3 done, streamed", t: "v20-94" },
          { text: "← send to %4", t: "v64-94" },
        ],
      },
    ],
  },
  {
    win: "2:clients",
    panes: [
      {
        id: "app",
        cmd: "tmux-ide app",
        role: "Home · Terminals",
        lines: [
          { text: "agents across machines", tone: "dim" },
          { text: "✓ claude %3 done", tone: "done", t: "v30-94" },
        ],
      },
      {
        id: "cli",
        cmd: "automation",
        role: "CLI · MCP · SDK",
        lines: [
          { text: "reads · sends · events", tone: "dim" },
          { text: "event %3 → done", t: "v30-94" },
          { text: '› send %4 "run tests"', typed: true, t: "t44-54" },
        ],
      },
    ],
  },
];

const ARCH_LINKS: readonly PaneLink[] = [
  {
    down: "panes · output · layout",
    up: "tmux commands",
    hi: { down: "v12-20", up: "v66-74" },
  },
  {
    down: "sessions · agent state · streams",
    up: "typed commands & input",
    hi: { down: "v22-30", up: "v56-64" },
  },
];

export function ArchitectureFigure() {
  return (
    <PaneFigure
      id="architecture-figure"
      story="pf-loop"
      number="6"
      kicker="Systems / Runtime architecture"
      title="tmux owns the processes."
      accent="tmux-ide adds the view."
      subtitle="Close the app or lose SSH; every agent keeps running in tmux."
      session="tmux-ide"
      label="The tmux server holds every pane; the tmux-ide daemon streams their output and agent state to the app and automation clients and applies their commands back to tmux."
      rows={ARCH_ROWS}
      links={ARCH_LINKS}
      notes={[
        {
          letter: "a",
          label: "Terminal truth",
          text: "tmux owns every process, pane and session, locally or over SSH.",
        },
        {
          letter: "b",
          label: "One authority",
          text: "For the app and automation, the daemon is the only path to live tmux state.",
        },
        {
          letter: "c",
          label: "Many views",
          text: (
            <>
              The app and automation act through the daemon; plain tmux clients still attach
              directly. <a href="/docs/remote-machines">Connect over SSH →</a>{" "}
              <a href="/docs/restore-resume">Restore after a crash →</a>
            </>
          ),
        },
      ]}
      caption="The daemon publishes tmux state to the app and automation clients and applies their commands back to tmux."
      reading={{
        lead: "Reading the figure.",
        text: "Every action is an ordinary tmux operation you could also run from a tmux client.",
      }}
    />
  );
}

export function AgentDetectionFigure({ id = "detection-figure" }: { id?: string }) {
  return (
    <TreeFigure
      id={id}
      number="1"
      kicker="Systems / Agent detection"
      title="Two layers, one status."
      session="how pane %3 gets its status"
      rows={[
        { depth: 0, status: "working", name: "%3", role: "A tmux pane", meta: "working" },
        {
          depth: 1,
          name: "@agent_state",
          role: "Self-report · pane option",
          meta: "authority",
          note: {
            letter: "a",
            label: "Ground truth",
            text: "A fresh @agent_state stamp from Claude Code hooks or any agent always wins and goes straight to the status.",
          },
        },
        {
          depth: 1,
          name: "pane_pid → agent",
          role: "Process tree",
          meta: "fallback",
          flow: "↓ no fresh stamp",
          note: {
            letter: "b",
            label: "Inference",
            text: "With no stamp, or one older than 10 minutes, tmux-ide finds the real agent and reads its screen.",
          },
        },
        {
          depth: 2,
          name: "rule set per agent",
          role: "Screen manifests",
          meta: "fallback",
          duty: "Infers working, blocked or done",
        },
        {
          depth: 1,
          name: "working · blocked · done · idle",
          role: "Agent status",
          note: {
            letter: "c",
            label: "Everywhere",
            text: "The same status drives Home, pane headers, the chrome and team --json.",
          },
        },
      ]}
      foundation={["explain any pane", "tmux-ide agent explain <pane>"]}
      caption="A pane's status comes from its own fresh self-report when there is one; otherwise from its process tree and visible output, matched against per-agent manifests."
    />
  );
}
