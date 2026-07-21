import { z } from "zod";
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

/** Durable product identity. Runtime tmux ids are intentionally absent. */
export const TerminalAttachmentSemanticTargetSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: WorkspaceIdSchemaZ,
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
