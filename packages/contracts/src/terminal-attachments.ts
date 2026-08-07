import { z } from "zod";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  TerminalIssueErrorCodeSchemaZ,
  TerminalIssueErrorSchemaZ,
  type TerminalIssueError,
  type TerminalIssueErrorCode,
} from "./issue-error.ts";
import {
  RESERVED_DISCOVERED_TERMINAL_ID_PREFIX,
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
} from "./semantic-identity.ts";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";

/** Wire version for the semantic terminal-attachment boundary. */
export const TERMINAL_ATTACHMENT_PROTOCOL_VERSION = 1 as const;

/**
 * Deliberately bounded before a renderer can ask the daemon to allocate a PTY
 * or tmux client. These are cell counts, not pixels.
 */
export const TERMINAL_ATTACHMENT_MIN_COLS = 20;
export const TERMINAL_ATTACHMENT_MAX_COLS = 500;
export const TERMINAL_ATTACHMENT_MIN_ROWS = 5;
export const TERMINAL_ATTACHMENT_MAX_ROWS = 200;

export const TERMINAL_ATTACHMENT_RESERVED_PANE_ID_PREFIX = RESERVED_DISCOVERED_TERMINAL_ID_PREFIX;
export { TerminalAttachmentSemanticPaneIdSchemaZ, TerminalAttachmentSemanticWindowIdSchemaZ };
export type {
  TerminalAttachmentSemanticPaneId,
  TerminalAttachmentSemanticWindowId,
} from "./semantic-identity.ts";

/** Durable product identity. Runtime tmux ids are intentionally absent. */
export const TerminalAttachmentSemanticTargetSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  })
  .strict();
export type TerminalAttachmentSemanticTarget = z.infer<
  typeof TerminalAttachmentSemanticTargetSchemaZ
>;

export const TerminalAttachmentViewerModeSchemaZ = z.enum(["interactive", "read-only"]);
export type TerminalAttachmentViewerMode = z.infer<typeof TerminalAttachmentViewerModeSchemaZ>;

/**
 * Who decides how big the origin tmux window is (m50.2, gap 1).
 *
 * `passive` — the attachment's client is excluded from tmux's window-size
 * calculation (`attach-session -f ignore-size`). It renders whatever grid the
 * window already has and letterboxes the remainder. Every mirror, every
 * read-only viewer and every secondary view is passive, because a view must
 * never reflow a window someone else is also attached to.
 *
 * `owner` — the client's own size drives the window, exactly as an ssh client's
 * would. The renderer measures its tile area, floors it into cells, and sends
 * the result down the attachment's existing resize path; the PTY resize reaches
 * the tmux client as a SIGWINCH and tmux re-tiles the window to match. Nothing
 * issues `refresh-client -C` and nothing writes a `window-size` option — the
 * client IS the size, and the attachment path never writes window state.
 *
 * Ownership is exclusive among tmux-ide's own attachments: the interactive lease
 * is window-keyed and permits one holder, so "one owner" needs no second
 * mechanism, and it is released when the attachment is.
 *
 * ── Sharing a window with a real terminal ─────────────────────────────────────
 *
 * `owner` does NOT mean exclusive control of the window's size against the rest
 * of the world, and that is deliberate. tmux's default `window-size latest`
 * sizes a window to its most recently used client, so an owning attachment wins
 * while the app is the client the user last acted in — and the moment they
 * attach a real terminal and type there, THAT client wins instead. Coming back
 * to the app takes it back.
 *
 * This is the intended sharing behavior, not a limitation being tolerated. The
 * alternative — `window-size manual` plus `resize-window` — would let the app
 * pin a size onto a session someone else is attached to, which is precisely the
 * bullying tmux-ide exists not to do. Under `latest`, a user who never opens the
 * app is unaffected by it, and a user who opens both gets whichever they are
 * currently working in. Nothing is taken from the terminal they already had.
 *
 * `passive` is the DEFAULT on the request, and deliberately so: an omitted field
 * must mean the harmless thing. Owning geometry reflows a window that an ssh
 * client, another editor or a colleague may be looking at, so it is opted into
 * and never inferred.
 */
export const TerminalAttachmentGeometryOwnershipSchemaZ = z.enum(["passive", "owner"]);
export type TerminalAttachmentGeometryOwnership = z.infer<
  typeof TerminalAttachmentGeometryOwnershipSchemaZ
>;

/**
 * A read-only viewer cannot own geometry.
 *
 * `attach-session -r` implies `ignore-size`, so tmux would ignore the request
 * regardless — and a contract that accepts an intent the runtime silently drops
 * is worse than one that refuses it. The combination is rejected at the boundary
 * rather than downgraded, so a caller learns it asked for something impossible.
 */
export function refuseReadOnlyGeometryOwner(
  value: {
    readonly viewerMode: TerminalAttachmentViewerMode;
    readonly geometryOwnership: TerminalAttachmentGeometryOwnership;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.viewerMode === "read-only" && value.geometryOwnership === "owner") {
    ctx.addIssue({
      code: "custom",
      path: ["geometryOwnership"],
      message: "a read-only attachment cannot own the origin window's geometry",
    });
  }
}

export const TerminalAttachmentViewportSchemaZ = z
  .object({
    cols: z.number().int().min(TERMINAL_ATTACHMENT_MIN_COLS).max(TERMINAL_ATTACHMENT_MAX_COLS),
    rows: z.number().int().min(TERMINAL_ATTACHMENT_MIN_ROWS).max(TERMINAL_ATTACHMENT_MAX_ROWS),
  })
  .strict();
export type TerminalAttachmentViewport = z.infer<typeof TerminalAttachmentViewportSchemaZ>;

/**
 * The complete renderer-authored request. It accepts semantic intent and a
 * viewport only: no command, cwd, tmux target, runtime pane id, or credential
 * can cross this boundary.
 */
export const TerminalAttachRequestSchemaZ = z
  .object({
    protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
    target: TerminalAttachmentSemanticTargetSchemaZ,
    viewerMode: TerminalAttachmentViewerModeSchemaZ,
    geometryOwnership: TerminalAttachmentGeometryOwnershipSchemaZ.default("passive"),
    viewport: TerminalAttachmentViewportSchemaZ,
  })
  .strict()
  .superRefine(refuseReadOnlyGeometryOwner);
export type TerminalAttachRequest = z.infer<typeof TerminalAttachRequestSchemaZ>;

/**
 * Browser-safe semantic plan. `planned` is deliberately not `ready` or
 * `attached`: this card creates no lease, bearer capability, PTY, or client.
 */
export const TerminalAttachmentDescriptorSchemaZ = z
  .object({
    attachmentId: z.uuid(),
    target: TerminalAttachmentSemanticTargetSchemaZ,
    viewerMode: TerminalAttachmentViewerModeSchemaZ,
    /**
     * Echoed, never defaulted here: the descriptor reports what the daemon
     * RESOLVED, so a caller can see that the ownership it asked for is the
     * ownership it got rather than assuming the request survived.
     */
    geometryOwnership: TerminalAttachmentGeometryOwnershipSchemaZ,
    viewport: TerminalAttachmentViewportSchemaZ,
    status: z.literal("planned"),
  })
  .strict()
  .superRefine(refuseReadOnlyGeometryOwner);
export type TerminalAttachmentDescriptor = z.infer<typeof TerminalAttachmentDescriptorSchemaZ>;

/**
 * Correlation only. This UUID is explicitly non-secret and cannot be redeemed
 * for a terminal. The later lease issuer owns one-time redemption tickets.
 */
export const TerminalAttachmentPlanHandleSchemaZ = z
  .object({
    requestId: z.uuid(),
  })
  .strict();
export type TerminalAttachmentPlanHandle = z.infer<typeof TerminalAttachmentPlanHandleSchemaZ>;

export const TerminalAttachmentErrorSchemaZ = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("protocol-version-unsupported"),
      message: z.string().min(1).max(500),
      receivedVersion: z.number().int().positive(),
      supportedVersions: z.tuple([z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION)]),
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      code: z.literal("workspace-not-found"),
      message: z.string().min(1).max(500),
      target: TerminalAttachmentSemanticTargetSchemaZ,
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      code: z.literal("pane-not-found"),
      message: z.string().min(1).max(500),
      target: TerminalAttachmentSemanticTargetSchemaZ,
      retryable: z.literal(false),
    })
    .strict(),
  z
    .object({
      code: z.literal("pane-not-attachable"),
      message: z.string().min(1).max(500),
      target: TerminalAttachmentSemanticTargetSchemaZ,
      reason: z.enum(["not-terminal", "not-single-pane-window", "runtime-unavailable"]),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      code: z.literal("interactive-viewer-conflict"),
      message: z.string().min(1).max(500),
      target: TerminalAttachmentSemanticTargetSchemaZ,
      retryable: z.literal(true),
    })
    .strict(),
  z
    .object({
      code: z.literal("attachment-unavailable"),
      message: z.string().min(1).max(500),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type TerminalAttachmentError = z.infer<typeof TerminalAttachmentErrorSchemaZ>;

/**
 * Non-redeemable planning response. In particular it has no `ticket`,
 * `token`, daemon credential, tmux target, command, or path.
 */
export const TerminalAttachmentPlanResponseSchemaZ = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
      descriptor: TerminalAttachmentDescriptorSchemaZ,
      handle: TerminalAttachmentPlanHandleSchemaZ,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
      error: TerminalAttachmentErrorSchemaZ,
    })
    .strict(),
]);
export type TerminalAttachmentPlanResponse = z.infer<typeof TerminalAttachmentPlanResponseSchemaZ>;

/** Reviewed host mutation and direct-stream authorities shared across processes. */
export const TERMINAL_ATTACHMENT_ISSUE_PATH = "/api/v1/terminal/attachments/issue" as const;
export const TERMINAL_ATTACHMENT_REDEEM_PATH = "/v1/terminal/attachments/redeem" as const;
export const TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL = "tmux-ide-terminal.v1" as const;
export const TERMINAL_ATTACHMENT_MAX_ISSUE_DESCRIPTOR_LIFETIME_MS = 60_000;

export const TerminalAttachmentRequestIdSchemaZ = z.uuid();
export const TerminalAttachmentRedemptionTicketSchemaZ = z
  .string()
  .regex(/^ta1_[A-Za-z0-9_-]{43}$/u);

/**
 * A canonical, uncredentialed loopback WebSocket URL for the one reviewed
 * redemption path. A port is mandatory so a daemon can never redirect the
 * renderer to a browser default or non-loopback authority.
 */
export const TerminalAttachmentLoopbackWebSocketUrlSchemaZ = z
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
      url.pathname === TERMINAL_ATTACHMENT_REDEEM_PATH &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.toString() === value
    );
  }, "terminal URL must be the canonical uncredentialed loopback redemption endpoint");

/**
 * Renderer-visible one-use attachment capability. It contains no tmux id,
 * command, cwd, argv, environment, owner token, or reusable daemon secret.
 */
export const TerminalAttachmentIssueDescriptorSchemaZ = z
  .object({
    protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
    webSocketUrl: TerminalAttachmentLoopbackWebSocketUrlSchemaZ,
    subprotocol: z.literal(TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL),
    redemptionTicket: TerminalAttachmentRedemptionTicketSchemaZ,
    daemonInstanceId: DaemonInstanceIdentitySchemaZ.shape.instanceId,
    requestId: TerminalAttachmentRequestIdSchemaZ,
    expiresAt: z.number().int().positive(),
    effectiveViewerMode: TerminalAttachmentViewerModeSchemaZ,
    /** What the daemon actually granted, beside the viewer mode it granted. */
    effectiveGeometryOwnership: TerminalAttachmentGeometryOwnershipSchemaZ,
  })
  .strict();
export type TerminalAttachmentIssueDescriptor = z.infer<
  typeof TerminalAttachmentIssueDescriptorSchemaZ
>;

/**
 * The shared issue-error vocabulary under its attachment-path name. The enum
 * itself lives in `issue-error.ts`, which pane-stream leases cite too — see the
 * header there for why `attachment-unavailable` is the surviving spelling.
 */
export const TerminalAttachmentIssueErrorCodeSchemaZ = TerminalIssueErrorCodeSchemaZ;
export type TerminalAttachmentIssueErrorCode = TerminalIssueErrorCode;

export const TerminalAttachmentIssueErrorSchemaZ = TerminalIssueErrorSchemaZ;
export type TerminalAttachmentIssueError = TerminalIssueError;

/** Strict renderer-facing result. Daemon response detail is never forwarded. */
export const TerminalAttachmentIssueResultSchemaZ = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("issued"),
      descriptor: TerminalAttachmentIssueDescriptorSchemaZ,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      error: TerminalAttachmentIssueErrorSchemaZ,
    })
    .strict(),
]);
export type TerminalAttachmentIssueResult = z.infer<typeof TerminalAttachmentIssueResultSchemaZ>;

/** Private Electron-main-to-daemon envelope; the renderer authors none of it. */
export const TerminalAttachmentIssueMutationRequestSchemaZ = z
  .object({
    requestId: TerminalAttachmentRequestIdSchemaZ,
    expectedDaemonInstanceId: DaemonInstanceIdentitySchemaZ.shape.instanceId,
    attachment: TerminalAttachRequestSchemaZ,
  })
  .strict();
export type TerminalAttachmentIssueMutationRequest = z.infer<
  typeof TerminalAttachmentIssueMutationRequestSchemaZ
>;
