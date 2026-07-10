/**
 * The v1 verb handlers — each one a THIN adapter from validated params to
 * the SAME data-layer functions the CLI cases call (report/sessions/wait/
 * send/agent-explain/lifecycle). No fleet logic lives here; if a verb needs
 * logic a CLI case has inline, the logic moves to the data layer and both
 * point at it (that's how `wait` and `send` got their shared cores).
 */
import {
  agentsParamsSchema,
  explainParamsSchema,
  restartAgentParamsSchema,
  sendParamsSchema,
  spawnParamsSchema,
  stopAgentParamsSchema,
  waitParamsSchema,
} from "@tmux-ide/contracts";
import type { ZodType } from "zod";
import { buildReport } from "../agent-explain.ts";
import { deliverMessage } from "../send.ts";
import type { StatusTracker } from "../tui/detect/classify.ts";
import { toFleetJson } from "../tui/team/report.ts";
import { listTeamProjects } from "../tui/team/projects.ts";
import { listTeamSessions } from "../tui/team/sessions.ts";
import { waitForAgentStatus, waitForOutputMatch } from "../tui/team/wait.ts";
import { ControlVerbError, type VerbHandler } from "./dispatch.ts";
import { resolveLaunchCommand, restartAgent, spawnAgent, stopAgent } from "./lifecycle.ts";

/** Validate `params` against a verb's schema, or answer `bad-request`. */
function parse<T>(schema: ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    throw new ControlVerbError("bad-request", `invalid params${at}: ${issue?.message ?? "?"}`);
  }
  return result.data;
}

/**
 * Build the handler map. `tracker` is the server's ONE persistent status
 * tracker (shared with the event tick) so `fleet`/`agents` see the
 * cross-tick `done` transition exactly like the chrome updater does —
 * a fresh tracker per call could never observe working→idle.
 */
export function createVerbHandlers(ctx: { tracker: StatusTracker }): Record<string, VerbHandler> {
  return {
    fleet: () => toFleetJson(listTeamProjects(ctx.tracker)),

    agents: (params) => {
      const p = parse(agentsParamsSchema, params);
      const sessions = listTeamSessions(ctx.tracker);
      const scoped = p.session ? sessions.filter((s) => s.name === p.session) : sessions;
      if (p.session && scoped.length === 0) {
        throw new ControlVerbError("not-found", `no session "${p.session}"`);
      }
      return { agents: scoped.flatMap((s) => s.agents ?? []) };
    },

    send: (params) => {
      const p = parse(sendParamsSchema, params);
      return deliverMessage(p);
    },

    wait: async (params) => {
      const p = parse(waitParamsSchema, params);
      if (p.kind === "output") {
        try {
          new RegExp(p.match);
        } catch (err) {
          throw new ControlVerbError(
            "bad-request",
            `invalid match regex: ${(err as Error).message}`,
          );
        }
      }
      const result =
        p.kind === "agent-status"
          ? await waitForAgentStatus(p.session, p.status, { timeoutMs: p.timeoutMs })
          : await waitForOutputMatch(p.target, p.match, { timeoutMs: p.timeoutMs });
      if (!result.ok) {
        const what =
          p.kind === "agent-status"
            ? `"${p.session}" to reach status "${p.status}"`
            : `${p.target} output to match /${p.match}/`;
        throw new ControlVerbError(
          "timeout",
          `timed out after ${result.timedOutAfterMs}ms waiting for ${what}`,
        );
      }
      return result;
    },

    spawn: (params) => {
      const p = parse(spawnParamsSchema, params);
      return spawnAgent({ ...p, command: resolveLaunchCommand(p) });
    },

    "restart-agent": (params) => {
      const p = parse(restartAgentParamsSchema, params);
      return restartAgent(p.paneId, resolveLaunchCommand(p));
    },

    "stop-agent": (params) => {
      const p = parse(stopAgentParamsSchema, params);
      return stopAgent(p.paneId);
    },

    explain: (params) => {
      const p = parse(explainParamsSchema, params);
      return buildReport(p.target);
    },

    subscribe: (_params, verbCtx) => {
      verbCtx.subscribe();
      return { subscribed: true, events: ["agent-status"] };
    },
  };
}
