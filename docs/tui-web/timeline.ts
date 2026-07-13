/**
 * The scene: a project with a TEAM of agents inside it, handing work to each
 * other with `tmux-ide send`.
 *
 * This is the one invented part of the demo — the app's real data layer is tmux
 * control mode, which has no browser equivalent. Everything it emits is shaped
 * exactly like the real fleet report (AgentRowInput), and the story it tells is
 * the product's real mechanism, not a metaphor:
 *
 *   `tmux-ide send <target> <message>` resolves a pane in a session and types
 *   the message into it. The receiving agent's own lifecycle hooks then stamp
 *   @agent_state, which is what flips the glyph in the sidebar. Nothing here
 *   invents a message bus — the terminal IS the bus.
 *
 * PURE: state is a function of elapsed seconds, so the scene is scrubbable,
 * loopable, and testable without a clock.
 */
import type { AgentStatus } from "@daemon/tui/detect/classify.ts";
import type { AgentRowInput } from "@daemon/tui/mirror/agent-rows.ts";

/** One project's session, with the whole team living in it. */
export const SESSION = "checkout-api";
/** A second project, so the fleet reads as more than one thing at once. */
export const SESSION_B = "marketing-site";

export interface ScenePane {
  paneId: string;
  kind: string;
  /** Terminal lines visible so far. The last one may be mid-type. */
  lines: string[];
  state: AgentStatus;
  /** Self-reported one-liner — the real @agent_status_text contract. */
  statusText?: string;
}

export interface SceneState {
  panes: ScenePane[];
  /** Every agent in the fleet, both projects — what the sidebar renders. */
  agents: AgentRowInput[];
  /** `tmux-ide events --follow` lines, newest last. */
  events: string[];
  /** 0–1 through the loop, for the progress bar. */
  progress: number;
}

/** A line lands whole at `at`, unless `type` — then it types out over 1.6s, the
 *  way a real command appears as an agent runs it. */
interface Line {
  pane: string;
  at: number;
  text: string;
  typed?: boolean;
}

/** A state stamp: at `at`, this pane's agent becomes `state`. */
interface Stamp {
  pane: string;
  at: number;
  state: AgentStatus;
  statusText?: string;
  /** The events stream line this transition emits. */
  event?: string;
}

const CODEX = "%1";
const CLAUDE = "%2";
const CURSOR = "%3";

export const PANE_KIND: Record<string, string> = {
  [CODEX]: "codex",
  [CLAUDE]: "claude",
  [CURSOR]: "cursor",
};

/** How long the loop runs before it restarts. */
export const CYCLE = 30;
const TYPE_SECS = 1.6;

const LINES: Line[] = [
  { pane: CODEX, at: 0.5, text: "› migrating the payments schema…" },
  { pane: CODEX, at: 2.0, text: "  ✓ 14 files, 3 migrations written" },
  // The handoff: codex asks claude to review. THE product mechanism, on screen.
  {
    pane: CODEX,
    at: 4.0,
    text: '$ tmux-ide send claude "review the schema migration"',
    typed: true,
  },
  { pane: CODEX, at: 6.2, text: '  Sent to "claude" (%2)' },

  { pane: CLAUDE, at: 6.6, text: "› review the schema migration" },
  { pane: CLAUDE, at: 8.0, text: "  reading migrations/0014_payments.sql…" },
  { pane: CLAUDE, at: 10.5, text: "  ⚠ dropping `orders.total` loses data" },
  { pane: CLAUDE, at: 12.0, text: "  Ship it anyway, or write a backfill?" },

  // Blocked → the human answers → claude hands the follow-up to cursor.
  { pane: CLAUDE, at: 17.0, text: "› write the backfill" },
  { pane: CLAUDE, at: 18.4, text: "  ✓ backfill + rollback written" },
  {
    pane: CLAUDE,
    at: 20.0,
    text: '$ tmux-ide send cursor "add tests for the backfill"',
    typed: true,
  },
  { pane: CLAUDE, at: 22.2, text: '  Sent to "cursor" (%3)' },

  { pane: CURSOR, at: 22.6, text: "› add tests for the backfill" },
  { pane: CURSOR, at: 24.5, text: "  writing tests/backfill.spec.ts…" },
  { pane: CURSOR, at: 27.0, text: "  ✓ 6 passing" },
];

const STAMPS: Stamp[] = [
  { pane: CODEX, at: 0, state: "working", statusText: "payments schema" },
  { pane: CLAUDE, at: 0, state: "idle" },
  { pane: CURSOR, at: 0, state: "idle" },

  { pane: CODEX, at: 6.2, state: "done", event: "codex · done" },
  // The message landing IS what starts claude — its hooks stamp working.
  {
    pane: CLAUDE,
    at: 6.6,
    state: "working",
    statusText: "reviewing migration",
    event: "claude · working",
  },
  // It needs a human decision: the attention state.
  {
    pane: CLAUDE,
    at: 12.0,
    state: "blocked",
    statusText: "needs a decision",
    event: "claude · blocked",
  },
  {
    pane: CLAUDE,
    at: 17.0,
    state: "working",
    statusText: "writing backfill",
    event: "claude · working",
  },
  { pane: CLAUDE, at: 22.2, state: "done", event: "claude · done" },
  {
    pane: CURSOR,
    at: 22.6,
    state: "working",
    statusText: "backfill tests",
    event: "cursor · working",
  },
  { pane: CURSOR, at: 27.0, state: "done", event: "cursor · done" },
];

/** The other project's agents — steady background, so the fleet reads as a fleet
 *  and the sidebar shows more than one project's team. */
function backgroundAgents(t: number, now: number): AgentRowInput[] {
  const flip = t % CYCLE < CYCLE / 2;
  return [
    {
      paneId: "%7",
      windowIndex: 0,
      session: SESSION_B,
      kind: "claude",
      state: flip ? "working" : "done",
      since: Math.floor(now - (t % (CYCLE / 2))),
      statusText: flip ? "og images" : undefined,
    },
    {
      paneId: "%8",
      windowIndex: 0,
      session: SESSION_B,
      kind: "codex",
      state: "idle",
      since: Math.floor(now - t),
    },
  ];
}

function typedText(line: Line, t: number): string {
  if (!line.typed) return line.text;
  const frac = Math.min(1, (t - line.at) / TYPE_SECS);
  const shown = line.text.slice(0, Math.ceil(line.text.length * frac));
  // A caret while it types — the same tell a real terminal gives.
  return frac < 1 ? shown + "▌" : line.text;
}

/** The scene at elapsed second `t`. `now` is epoch seconds (for age labels). */
export function sceneAt(t: number, now: number): SceneState {
  const at = ((t % CYCLE) + CYCLE) % CYCLE;

  const panes: ScenePane[] = [CODEX, CLAUDE, CURSOR].map((paneId) => {
    const stamp = STAMPS.filter((s) => s.pane === paneId && s.at <= at).pop();
    return {
      paneId,
      kind: PANE_KIND[paneId]!,
      state: stamp?.state ?? "idle",
      statusText: stamp?.statusText,
      lines: LINES.filter((l) => l.pane === paneId && l.at <= at).map((l) => typedText(l, at)),
    };
  });

  const agents: AgentRowInput[] = [
    ...panes.map((p) => {
      const stamp = STAMPS.filter((s) => s.pane === p.paneId && s.at <= at).pop();
      return {
        paneId: p.paneId,
        windowIndex: 0,
        session: SESSION,
        kind: p.kind,
        state: p.state,
        // `since` is when the CURRENT state was stamped — that's what makes the
        // sidebar's hover age ("blocked 6s") tick truthfully.
        since: Math.floor(now - (at - (stamp?.at ?? 0))),
        statusText: p.statusText,
      };
    }),
    ...backgroundAgents(t, now),
  ];

  const events = STAMPS.filter((s) => s.event && s.at <= at)
    .slice(-4)
    .map((s) => `${s.event}`);

  return { panes, agents, events, progress: at / CYCLE };
}
