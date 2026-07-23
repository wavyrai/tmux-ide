/**
 * The fleet catalog — a read-only, path-free enumeration of the user's live
 * tmux fleet (every adopted session and the coding agents inside it), whether or
 * not the desktop app created the session. It exists so the desktop can SEE the
 * fleet before any attachment or promotion machinery exists; nothing here is an
 * attachment authority.
 *
 * Identity discipline (mirrors {@link ./agent-graph-overlay.ts} and
 * {@link ./semantic-identity.ts}):
 * - `sessionId`/`agentId` are opaque, prefix-namespaced tokens minted by the
 *   daemon from a hash digest (`session.<token>` / `agent.<token>`). The token
 *   grammar structurally rejects raw tmux ids (`$3`, `%7`), names with spaces,
 *   and filesystem paths — none of those can ever be a catalog id.
 * - `projectLabel` is a directory BASENAME, never a path: slashes are rejected.
 * - Every human label is bounded and control-character-free.
 *
 * No field here carries a runtime pane id, a session name, an absolute path, or
 * any attachability flag. Fleet nodes are display-only by construction; see
 * {@link projectFleetAgentGraphOverlay}, whose node ids are the reserved,
 * non-attachable `terminal.discovered.` identity form.
 */
import { z } from "zod";

import {
  AGENT_GRAPH_LABEL_MAX_LENGTH,
  AgentGraphStatusSourceSchemaZ,
} from "./agent-graph-overlay.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { AgentActivitySchemaZ } from "./pane-appearance.ts";

export const FLEET_CATALOG_RESOURCE_VERSION = 1 as const;

/** Fleet-scale caps, exported so producers can pre-trim before projecting. */
export const FLEET_MAX_SESSIONS = 64;
export const FLEET_MAX_AGENTS_PER_SESSION = 64;
export const FLEET_MAX_TOTAL_AGENTS = 256;
export const FLEET_MAX_PANES_PER_SESSION = 512;
/**
 * Labels are bounded to the agent-graph label length so a session label or agent
 * name always projects cleanly into an overlay node/group label (see
 * {@link ./fleet-agent-graph.ts}); it is never a partial, truncated projection.
 */
export const FLEET_LABEL_MAX_LENGTH = AGENT_GRAPH_LABEL_MAX_LENGTH;
/** Opaque id token window (matches the workspace / agent-graph identity idiom). */
export const FLEET_ID_TOKEN_MIN = 16;
export const FLEET_ID_TOKEN_MAX = 64;

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Every code point is printable and non-DEL (rejects NUL, ESC, tab, newline, bell, DEL). */
function isControlFree(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

function namespacedIdSchema(namespace: "session" | "agent"): z.ZodType<string> {
  return z
    .string()
    .max(`${namespace}.`.length + FLEET_ID_TOKEN_MAX)
    .regex(
      new RegExp(
        `^${namespace}\\.[A-Za-z0-9_-]{${FLEET_ID_TOKEN_MIN},${FLEET_ID_TOKEN_MAX}}$`,
        "u",
      ),
    )
    .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
}

/**
 * Opaque session identity, `session.` followed by a hash token. Deliberately
 * cannot be a raw tmux session id (`$3`), a session name with a space, or a path.
 */
export const FleetSessionIdSchemaZ = namespacedIdSchema("session");
export type FleetSessionId = z.infer<typeof FleetSessionIdSchemaZ>;

/** Opaque agent identity, `agent.` followed by a hash token (same discipline). */
export const FleetAgentIdSchemaZ = namespacedIdSchema("agent");
export type FleetAgentId = z.infer<typeof FleetAgentIdSchemaZ>;

/** A bounded, control-character-free display label. */
export const FleetLabelSchemaZ = z
  .string()
  .min(1)
  .max(FLEET_LABEL_MAX_LENGTH)
  .refine(isControlFree, "label contains control characters");
export type FleetLabel = z.infer<typeof FleetLabelSchemaZ>;

/**
 * A project label is a directory BASENAME, never a path: control characters and
 * path separators (`/`, `\`) are rejected so an absolute or relative path can
 * never be smuggled through this field.
 */
export const FleetProjectLabelSchemaZ = z
  .string()
  .min(1)
  .max(FLEET_LABEL_MAX_LENGTH)
  .refine(isControlFree, "project label contains control characters")
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "project label must be a basename, not a path",
  );
export type FleetProjectLabel = z.infer<typeof FleetProjectLabelSchemaZ>;

/** The agent harness, aligned with the desktop sidebar's harness enum. */
export const FLEET_AGENT_HARNESS_IDS = ["codex", "claude-code", "custom"] as const;
export const FleetAgentHarnessSchemaZ = z.enum(FLEET_AGENT_HARNESS_IDS);
export type FleetAgentHarness = z.infer<typeof FleetAgentHarnessSchemaZ>;

/**
 * One agent inside a fleet session. `activity`/`statusSource` reuse the existing
 * contract enums — there is one status language across the product. This record
 * carries no pane id and no attachability.
 */
export const FleetCatalogAgentEntryV1SchemaZ = z
  .object({
    agentId: FleetAgentIdSchemaZ,
    name: FleetLabelSchemaZ,
    harness: FleetAgentHarnessSchemaZ,
    activity: AgentActivitySchemaZ,
    attention: z.boolean(),
    statusSource: AgentGraphStatusSourceSchemaZ,
  })
  .strict();
export type FleetCatalogAgentEntryV1 = z.infer<typeof FleetCatalogAgentEntryV1SchemaZ>;

/** One session in the fleet, with its agents. Agent ids are unique within it. */
export const FleetCatalogSessionEntryV1SchemaZ = z
  .object({
    sessionId: FleetSessionIdSchemaZ,
    label: FleetLabelSchemaZ,
    projectLabel: FleetProjectLabelSchemaZ,
    appCreated: z.boolean(),
    paneCount: z.number().int().nonnegative().max(FLEET_MAX_PANES_PER_SESSION),
    agents: z.array(FleetCatalogAgentEntryV1SchemaZ).max(FLEET_MAX_AGENTS_PER_SESSION),
  })
  .strict();
export type FleetCatalogSessionEntryV1 = z.infer<typeof FleetCatalogSessionEntryV1SchemaZ>;

/**
 * The generation-stamped, read-only fleet catalog. Schema-level invariants:
 * - session ids are unique, agent ids are unique across the whole fleet;
 * - the total agent count stays within {@link FLEET_MAX_TOTAL_AGENTS}.
 */
export const FleetCatalogResourceV1SchemaZ = z
  .object({
    version: z.literal(FLEET_CATALOG_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    sessions: z.array(FleetCatalogSessionEntryV1SchemaZ).max(FLEET_MAX_SESSIONS),
  })
  .strict()
  .superRefine((resource, ctx) => {
    const sessionIds = new Set<string>();
    const agentIds = new Set<string>();
    let totalAgents = 0;
    for (const [sessionIndex, session] of resource.sessions.entries()) {
      if (sessionIds.has(session.sessionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "session ids must be unique",
          path: ["sessions", sessionIndex, "sessionId"],
        });
      }
      sessionIds.add(session.sessionId);

      for (const [agentIndex, agent] of session.agents.entries()) {
        if (agentIds.has(agent.agentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "agent ids must be unique across the fleet",
            path: ["sessions", sessionIndex, "agents", agentIndex, "agentId"],
          });
        }
        agentIds.add(agent.agentId);
      }
      totalAgents += session.agents.length;
    }
    if (totalAgents > FLEET_MAX_TOTAL_AGENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fleet total agent limit exceeded",
        path: ["sessions"],
      });
    }
  });
export type FleetCatalogResourceV1 = z.infer<typeof FleetCatalogResourceV1SchemaZ>;
