import { AcademicFigure } from "@/components/figures/academic-figure";

/**
 * The site's "how it works" figures. Every claim stays within the current
 * release: tmux-ide shows and routes to agents; it does not orchestrate them.
 */

export function AgentTeamsFigure({
  id = "agent-teams-figure",
  number = "5",
  heading = "h2",
  compact = false,
  foundation = true,
}: {
  id?: string;
  number?: string;
  heading?: "h2" | "h3";
  compact?: boolean;
  /** The shared-workspace strip (on by default). */
  foundation?: boolean;
}) {
  return (
    <AcademicFigure
      id={id}
      heading={heading}
      compact={compact}
      number={number}
      kicker="Systems / Agent coordination"
      title="Heterogeneous"
      accent="agent teams."
      subtitle={
        <>
          One agent per tmux pane, across harnesses. Coordinate them with <code>tmux-ide send</code>{" "}
          and <code>wait</code>, or use Claude Code agent teams for all-Claude teams; tmux-ide shows
          every agent and its status. It does not orchestrate them.
        </>
      }
      label="Delegation and synthesis"
      legend={{ solid: "Delegation", dashed: "Results & evidence" }}
      levels={[
        {
          letter: "a",
          name: "Orchestration",
          note: {
            label: "Coordination",
            text: "Turns your goal into focused tasks and hands them to the team.",
          },
          cards: [
            {
              cap: "Orchestrator",
              tag: "Pane 01",
              name: "Claude Code",
              mono: "claude",
              duty: "Sets direction · assigns goals · reviews outcomes",
            },
          ],
        },
        {
          letter: "b",
          name: "Goal execution",
          note: {
            label: "Goal ownership",
            text: "Owns one goal and asks specialists to resolve specific questions.",
          },
          cards: [
            {
              cap: "Goal agent",
              tag: "Pane 02",
              name: "Codex",
              mono: "codex",
              duty: "Plans implementation · delegates · integrates",
            },
          ],
        },
        {
          letter: "c",
          name: "Parallel research",
          note: {
            label: "Parallel research",
            text: "Each researcher works one bounded question in parallel.",
          },
          cards: [
            {
              cap: "Research · A",
              tag: "Pane 03",
              name: "Claude Code",
              mono: "claude",
              duty: "Explore architecture & existing code",
            },
            {
              cap: "Research · B",
              tag: "Pane 04",
              name: "opencode",
              mono: "opencode",
              duty: "Investigate APIs & documentation",
            },
            {
              cap: "Research · C",
              tag: "Pane 05",
              name: "Codex",
              mono: "codex",
              duty: "Probe edge cases & validation options",
            },
          ],
        },
      ]}
      links={[
        { down: "goal + acceptance criteria", up: "outcome + proof" },
        { down: "scoped research tasks", up: "findings + recommendations" },
      ]}
      foundation={
        foundation
          ? {
              title: "tmux-ide",
              sub: "Shared workspace",
              items: [
                { title: "Persistent panes", sub: "Independent agent processes" },
                { title: "Terminal messaging", sub: "send · wait · read output" },
                { title: "Live agent status", sub: "working · blocked · done · idle" },
                { title: "Human oversight", sub: "Watch · steer · jump in" },
              ],
            }
          : undefined
      }
      caption="A goal goes to an execution agent, which splits bounded questions across three researchers; findings and the finished outcome flow back up for review."
      reading={{
        lead: "Reading the figure.",
        text: "Each box is an agent process in its own pane, with the command it runs. Pairings are illustrative.",
      }}
    />
  );
}

export function ArchitectureFigure() {
  return (
    <AcademicFigure
      id="architecture-figure"
      kicker="Systems / Runtime architecture"
      title="tmux owns the processes."
      accent="tmux-ide adds the view."
      subtitle="Close the app or lose SSH; every agent keeps running in tmux."
      label="Ownership and data flow"
      number="6"
      legend={{ solid: "State & output", dashed: "Commands & input" }}
      levels={[
        {
          letter: "a",
          name: "Source of truth",
          note: {
            label: "Terminal truth",
            text: "tmux owns every process, pane and session, locally or over SSH.",
          },
          cards: [
            {
              cap: "tmux server",
              tag: "Local or SSH",
              name: "tmux",
              mono: "processes · PTYs · panes · layout",
              duty: "Persists with no client attached",
            },
          ],
        },
        {
          letter: "b",
          name: "Authority",
          note: {
            label: "One authority",
            text: "For the app and automation, the daemon is the only path to live tmux state.",
          },
          cards: [
            {
              cap: "tmux-ide daemon",
              tag: "Per machine",
              name: "Daemon",
              mono: "discovery · agent state · pane streams",
              duty: "Detects agents · publishes state",
            },
          ],
        },
        {
          letter: "c",
          name: "Clients",
          note: {
            label: "Many views",
            text: "The app and automation act through the daemon; plain tmux clients still attach directly.",
          },
          cards: [
            {
              cap: "App",
              tag: "tmux-ide app",
              name: "Home · Terminals",
              duty: "Agents across machines",
            },
            {
              cap: "Automation",
              tag: "CLI · MCP · SDK",
              name: "Agents & scripts",
              duty: "Reads · sends · events",
            },
          ],
        },
      ]}
      links={[
        { down: "panes · output · layout", up: "tmux commands" },
        { down: "sessions · agent state · streams", up: "typed commands & input" },
      ]}
      foundation={{
        title: "tmux",
        sub: "Ordinary sessions",
        items: [
          { title: "Plain clients", sub: "tmux attach still works" },
          {
            title: "Connect over SSH",
            sub: "Same sessions, any machine",
            href: "/docs/remote-machines",
          },
          { title: "Durable", sub: "Close the app; agents run" },
          {
            title: "Restore sessions",
            sub: "Rebuild after a tmux crash",
            href: "/docs/restore-resume",
          },
        ],
      }}
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
    <AcademicFigure
      id={id}
      heading="h3"
      kicker="Systems / Agent detection"
      title="Two layers,"
      accent="one status."
      label="How a pane gets its agent status"
      number="1"
      compact
      legend={{ solid: "Status flow" }}
      levels={[
        {
          letter: "a",
          name: "Authority",
          note: {
            label: "Ground truth",
            text: "A fresh @agent_state stamp from Claude Code hooks or any agent always wins and goes straight to the status.",
          },
          cards: [
            {
              cap: "Self-report",
              tag: "Pane option",
              name: "@agent_state",
              mono: "working | blocked | done | idle",
              duty: "Stamped by hooks or the agent itself",
            },
          ],
        },
        {
          letter: "b",
          name: "Fallback",
          note: {
            label: "Inference",
            text: "With no stamp, or one older than 10 minutes, tmux-ide finds the real agent and reads its screen.",
          },
          cards: [
            {
              cap: "Process tree",
              name: "Agent process",
              mono: "pane_pid → agent",
              duty: "Finds the agent under the shell",
            },
            {
              cap: "Screen manifests",
              name: "Visible output",
              mono: "rule set per agent",
              duty: "Infers working, blocked or done",
            },
          ],
        },
        {
          letter: "c",
          name: "Status",
          note: {
            label: "Everywhere",
            text: "The same status drives Home, pane headers, the chrome and team --json.",
          },
          cards: [
            {
              cap: "Agent status",
              name: "Working · Blocked · Done · Idle",
              duty: "Explain any pane with tmux-ide agent explain",
            },
          ],
        },
      ]}
      links={[{ down: "no fresh stamp" }, { down: "inferred state" }]}
      caption="A pane's status comes from its own fresh self-report when there is one; otherwise from its process tree and visible output, matched against per-agent manifests."
    />
  );
}
