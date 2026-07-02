/**
 * Serialization + lookup for the team control API.
 *
 * The team TUI's data layer (`projects.ts` / `sessions.ts`) produces the rich
 * `TeamProject` / `TeamSession` models the cockpit navigates. This module is
 * the CLI-facing counterpart: two PURE functions that shape that model into a
 * stable JSON contract (`tmux-ide team --json`) and answer a single-session
 * status lookup (`tmux-ide wait agent-status`). Kept OpenTUI-free so the CLI
 * can import it without pulling in the renderer.
 */
import type { AgentStatus } from "../detect/classify.ts";
import type { TeamProject } from "./projects.ts";
import type { TeamSession } from "./sessions.ts";

/** The stable JSON shape emitted by `tmux-ide team --json`. */
export interface FleetJson {
  projects: Array<{
    name: string;
    dir: string | null;
    registered: boolean;
    running: boolean;
    status: AgentStatus;
    sessions: Array<{
      name: string;
      status: AgentStatus;
      panes: number;
      attached: boolean;
      windows: Array<{
        index: number;
        name: string;
        active: boolean;
        panes: number;
        status: AgentStatus;
      }>;
    }>;
  }>;
}

/** Map the rich project model to the plain JSON contract — PURE. */
export function toFleetJson(projects: TeamProject[]): FleetJson {
  return {
    projects: projects.map((p) => ({
      name: p.name,
      dir: p.dir,
      registered: p.registered,
      running: p.running,
      status: p.status,
      sessions: p.sessions.map((s) => ({
        name: s.name,
        status: s.status,
        panes: s.panes,
        attached: s.attached,
        windows: (s.windowList ?? []).map((w) => ({
          index: w.index,
          name: w.name,
          active: w.active,
          panes: w.panes,
          status: w.status,
        })),
      })),
    })),
  };
}

/**
 * Look up a single session's status by name — PURE. Returns the status of the
 * matching session, or `null` when no session by that name is present (it may
 * not exist yet, which `wait` treats as "keep polling").
 */
export function findSessionStatus(sessions: TeamSession[], name: string): AgentStatus | null {
  const match = sessions.find((s) => s.name === name);
  return match ? match.status : null;
}
