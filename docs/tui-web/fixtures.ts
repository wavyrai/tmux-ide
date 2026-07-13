/**
 * The fake fleet. This is the ONLY invented part of the demo — the app's real
 * data layer is tmux control mode, which has no browser equivalent.
 *
 * It emits exactly what the real fleet report flattens into (AgentRowInput), so
 * the components downstream cannot tell the difference. Agents walk the same
 * lifecycle the Claude Code hooks stamp: working → blocked (needs you) → done →
 * idle, and back.
 */
import type { AgentStatus } from "@daemon/tui/detect/classify.ts";
import type { AgentRowInput } from "@daemon/tui/mirror/agent-rows.ts";

export interface FleetSession {
  name: string;
  status: AgentStatus;
}

/** Each agent walks its own loop, offset so the sidebar is never uniform. */
const SCRIPT: ReadonlyArray<{
  paneId: string;
  session: string;
  kind: string;
  /** [state, seconds to dwell] — the loop this agent repeats. */
  beats: ReadonlyArray<[AgentStatus, number]>;
}> = [
  {
    paneId: "%1",
    session: "api",
    kind: "claude",
    beats: [
      ["working", 9],
      ["blocked", 7],
      ["working", 6],
      ["done", 5],
    ],
  },
  {
    paneId: "%2",
    session: "web",
    kind: "claude",
    beats: [
      ["working", 14],
      ["done", 6],
      ["idle", 4],
    ],
  },
  {
    paneId: "%3",
    session: "infra",
    kind: "codex",
    beats: [
      ["working", 5],
      ["working", 8],
      ["blocked", 9],
      ["done", 4],
    ],
  },
  {
    paneId: "%4",
    session: "docs",
    kind: "claude",
    beats: [
      ["idle", 8],
      ["working", 11],
      ["done", 5],
    ],
  },
];

/** Where each agent is in its loop at time t — and how long it's been there,
 *  which is what `agentAgeLabel` renders on hover. */
export function agentsAt(nowSec: number, startSec: number): AgentRowInput[] {
  return SCRIPT.map((a, i) => {
    const cycle = a.beats.reduce((n, [, secs]) => n + secs, 0);
    // Offset each agent so they don't flip in lockstep.
    const t = (nowSec - startSec + i * 7) % cycle;
    let acc = 0;
    for (const [state, secs] of a.beats) {
      if (t < acc + secs) {
        return {
          paneId: a.paneId,
          windowIndex: 0,
          session: a.session,
          kind: a.kind,
          state,
          since: Math.floor(nowSec - (t - acc)),
        };
      }
      acc += secs;
    }
    /* c8 ignore next */
    throw new Error("unreachable: t is always inside the cycle");
  });
}

/** A session's status is its most-attention-worthy agent — the same rollup rule
 *  the real sidebar applies to a session row. */
export function fleetAt(agents: readonly AgentRowInput[]): FleetSession[] {
  const RANK: AgentStatus[] = ["blocked", "working", "done", "idle", "unknown"];
  const names = ["api", "web", "infra", "docs"];
  return names.map((name) => {
    const mine = agents.filter((a) => a.session === name);
    const status = RANK.find((s) => mine.some((a) => a.state === s)) ?? ("idle" as AgentStatus);
    return { name, status };
  });
}
