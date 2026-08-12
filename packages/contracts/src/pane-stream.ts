import { z } from "zod";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  TerminalIssueErrorCodeCompatSchemaZ,
  TerminalIssueErrorCompatSchemaZ,
  type TerminalIssueError,
  type TerminalIssueErrorCode,
} from "./issue-error.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { TerminalAttachmentViewerModeSchemaZ } from "./terminal-attachments.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";
import {
  TerminalDeliveryAckSchemaZ,
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryFaultSchemaZ,
  TerminalDeliveryNackSchemaZ,
  TerminalDeliveryNegotiationResultSchemaZ,
  TerminalDeliveryOfferSchemaZ,
  TerminalDeliveryVisibilitySchemaZ,
  TERMINAL_DELIVERY_CHUNK_BYTES,
} from "./terminal-delivery.ts";
import { SessionRuntimeSemanticIntentSchemaZ } from "./session-runtime.ts";
import { WorkspaceMultiplexerMutationResultSchemaZ } from "./workspace-multiplexer.ts";

/**
 * Pane-stream wire contract (m43 card 2): the lease family and frame grammar
 * that carry MirrorService pane streams from the daemon to renderers.
 *
 * The discipline is the terminal-attachment one, applied to mirror streams:
 * semantic identity only (runtime `%N`/`@N`/`$N` addresses never cross this
 * boundary), a one-time `ps1_` redemption ticket bound to one daemon
 * generation, and bounded shapes everywhere. Two deliberate differences,
 * both recorded product decisions:
 *
 *  - the lease is SESSION-scoped with its pane set ENUMERATED at issue —
 *    one WebSocket carries N pane streams of one workspace;
 *  - the request is viewport-free — mirror streams never size the source
 *    (the control client casts no size vote), so a renderer has no geometry
 *    to declare.
 */
export const PANE_STREAM_PROTOCOL_VERSION = 1 as const;

export const PANE_STREAM_ISSUE_PATH = "/api/v1/terminal/pane-streams/issue" as const;
export const PANE_STREAM_REDEEM_PATH = "/v1/terminal/pane-streams/redeem" as const;
export const PANE_STREAM_WEBSOCKET_SUBPROTOCOL = "tmux-ide-pane-stream.v1" as const;

/** Perf-plan ceiling (~16-24 live nodes) with headroom; enforced at issue. */
export const PANE_STREAM_MAX_PANES = 24;
/** One live `output` frame's raw payload bound, pre-base64. */
export const PANE_STREAM_MAX_OUTPUT_BYTES = 256 * 1024;
export const PANE_STREAM_MAX_OUTPUT_BASE64_CHARS = Math.ceil(PANE_STREAM_MAX_OUTPUT_BYTES / 3) * 4;
/** A seed carries screen + history from one capture; large but still bounded. */
export const PANE_STREAM_MAX_SEED_BYTES = 6 * 1024 * 1024;
export const PANE_STREAM_MAX_SEED_BASE64_CHARS = Math.ceil(PANE_STREAM_MAX_SEED_BYTES / 3) * 4;
/** Deltas held between the capture and cursor probes of one atomic reseed. */
export const PANE_STREAM_MAX_HELD_DELTAS = 256;
export const PANE_STREAM_MAX_LAYOUT_PANES = 64;
export const PANE_STREAM_MAX_GRID_CELLS = 4096;
/** Every client-authored text frame (redeem, input, consumed) fits this. */
export const PANE_STREAM_MAX_CLIENT_FRAME_BYTES = 4096;
export const PANE_STREAM_MAX_INPUT_TEXT_CHARS = 1024;
export const PANE_STREAM_MAX_INPUT_SEQUENCE = 0xffff_ffff;

export const PaneStreamSemanticPaneIdSchemaZ = TerminalAttachmentSemanticPaneIdSchemaZ;
export const PaneStreamViewerModeSchemaZ = TerminalAttachmentViewerModeSchemaZ;
export type PaneStreamViewerMode = z.infer<typeof PaneStreamViewerModeSchemaZ>;

const PaneSetSchemaZ = z
  .array(PaneStreamSemanticPaneIdSchemaZ)
  .min(1)
  .max(PANE_STREAM_MAX_PANES)
  .refine((panes) => new Set(panes).size === panes.length, "pane set must not repeat a pane");

/**
 * The complete renderer-authored request: semantic intent only. There is
 * deliberately no viewport (mirror streams do not size the source), and no
 * command, cwd, tmux target, runtime id, or credential can cross here.
 */
export const PaneStreamLeaseRequestSchemaZ = z
  .object({
    protocolVersion: z.literal(PANE_STREAM_PROTOCOL_VERSION),
    workspaceName: WorkspaceIdSchemaZ,
    panes: PaneSetSchemaZ,
    viewerMode: PaneStreamViewerModeSchemaZ,
    /** Explicit semantic-v2 content/authority mode. Omission retains raw v1. */
    terminalDelivery: TerminalDeliveryOfferSchemaZ.optional(),
  })
  .strict();
export type PaneStreamLeaseRequest = z.infer<typeof PaneStreamLeaseRequestSchemaZ>;

export const PaneStreamRedemptionTicketSchemaZ = z.string().regex(/^ps1_[A-Za-z0-9_-]{43}$/u);

/** Same canonical loopback discipline as the terminal-attachment endpoint. */
export const PaneStreamLoopbackWebSocketUrlSchemaZ = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "ws:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === PANE_STREAM_REDEEM_PATH &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.toString() === value
    );
  }, "pane-stream URL must be the canonical uncredentialed loopback redemption endpoint");

/**
 * Renderer-visible one-use stream capability. The pane set is echoed exactly
 * as enumerated at issue; no tmux id, command, cwd, owner token, or reusable
 * daemon secret appears.
 */
export const PaneStreamIssueDescriptorSchemaZ = z
  .object({
    protocolVersion: z.literal(PANE_STREAM_PROTOCOL_VERSION),
    webSocketUrl: PaneStreamLoopbackWebSocketUrlSchemaZ,
    subprotocol: z.literal(PANE_STREAM_WEBSOCKET_SUBPROTOCOL),
    redemptionTicket: PaneStreamRedemptionTicketSchemaZ,
    daemonInstanceId: DaemonInstanceIdentitySchemaZ.shape.instanceId,
    requestId: z.uuid(),
    expiresAt: z.number().int().positive(),
    panes: PaneSetSchemaZ,
    effectiveViewerMode: PaneStreamViewerModeSchemaZ,
  })
  .strict();
export type PaneStreamIssueDescriptor = z.infer<typeof PaneStreamIssueDescriptorSchemaZ>;

/**
 * The shared issue-error vocabulary (`issue-error.ts`) under its pane-stream
 * name. Pane streams used to carry a ten-member subset with one renamed member;
 * the merge means a broker fault on this path now surfaces with the same code it
 * would have on the attachment path instead of being flattened.
 *
 * `PaneStreamIssueErrorSchemaZ` parses the pre-merge `stream-unavailable`
 * literal from an older daemon and normalizes it to `attachment-unavailable`.
 */
export const PaneStreamIssueErrorCodeSchemaZ = TerminalIssueErrorCodeCompatSchemaZ;
export type PaneStreamIssueErrorCode = TerminalIssueErrorCode;

export const PaneStreamIssueErrorSchemaZ = TerminalIssueErrorCompatSchemaZ;
export type PaneStreamIssueError = TerminalIssueError;

export const PaneStreamIssueResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("issued"), descriptor: PaneStreamIssueDescriptorSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: PaneStreamIssueErrorSchemaZ }).strict(),
]);
export type PaneStreamIssueResult = z.infer<typeof PaneStreamIssueResultSchemaZ>;

/** Private Electron-main-to-daemon envelope; the renderer authors none of it. */
export const PaneStreamIssueMutationRequestSchemaZ = z
  .object({
    requestId: z.uuid(),
    expectedDaemonInstanceId: DaemonInstanceIdentitySchemaZ.shape.instanceId,
    stream: PaneStreamLeaseRequestSchemaZ,
  })
  .strict();
export type PaneStreamIssueMutationRequest = z.infer<typeof PaneStreamIssueMutationRequestSchemaZ>;

// ── Client → daemon frames ─────────────────────────────────────────────────

const BoundedIdentitySchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));

export const PaneStreamRedeemFrameSchemaZ = z
  .object({
    type: z.literal("redeem"),
    protocolVersion: z.literal(PANE_STREAM_PROTOCOL_VERSION),
    ticket: PaneStreamRedemptionTicketSchemaZ,
    requestId: z.uuid(),
    daemonInstanceId: BoundedIdentitySchemaZ,
    /**
     * The client commits to sending `consumed` frames, activating the
     * renderer-backlog flow owner from the first delivered frame. Card 3's
     * renderer sets this; simple transcript clients omit it.
     */
    deliveryAcks: z.boolean().optional(),
  })
  .strict();
export type PaneStreamRedeemFrame = z.infer<typeof PaneStreamRedeemFrameSchemaZ>;

/**
 * Named-key grammar for the send-keys fast path. Deliberately closed: only
 * tmux key names built from this list can reach the daemon, so no quoting,
 * separator, or expansion character survives to a tmux command line.
 */
export const PaneStreamKeyNameSchemaZ = z
  .string()
  .regex(
    /^(?:C-|M-|S-){0,3}(?:F1[0-2]|F[1-9]|Enter|Escape|Space|Tab|BTab|BSpace|Home|End|NPage|PPage|PgUp|PgDn|DC|IC|Up|Down|Left|Right|[A-Za-z0-9])$/u,
  );

const InputTextSchemaZ = z
  .string()
  .min(1)
  .max(PANE_STREAM_MAX_INPUT_TEXT_CHARS)
  .refine((value) => !value.includes("\0"), "input text must not contain NUL");

export const PaneStreamInputFrameSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      type: z.literal("input"),
      kind: z.literal("text"),
      pane: PaneStreamSemanticPaneIdSchemaZ,
      seq: z.number().int().positive().max(PANE_STREAM_MAX_INPUT_SEQUENCE),
      data: InputTextSchemaZ,
      performanceTraceId: z.uuid().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      kind: z.literal("key"),
      pane: PaneStreamSemanticPaneIdSchemaZ,
      seq: z.number().int().positive().max(PANE_STREAM_MAX_INPUT_SEQUENCE),
      data: PaneStreamKeyNameSchemaZ,
      performanceTraceId: z.uuid().optional(),
    })
    .strict(),
]);
export type PaneStreamInputFrame = z.infer<typeof PaneStreamInputFrameSchemaZ>;

/** Cumulative renderer consumption ack: the highest applied server seq. */
export const PaneStreamConsumedFrameSchemaZ = z
  .object({
    type: z.literal("consumed"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: z.number().int().positive(),
  })
  .strict();
export type PaneStreamConsumedFrame = z.infer<typeof PaneStreamConsumedFrameSchemaZ>;

export const PaneStreamTerminalDeliveryAckFrameSchemaZ = z
  .object({ type: z.literal("terminal-delivery-ack"), ack: TerminalDeliveryAckSchemaZ })
  .strict();
export const PaneStreamTerminalDeliveryNackFrameSchemaZ = z
  .object({ type: z.literal("terminal-delivery-nack"), nack: TerminalDeliveryNackSchemaZ })
  .strict();
export const PaneStreamTerminalDeliveryVisibilityFrameSchemaZ = z
  .object({
    type: z.literal("terminal-delivery-visibility"),
    workspaceName: TerminalDeliveryAckSchemaZ.shape.workspaceName,
    pane: PaneStreamSemanticPaneIdSchemaZ,
    generation: TerminalDeliveryAckSchemaZ.shape.generation,
    incarnation: TerminalDeliveryAckSchemaZ.shape.incarnation,
    deliveryNonce: TerminalDeliveryAckSchemaZ.shape.deliveryNonce,
    visibility: TerminalDeliveryVisibilitySchemaZ,
  })
  .strict();
export const PaneStreamSemanticIntentFrameSchemaZ = z
  .object({
    type: z.literal("semantic-intent"),
    operationId: z.uuid(),
    intent: SessionRuntimeSemanticIntentSchemaZ,
  })
  .strict();
export const PaneStreamViewportFrameSchemaZ = z
  .object({
    type: z.literal("viewport"),
    seq: z.number().int().positive().max(PANE_STREAM_MAX_INPUT_SEQUENCE),
    cols: z.number().int().min(2).max(PANE_STREAM_MAX_GRID_CELLS),
    rows: z.number().int().min(2).max(PANE_STREAM_MAX_GRID_CELLS),
  })
  .strict();

export const PaneStreamClientFrameSchemaZ = z.union([
  PaneStreamInputFrameSchemaZ,
  PaneStreamConsumedFrameSchemaZ,
  PaneStreamTerminalDeliveryAckFrameSchemaZ,
  PaneStreamTerminalDeliveryNackFrameSchemaZ,
  PaneStreamTerminalDeliveryVisibilityFrameSchemaZ,
  PaneStreamSemanticIntentFrameSchemaZ,
  PaneStreamViewportFrameSchemaZ,
]);
export type PaneStreamClientFrame = z.infer<typeof PaneStreamClientFrameSchemaZ>;

// ── Daemon → client frames ─────────────────────────────────────────────────

const Base64SchemaZ = (maxChars: number) =>
  z
    .string()
    .max(maxChars)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u, "payload must be standard base64");

const ServerSeqSchemaZ = z.number().int().positive();
const GridCellSchemaZ = z.number().int().min(1).max(PANE_STREAM_MAX_GRID_CELLS);
const CellCoordinateSchemaZ = z.number().int().min(0).max(PANE_STREAM_MAX_GRID_CELLS);

export const PaneStreamReadyFrameSchemaZ = z
  .object({
    type: z.literal("ready"),
    protocolVersion: z.literal(PANE_STREAM_PROTOCOL_VERSION),
    daemonInstanceId: BoundedIdentitySchemaZ,
    requestId: z.uuid(),
    panes: PaneSetSchemaZ,
    effectiveViewerMode: PaneStreamViewerModeSchemaZ,
  })
  .strict();

/**
 * One ATOMIC reseed: reset + seed + held deltas + cursor as a single frame,
 * applied by the renderer as one paint (tmux is a painter, not a stream —
 * never composite two captures). `reset` is null only on the degraded path
 * where the size probe failed and no fallback size was known; `cursor` is
 * null on the same degraded path.
 */
export const PaneStreamSeedBatchFrameSchemaZ = z
  .object({
    type: z.literal("seed-batch"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: ServerSeqSchemaZ,
    reset: z.object({ cols: GridCellSchemaZ, rows: GridCellSchemaZ }).strict().nullable(),
    seed: Base64SchemaZ(PANE_STREAM_MAX_SEED_BASE64_CHARS),
    held: z
      .array(Base64SchemaZ(PANE_STREAM_MAX_OUTPUT_BASE64_CHARS))
      .max(PANE_STREAM_MAX_HELD_DELTAS),
    cursor: z.object({ x: CellCoordinateSchemaZ, y: CellCoordinateSchemaZ }).strict().nullable(),
  })
  .strict();

export const PaneStreamOutputFrameSchemaZ = z
  .object({
    type: z.literal("output"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: ServerSeqSchemaZ,
    data: Base64SchemaZ(PANE_STREAM_MAX_OUTPUT_BASE64_CHARS),
  })
  .strict();

export const PaneStreamCursorFrameSchemaZ = z
  .object({
    type: z.literal("cursor"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: ServerSeqSchemaZ,
    x: CellCoordinateSchemaZ,
    y: CellCoordinateSchemaZ,
  })
  .strict();

const BoundedDisplayNameSchemaZ = z
  .string()
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));

export const PaneStreamLayoutFrameSchemaZ = z
  .object({
    type: z.literal("layout"),
    /** Durable `@tmux_ide_window_id` stamp; null while the join is unverified. */
    semanticWindowId: WorkspaceIdSchemaZ.nullable(),
    windowName: BoundedDisplayNameSchemaZ.nullable(),
    currentWindow: z.boolean(),
    cols: GridCellSchemaZ,
    rows: GridCellSchemaZ,
    zoomed: z.boolean(),
    /** Backward-compatible while older daemons are still in the reconnect window. */
    paneBorderStatus: z.enum(["top", "bottom", "off"]).default("off"),
    panes: z
      .array(
        z
          .object({
            /** Null while the pane's semantic identity join is unverified. */
            pane: PaneStreamSemanticPaneIdSchemaZ.nullable(),
            left: CellCoordinateSchemaZ,
            top: CellCoordinateSchemaZ,
            width: GridCellSchemaZ,
            height: GridCellSchemaZ,
            active: z.boolean(),
          })
          .strict(),
      )
      .max(PANE_STREAM_MAX_LAYOUT_PANES),
  })
  .strict();

export const PaneStreamFlowFrameSchemaZ = z
  .object({
    type: z.literal("flow"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: ServerSeqSchemaZ,
    state: z.enum(["paused", "resumed"]),
    reason: z.enum(["backpressure", "requested"]),
  })
  .strict();

export const PaneStreamClosedFrameSchemaZ = z
  .object({
    type: z.literal("closed"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: ServerSeqSchemaZ,
  })
  .strict();

/** Echoes the client's own input seq — the renderer's latency tap. */
export const PaneStreamInputAckFrameSchemaZ = z
  .object({
    type: z.literal("input-ack"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    seq: z.number().int().positive().max(PANE_STREAM_MAX_INPUT_SEQUENCE),
  })
  .strict();

export const PaneStreamTerminalDeliveryReadyFrameSchemaZ = z
  .object({
    type: z.literal("terminal-delivery-ready"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    negotiation: TerminalDeliveryNegotiationResultSchemaZ,
  })
  .strict();
export const PaneStreamTerminalDeliveryEnvelopeFrameSchemaZ = z
  .object({
    type: z.literal("terminal-delivery-envelope"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    envelope: TerminalDeliveryEnvelopeSchemaZ,
  })
  .strict();
export const PaneStreamTerminalDeliveryChunkFrameSchemaZ = z
  .object({
    type: z.literal("terminal-delivery-chunk"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    transactionId: z.uuid(),
    index: z.number().int().nonnegative().max(255),
    data: Base64SchemaZ(Math.ceil(TERMINAL_DELIVERY_CHUNK_BYTES / 3) * 4),
  })
  .strict();
export const PaneStreamTerminalDeliveryFaultFrameSchemaZ = z
  .object({
    type: z.literal("terminal-delivery-fault"),
    pane: PaneStreamSemanticPaneIdSchemaZ,
    fault: TerminalDeliveryFaultSchemaZ,
  })
  .strict();
export const PaneStreamSemanticIntentAckFrameSchemaZ = z
  .object({
    type: z.literal("semantic-intent-ack"),
    operationId: z.uuid(),
    outcome: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("applied"),
          result: WorkspaceMultiplexerMutationResultSchemaZ.nullable(),
        })
        .strict(),
      z
        .object({
          status: z.literal("rejected"),
          code: z.enum([
            "controller-conflict",
            "controller-target-unavailable",
            "stale-controller-lease",
            "invalid-client-capability",
            "invalid-source-pane-binding",
            "intent-session-mismatch",
            "intent-rejected",
            "intent-timed-out",
            "stream-unavailable",
          ]),
          message: z.string().min(1).max(512),
        })
        .strict(),
    ]),
  })
  .strict();

export const PaneStreamViewportAckFrameSchemaZ = z
  .object({
    type: z.literal("viewport-ack"),
    seq: z.number().int().positive().max(PANE_STREAM_MAX_INPUT_SEQUENCE),
    cols: z.number().int().min(2).max(PANE_STREAM_MAX_GRID_CELLS),
    rows: z.number().int().min(2).max(PANE_STREAM_MAX_GRID_CELLS),
  })
  .strict();

export const PaneStreamErrorFrameCodeSchemaZ = z.enum([
  "redemption-rejected",
  "ticket-expired",
  "live-capacity-exhausted",
  "stream-unavailable",
  "input-rejected",
  "protocol-error",
]);
export type PaneStreamErrorFrameCode = z.infer<typeof PaneStreamErrorFrameCodeSchemaZ>;

export const PaneStreamErrorFrameSchemaZ = z
  .object({
    type: z.literal("error"),
    protocolVersion: z.literal(PANE_STREAM_PROTOCOL_VERSION),
    code: PaneStreamErrorFrameCodeSchemaZ,
    retryable: z.boolean(),
  })
  .strict();

export const PaneStreamServerFrameSchemaZ = z.discriminatedUnion("type", [
  PaneStreamReadyFrameSchemaZ,
  PaneStreamSeedBatchFrameSchemaZ,
  PaneStreamOutputFrameSchemaZ,
  PaneStreamCursorFrameSchemaZ,
  PaneStreamLayoutFrameSchemaZ,
  PaneStreamFlowFrameSchemaZ,
  PaneStreamClosedFrameSchemaZ,
  PaneStreamInputAckFrameSchemaZ,
  PaneStreamTerminalDeliveryReadyFrameSchemaZ,
  PaneStreamTerminalDeliveryEnvelopeFrameSchemaZ,
  PaneStreamTerminalDeliveryChunkFrameSchemaZ,
  PaneStreamTerminalDeliveryFaultFrameSchemaZ,
  PaneStreamSemanticIntentAckFrameSchemaZ,
  PaneStreamViewportAckFrameSchemaZ,
  PaneStreamErrorFrameSchemaZ,
]);
export type PaneStreamServerFrame = z.infer<typeof PaneStreamServerFrameSchemaZ>;
