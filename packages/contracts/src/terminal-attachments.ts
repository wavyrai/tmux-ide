import { z } from "zod";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import {
  RESERVED_DISCOVERED_TERMINAL_ID_PREFIX,
  TerminalAttachmentSemanticPaneIdSchemaZ,
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
export { TerminalAttachmentSemanticPaneIdSchemaZ };
export type { TerminalAttachmentSemanticPaneId } from "./semantic-identity.ts";

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
    viewport: TerminalAttachmentViewportSchemaZ,
  })
  .strict();
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
    viewport: TerminalAttachmentViewportSchemaZ,
    status: z.literal("planned"),
  })
  .strict();
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
  })
  .strict();
export type TerminalAttachmentIssueDescriptor = z.infer<
  typeof TerminalAttachmentIssueDescriptorSchemaZ
>;

export const TerminalAttachmentIssueErrorCodeSchemaZ = z.enum([
  "preview-only",
  "renderer-origin-unavailable",
  "daemon-unavailable",
  "daemon-degraded",
  "invalid-request",
  "workspace-not-found",
  "pane-not-found",
  "pane-not-attachable",
  "interactive-viewer-conflict",
  "request-timeout",
  "response-too-large",
  "invalid-response",
  "daemon-identity-mismatch",
  "attachment-unavailable",
  "request-failed",
  "disposed",
]);
export type TerminalAttachmentIssueErrorCode = z.infer<
  typeof TerminalAttachmentIssueErrorCodeSchemaZ
>;

const RendererSafeTerminalAttachmentReasonSchemaZ = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (reason) => !/(?:authorization|bearer\s+|owner.?token|redemptionticket|ta1_)/iu.test(reason),
    "terminal attachment error reason must be credential-redacted",
  );

export const TerminalAttachmentIssueErrorSchemaZ = z
  .object({
    code: TerminalAttachmentIssueErrorCodeSchemaZ,
    reason: RendererSafeTerminalAttachmentReasonSchemaZ,
    retryable: z.boolean(),
  })
  .strict();
export type TerminalAttachmentIssueError = z.infer<typeof TerminalAttachmentIssueErrorSchemaZ>;

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
