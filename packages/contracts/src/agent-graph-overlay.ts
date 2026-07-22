/**
 * The agent-graph overlay — a RUNTIME (non-durable) projection of the fleet
 * onto the desktop canvas: agent windows carrying a ground-truth status glyph,
 * directed edges (a PM or mission that spawned a subagent), and labeled mission
 * groups.
 *
 * This overlay is derived every frame from live detection and is never
 * persisted. Durable window geometry lives in AppWindowDocumentV1
 * (`app-window-state.ts`); nothing here carries a position, viewport, or
 * on-disk revision. Nodes are keyed by the SAME durable AppWindow / terminal
 * source ids the canvas uses, so a raw tmux `%pane_id`, a session name with a
 * space, or an absolute path can never key a node (see {@link AppWindowIdSchemaZ}).
 */
import { z } from "zod";
import { AppWindowIdSchemaZ } from "./app-window-state.ts";
import type { AgentActivity, CanonicalDomainStatus } from "./pane-appearance.ts";

/** Bounded fleet caps. Exported so producers can pre-trim before projecting. */
export const AGENT_GRAPH_MAX_NODES = 256;
export const AGENT_GRAPH_MAX_EDGES = 512;
export const AGENT_GRAPH_MAX_GROUPS = 64;
export const AGENT_GRAPH_MAX_GROUP_MEMBERS = 256;
export const AGENT_GRAPH_LABEL_MAX_LENGTH = 120;
/** Opaque group-id token length window (matches the workspace identity idiom). */
export const AGENT_GRAPH_GROUP_TOKEN_MIN = 16;
export const AGENT_GRAPH_GROUP_TOKEN_MAX = 64;

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Every code point is a printable, non-DEL character (rejects NUL, ESC, tab, newline, bell, DEL). */
function isControlFree(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

/** A bounded, control-char-free display label. */
export const AgentGraphLabelSchemaZ = z
  .string()
  .min(1)
  .max(AGENT_GRAPH_LABEL_MAX_LENGTH)
  .refine(isControlFree, "label contains control characters");
export type AgentGraphLabel = z.infer<typeof AgentGraphLabelSchemaZ>;

/**
 * Opaque, prefixed mission-group identity. A group id is issued by the
 * projector and deliberately cannot be a pane id, a session name, or a path —
 * it is `group.` followed by an opaque token.
 */
export const AgentGraphGroupIdSchemaZ = z
  .string()
  .max("group.".length + AGENT_GRAPH_GROUP_TOKEN_MAX)
  .regex(
    new RegExp(
      `^group\\.[A-Za-z0-9_-]{${AGENT_GRAPH_GROUP_TOKEN_MIN},${AGENT_GRAPH_GROUP_TOKEN_MAX}}$`,
      "u",
    ),
  )
  .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
export type AgentGraphGroupId = z.infer<typeof AgentGraphGroupIdSchemaZ>;

/** The four ground-truth agent states a node can settle into on the canvas. */
export const AgentGraphNodeStatusSchemaZ = z.enum(["working", "blocked", "done", "idle"]);
export type AgentGraphNodeStatus = z.infer<typeof AgentGraphNodeStatusSchemaZ>;

/** Where a node's status came from: an authority stamp, screen scraping, or neither. */
export const AgentGraphStatusSourceSchemaZ = z.enum(["authority", "scrape", "unknown"]);
export type AgentGraphStatusSource = z.infer<typeof AgentGraphStatusSourceSchemaZ>;

/** A relation between two agent windows. */
export const AgentGraphEdgeKindSchemaZ = z.enum(["spawned", "mission"]);
export type AgentGraphEdgeKind = z.infer<typeof AgentGraphEdgeKindSchemaZ>;

/** One agent window on the canvas, keyed by its durable AppWindow id. */
export const AgentGraphNodeSchemaZ = z
  .object({
    windowId: AppWindowIdSchemaZ,
    status: AgentGraphNodeStatusSchemaZ,
    statusSource: AgentGraphStatusSourceSchemaZ,
    attention: z.boolean(),
    label: AgentGraphLabelSchemaZ.nullable(),
  })
  .strict();
export type AgentGraphNode = z.infer<typeof AgentGraphNodeSchemaZ>;

/** A directed relation; `from`/`to` reference node ids (validated in the overlay refine). */
export const AgentGraphEdgeSchemaZ = z
  .object({
    from: AppWindowIdSchemaZ,
    to: AppWindowIdSchemaZ,
    kind: AgentGraphEdgeKindSchemaZ,
  })
  .strict();
export type AgentGraphEdge = z.infer<typeof AgentGraphEdgeSchemaZ>;

/** A labeled mission group whose members are node ids. */
export const AgentGraphGroupSchemaZ = z
  .object({
    id: AgentGraphGroupIdSchemaZ,
    label: AgentGraphLabelSchemaZ,
    memberWindowIds: z.array(AppWindowIdSchemaZ).max(AGENT_GRAPH_MAX_GROUP_MEMBERS),
  })
  .strict();
export type AgentGraphGroup = z.infer<typeof AgentGraphGroupSchemaZ>;

const AgentGraphOverlayShapeSchemaZ = z
  .object({
    /** Nodes keyed by their durable window id; the record key must equal `node.windowId`. */
    nodes: z.record(AppWindowIdSchemaZ, AgentGraphNodeSchemaZ),
    edges: z.array(AgentGraphEdgeSchemaZ).max(AGENT_GRAPH_MAX_EDGES),
    groups: z.array(AgentGraphGroupSchemaZ).max(AGENT_GRAPH_MAX_GROUPS),
  })
  .strict();

/**
 * The validated agent-graph overlay. Schema-level invariants:
 * - node record keys match their `windowId`, and node count stays within the cap;
 * - every edge references two existing nodes and is never a self-edge;
 * - group ids are unique, and every group member is an existing, non-repeated node.
 */
export const AgentGraphOverlaySchemaZ = AgentGraphOverlayShapeSchemaZ.superRefine(
  (overlay, ctx) => {
    const nodeEntries = Object.entries(overlay.nodes);
    if (nodeEntries.length > AGENT_GRAPH_MAX_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent graph node limit exceeded",
        path: ["nodes"],
      });
    }
    for (const [key, node] of nodeEntries) {
      if (key !== node.windowId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "node record key must match windowId",
          path: ["nodes", key, "windowId"],
        });
      }
    }
    const nodeIds = new Set(nodeEntries.map(([key]) => key));

    for (const [index, edge] of overlay.edges.entries()) {
      if (edge.from === edge.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "edge must not be a self-edge",
          path: ["edges", index],
        });
      }
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "edge references an unknown node",
          path: ["edges", index, "from"],
        });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "edge references an unknown node",
          path: ["edges", index, "to"],
        });
      }
    }

    const groupIds = new Set<string>();
    for (const [index, group] of overlay.groups.entries()) {
      if (groupIds.has(group.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "group ids must be unique",
          path: ["groups", index, "id"],
        });
      }
      groupIds.add(group.id);

      const seenMembers = new Set<string>();
      for (const [memberIndex, memberId] of group.memberWindowIds.entries()) {
        if (!nodeIds.has(memberId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "group member must be an existing node",
            path: ["groups", index, "memberWindowIds", memberIndex],
          });
        }
        if (seenMembers.has(memberId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "group member ids must be unique",
            path: ["groups", index, "memberWindowIds", memberIndex],
          });
        }
        seenMembers.add(memberId);
      }
    }
  },
);
export type AgentGraphOverlay = z.infer<typeof AgentGraphOverlaySchemaZ>;

/**
 * The detection status a node can be derived from. This is the daemon detect
 * layer's status union (`packages/daemon/src/tui/detect/classify.ts`), including
 * `unknown` — the projector narrows it to the four canvas states, but the
 * status→appearance mapping below reasons over the full union.
 */
export type AgentGraphDetectStatus = AgentGraphNodeStatus | "unknown";

/** Input to {@link resolveAgentStatusPresentation}: a detect status plus staleness. */
export interface AgentStatusPresentationInput {
  readonly status: AgentGraphDetectStatus;
  /**
   * The authority stamp is stale (working/blocked past the staleness window in
   * `classify.ts`). `done`/`idle` are terminal and never go stale, so this only
   * changes the outcome for `working`/`blocked`.
   */
  readonly stale: boolean;
}

/** The renderer-facing appearance a detect status maps to. */
export interface AgentStatusPresentation {
  /** The sidebar agent enum (`AGENT_ACTIVITY_IDS`). */
  readonly activity: AgentActivity;
  /** The pane-appearance domain-status enum (`CANONICAL_DOMAIN_STATUS_IDS`). */
  readonly domainStatus: CanonicalDomainStatus;
  /** Whether the node is asking for attention. */
  readonly attention: boolean;
}

/**
 * The exhaustive fresh-status mapping table. Coherent with the renderer's
 * existing activity→domainStatus mapping (application-shell.tsx): running→running,
 * complete→done, disconnected→disconnected.
 *
 * | detect status | activity     | domainStatus  | attention |
 * | ------------- | ------------ | ------------- | --------- |
 * | working       | running      | running       | false     |
 * | blocked       | waiting      | blocked       | true      |
 * | done          | complete     | done          | false     |
 * | idle          | idle         | idle          | false     |
 * | unknown       | disconnected | disconnected  | false     |
 */
const FRESH_STATUS_PRESENTATION: Readonly<Record<AgentGraphDetectStatus, AgentStatusPresentation>> =
  Object.freeze({
    working: { activity: "running", domainStatus: "running", attention: false },
    blocked: { activity: "waiting", domainStatus: "blocked", attention: true },
    done: { activity: "complete", domainStatus: "done", attention: false },
    idle: { activity: "idle", domainStatus: "idle", attention: false },
    unknown: { activity: "disconnected", domainStatus: "disconnected", attention: false },
  });

/**
 * A stale `working`/`blocked` report means the agent (or its hook) probably died
 * mid-turn, so the node is shown as recovering rather than falsely active.
 */
const STALE_STATUS_PRESENTATION: AgentStatusPresentation = Object.freeze({
  activity: "disconnected",
  domainStatus: "recovering",
  attention: false,
});

/**
 * Map a detect status (+ staleness) to the renderer's activity and domain-status
 * enums. PURE, total, and exhaustive over the detect union.
 */
export function resolveAgentStatusPresentation(
  input: AgentStatusPresentationInput,
): AgentStatusPresentation {
  if (input.stale && (input.status === "working" || input.status === "blocked")) {
    return STALE_STATUS_PRESENTATION;
  }
  return FRESH_STATUS_PRESENTATION[input.status];
}

/** A node as handed to the projector — field-validated, but not yet cross-checked. */
export interface AgentGraphProjectionNode {
  readonly windowId: string;
  readonly status: AgentGraphNodeStatus;
  readonly statusSource: AgentGraphStatusSource;
  readonly attention: boolean;
  readonly label: string | null;
}

/** A relation as handed to the projector. */
export interface AgentGraphProjectionRelation {
  readonly from: string;
  readonly to: string;
  readonly kind: AgentGraphEdgeKind;
}

/** A group as handed to the projector. */
export interface AgentGraphProjectionGroup {
  readonly id: string;
  readonly label: string;
  readonly memberWindowIds: readonly string[];
}

export interface AgentGraphProjectionInput {
  readonly nodes: readonly AgentGraphProjectionNode[];
  readonly edges: readonly AgentGraphProjectionRelation[];
  readonly groups: readonly AgentGraphProjectionGroup[];
}

export interface AgentGraphProjectionResult {
  readonly overlay: AgentGraphOverlay;
  /** True when any cap forced honest truncation of the projected fleet. */
  readonly truncated: boolean;
}

/**
 * Fold already-field-validated inputs into a structurally valid overlay. PURE —
 * it DEGRADES rather than throwing:
 * - duplicate node ids collapse (first occurrence wins);
 * - edges are deduped, self-edges dropped, and any edge whose endpoint is not a
 *   surviving node is dropped;
 * - group members are deduped and restricted to surviving nodes; duplicate group
 *   ids collapse (first wins);
 * - every cap is enforced with an honest {@link AgentGraphProjectionResult.truncated}
 *   flag when trimming occurs.
 *
 * The returned overlay satisfies every {@link AgentGraphOverlaySchemaZ} invariant
 * by construction.
 */
export function projectAgentGraphOverlay(
  input: AgentGraphProjectionInput,
): AgentGraphProjectionResult {
  let truncated = false;

  const nodes: Record<string, AgentGraphNode> = {};
  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (nodeIds.has(node.windowId)) {
      truncated = true;
      continue;
    }
    if (nodeIds.size >= AGENT_GRAPH_MAX_NODES) {
      truncated = true;
      continue;
    }
    nodeIds.add(node.windowId);
    nodes[node.windowId] = {
      windowId: node.windowId,
      status: node.status,
      statusSource: node.statusSource,
      attention: node.attention,
      label: node.label,
    };
  }

  const edges: AgentGraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const edge of input.edges) {
    if (edge.from === edge.to) {
      truncated = true;
      continue;
    }
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      truncated = true;
      continue;
    }
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      truncated = true;
      continue;
    }
    if (edges.length >= AGENT_GRAPH_MAX_EDGES) {
      truncated = true;
      continue;
    }
    seenEdges.add(key);
    edges.push({ from: edge.from, to: edge.to, kind: edge.kind });
  }

  const groups: AgentGraphGroup[] = [];
  const seenGroupIds = new Set<string>();
  for (const group of input.groups) {
    if (seenGroupIds.has(group.id)) {
      truncated = true;
      continue;
    }
    if (groups.length >= AGENT_GRAPH_MAX_GROUPS) {
      truncated = true;
      continue;
    }
    const members: string[] = [];
    const seenMembers = new Set<string>();
    for (const memberId of group.memberWindowIds) {
      if (!nodeIds.has(memberId) || seenMembers.has(memberId)) {
        truncated = true;
        continue;
      }
      if (members.length >= AGENT_GRAPH_MAX_GROUP_MEMBERS) {
        truncated = true;
        continue;
      }
      seenMembers.add(memberId);
      members.push(memberId);
    }
    seenGroupIds.add(group.id);
    groups.push({ id: group.id, label: group.label, memberWindowIds: members });
  }

  return { overlay: { nodes, edges, groups }, truncated };
}
