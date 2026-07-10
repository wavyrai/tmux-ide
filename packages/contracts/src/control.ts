/**
 * The local control-socket protocol (M23.3) — newline-delimited JSON frames
 * over a Unix socket (`~/.tmux-ide/control.sock` by default). This is the
 * scriptable surface for agent loops: connect once, drive the fleet, get
 * events PUSHED instead of spawning a CLI per poll.
 *
 * Every frame is one JSON object on one line. Three frame shapes:
 *
 *   request   {v:1, id, verb, params?}          client → server
 *   response  {v:1, id, ok, data|error}         server → client (id-correlated)
 *   event     {v:1, event, data}                server → client (after `subscribe`)
 *
 * The envelope is VERSIONED from day one (`v: 1`) and `verb` is an open
 * string in the envelope (unknown verbs are answered with an `unknown-verb`
 * error, not a parse failure) so a v2 can add verbs without breaking v1
 * clients. The future native-app bridge (#90) layers on mechanically: each
 * NDJSON frame maps 1:1 to a WebSocket text message — id correlation and the
 * unsolicited event channel already match WS semantics, so the bridge is a
 * transport swap, not a protocol change.
 *
 * Params schemas are per-verb and STRICT about types but tolerant of absence
 * (`params` may be omitted for verbs that need none).
 */
import { z } from "zod";

/** The protocol version every frame carries. Bump only on breaking changes. */
export const CONTROL_PROTOCOL_VERSION = 1;

/** Request ids are client-chosen; responses echo them verbatim. */
export const controlIdSchema = z.union([z.string(), z.number()]);
export type ControlId = z.infer<typeof controlIdSchema>;

/** The agent statuses the detection layer produces (mirrors the daemon's `AgentStatus`). */
export const agentStatusSchema = z.enum(["blocked", "working", "done", "idle", "unknown"]);
export type ControlAgentStatus = z.infer<typeof agentStatusSchema>;

/** The verbs a v1 server understands (dispatch also answers unknown strings honestly). */
export const CONTROL_VERBS = [
  "fleet",
  "agents",
  "send",
  "wait",
  "spawn",
  "restart-agent",
  "stop-agent",
  "explain",
  "subscribe",
] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

/**
 * The request envelope. `verb` stays an open string here — verb existence is
 * a DISPATCH concern (answered with `unknown-verb`), not a parse failure, so
 * newer clients get an honest error from an older server.
 */
export const controlRequestSchema = z.object({
  v: z.literal(CONTROL_PROTOCOL_VERSION),
  id: controlIdSchema,
  verb: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ControlRequest = z.infer<typeof controlRequestSchema>;

/** Machine-readable error codes a response can carry. */
export const controlErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ControlError = z.infer<typeof controlErrorSchema>;

/**
 * The response envelope. `id` is null only for frames the server could not
 * correlate (unparseable JSON / envelope) — everything else echoes the
 * request id.
 */
export const controlResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    id: controlIdSchema.nullable(),
    ok: z.literal(true),
    data: z.unknown(),
  }),
  z.object({
    v: z.literal(CONTROL_PROTOCOL_VERSION),
    id: controlIdSchema.nullable(),
    ok: z.literal(false),
    error: controlErrorSchema,
  }),
]);
export type ControlResponse = z.infer<typeof controlResponseSchema>;

/** An unsolicited push frame (only sent to connections that ran `subscribe`). */
export const controlEventSchema = z.object({
  v: z.literal(CONTROL_PROTOCOL_VERSION),
  event: z.string().min(1),
  data: z.unknown(),
});
export type ControlEventFrame = z.infer<typeof controlEventSchema>;

/** The one v1 event stream: session-level agent-status transitions
 *  (`from` is null the first time the subscriber's server sees a session). */
export const agentStatusEventSchema = z.object({
  ts: z.string(),
  session: z.string(),
  from: agentStatusSchema.nullable(),
  to: agentStatusSchema,
});
export type AgentStatusEvent = z.infer<typeof agentStatusEventSchema>;

// ---------------------------------------------------------------------------
// Per-verb params
// ---------------------------------------------------------------------------

/** `agents` — flat per-pane agent entries, optionally scoped to one session. */
export const agentsParamsSchema = z.object({
  session: z.string().optional(),
});
export type AgentsParams = z.infer<typeof agentsParamsSchema>;

/**
 * `send` — deliver text to a pane in `session`. `target` accepts the same
 * forms as `tmux-ide send`: a pane id (%N), an @ide_name, a title, a role, or
 * a partial title. `dir` (optional) is the project dir long messages are
 * dispatched through as a file; without it long text is sent directly.
 */
export const sendParamsSchema = z.object({
  session: z.string().min(1),
  target: z.string().min(1),
  message: z.string().min(1),
  noEnter: z.boolean().optional(),
  dir: z.string().optional(),
});
export type SendParams = z.infer<typeof sendParamsSchema>;

/** Server-side cap on a single `wait` — protects the resident process. */
export const CONTROL_WAIT_MAX_TIMEOUT_MS = 600_000;

const waitTimeoutSchema = z.number().int().positive().max(CONTROL_WAIT_MAX_TIMEOUT_MS).optional();

/** `wait` — block (server-side) until a condition holds. Two kinds, mirroring
 *  `tmux-ide wait agent-status` and `tmux-ide wait output`. */
export const waitParamsSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent-status"),
    session: z.string().min(1),
    status: agentStatusSchema,
    timeoutMs: waitTimeoutSchema,
  }),
  z.object({
    kind: z.literal("output"),
    target: z.string().min(1),
    match: z.string().min(1),
    timeoutMs: waitTimeoutSchema,
  }),
]);
export type WaitParams = z.infer<typeof waitParamsSchema>;

/** Where a spawned agent lands (mirrors the app's lifecycle placements). */
export const spawnPlacementSchema = z.enum(["window", "split-h", "split-v"]);

/**
 * `spawn` — start an agent via the SAME lifecycle argv builders the app uses.
 * Exactly one of `kind` (a detection-manifest id, resolved to its launch
 * command) or `command` (verbatim) must be given. With `session` the agent
 * lands in that live session (`placement`, default a new window; splits need
 * `paneId`); without it a fresh detached session named `sessionName` is
 * created in `dir`.
 */
export const spawnParamsSchema = z
  .object({
    kind: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    sessionName: z.string().min(1).optional(),
    dir: z.string().optional(),
    placement: spawnPlacementSchema.optional(),
    paneId: z.string().optional(),
  })
  .refine((p) => Boolean(p.kind) !== Boolean(p.command), {
    message: "exactly one of `kind` or `command` is required",
  })
  .refine((p) => Boolean(p.session) || Boolean(p.sessionName), {
    message: "`session` (spawn into it) or `sessionName` (create it) is required",
  })
  .refine((p) => !(p.placement && p.placement !== "window") || Boolean(p.paneId), {
    message: "split placements need `paneId`",
  });
export type SpawnParams = z.infer<typeof spawnParamsSchema>;

/** `restart-agent` — restart the agent in `paneId`, relaunching `command`
 *  (or `kind`'s launch command). One of the two is required. */
export const restartAgentParamsSchema = z
  .object({
    paneId: z.string().min(1),
    kind: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .refine((p) => Boolean(p.kind) || Boolean(p.command), {
    message: "`kind` or `command` is required",
  });
export type RestartAgentParams = z.infer<typeof restartAgentParamsSchema>;

/** `stop-agent` — interrupt the agent in `paneId` (the pane stays open). */
export const stopAgentParamsSchema = z.object({
  paneId: z.string().min(1),
});
export type StopAgentParams = z.infer<typeof stopAgentParamsSchema>;

/** `explain` — the detection debugger for one pane (or a session's active pane). */
export const explainParamsSchema = z.object({
  target: z.string().min(1),
});
export type ExplainParams = z.infer<typeof explainParamsSchema>;

/** `subscribe` — flip this connection into receiving event frames. */
export const subscribeParamsSchema = z.object({}).loose();
export type SubscribeParams = z.infer<typeof subscribeParamsSchema>;
