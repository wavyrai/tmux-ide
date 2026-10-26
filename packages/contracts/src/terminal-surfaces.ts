import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { SessionRuntimeGenerationSchemaZ } from "./session-runtime.ts";

/** Native surface control only: no pixel bytes, filesystem paths or raw Mach names.
 * These schemas do not authenticate a peer or advertise support. They are valid
 * for native delivery only after explicit negotiation and verified same-host
 * authentication. A receiver request may instead get an unsupported fallback;
 * that never authorizes endpoint lookup. SSH/unsupported peers retain the
 * existing graphics transport.
 */
export const TERMINAL_SURFACE_MAX_BYTES = 64 * 1024 * 1024;
/** Additive opt-in; does not replace binary/kitty fallback capability bundles. */
export const TERMINAL_SURFACE_CAPABILITY_VERSION = 116;
export const TERMINAL_SURFACE_MAX_OUTSTANDING = 8;
export const TERMINAL_SURFACE_MAX_CONTROL_BYTES = 16 * 1024;
const NonNilUuid = z.uuid().refine((value) => value !== "00000000-0000-0000-0000-000000000000");
const Sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Opaque full kernel audit identity, including incarnation. Values from control
 * must still match the kernel trailer; numeric PID alone is never proof. */
export const TerminalSurfaceAuditTokenSchemaZ = z
  .array(z.number().int().min(0).max(0xffff_ffff))
  .length(8)
  .refine((token) => token.some((word) => word !== 0));
const scope = {
  version: z.literal(1),
  generation: SessionRuntimeGenerationSchemaZ,
  connectionNonce: NonNilUuid,
};

export const TerminalSurfaceWatchSchemaZ = z
  .object({
    type: z.literal("terminal-surface-watch"),
    version: z.literal(1),
    generation: SessionRuntimeGenerationSchemaZ,
  })
  .strict();
export type TerminalSurfaceWatch = z.infer<typeof TerminalSurfaceWatchSchemaZ>;

export const TerminalSurfaceAvailableSchemaZ = z
  .object({
    type: z.literal("terminal-surface-available"),
    version: z.literal(1),
    generation: SessionRuntimeGenerationSchemaZ,
    connectionNonce: NonNilUuid.nullable(),
  })
  .strict();
export type TerminalSurfaceAvailable = z.infer<typeof TerminalSurfaceAvailableSchemaZ>;

export const TerminalSurfaceReceiverSchemaZ = z
  .object({
    type: z.literal("terminal-surface-receiver"),
    ...scope,
    pid: z.number().int().min(1).max(0x7fff_ffff),
    slot: z.number().int().min(0).max(31),
    auditToken: TerminalSurfaceAuditTokenSchemaZ,
    challenge: NonNilUuid,
  })
  .strict();
export type TerminalSurfaceReceiver = z.infer<typeof TerminalSurfaceReceiverSchemaZ>;

export const TerminalSurfacePeerSchemaZ = z
  .object({
    type: z.literal("terminal-surface-peer"),
    ...scope,
    auditToken: TerminalSurfaceAuditTokenSchemaZ,
  })
  .strict();
export type TerminalSurfacePeer = z.infer<typeof TerminalSurfacePeerSchemaZ>;

/** Mirrors the Rust admission envelope. Admission additionally checks the exact
 * retained committed pane identity before reservation and again before import.
 * A storage ticket correlates a separately transferred capability, never a path.
 */
/** Rectangle in the committed pane's visible cell grid. History and pane
 * replacement never inherit this placement; the canonical identity fences it. */
export const TerminalSurfacePlacementSchemaZ = z
  .object({
    row: z.number().int().min(0).max(16383),
    column: z.number().int().min(0).max(16383),
    rows: z.number().int().min(1).max(16384),
    columns: z.number().int().min(1).max(16384),
  })
  .strict()
  .refine((rect) => rect.row + rect.rows <= 16384 && rect.column + rect.columns <= 16384);
export type TerminalSurfacePlacement = z.infer<typeof TerminalSurfacePlacementSchemaZ>;

export const TerminalSurfaceOfferSchemaZ = z
  .object({
    type: z.literal("terminal-surface-offer"),
    version: z.literal(1),
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
    generation: SessionRuntimeGenerationSchemaZ,
    incarnation: z.string().min(1).max(256),
    deliveryNonce: NonNilUuid,
    canonicalRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    canonicalStateHash: z.string().regex(/^[0-9a-f]{16}$/u),
    sequence: Sequence,
    surfaceId: NonNilUuid,
    placement: TerminalSurfacePlacementSchemaZ,
    storageTicket: NonNilUuid,
    format: z.literal("bgra8-straight"),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    stride: z.number().int().min(4).max(TERMINAL_SURFACE_MAX_BYTES),
    allocationBytes: z.number().int().min(4).max(TERMINAL_SURFACE_MAX_BYTES),
  })
  .strict()
  .refine(
    (offer) =>
      offer.stride % 4 === 0 &&
      offer.stride >= offer.width * 4 &&
      offer.stride * offer.height <= offer.allocationBytes,
  );
export type TerminalSurfaceOffer = z.infer<typeof TerminalSurfaceOfferSchemaZ>;

/** Sent on the original connection only after final backing/GPU ownership drops.
 * Receipt, import, CPU decode or submission to Metal is not retirement. */
export const TerminalSurfaceRetiredSchemaZ = z
  .object({
    type: z.literal("terminal-surface-retired"),
    ...scope,
    sequence: Sequence,
  })
  .strict();
export type TerminalSurfaceRetired = z.infer<typeof TerminalSurfaceRetiredSchemaZ>;

/** Ends this connection's native negotiation. A replacement connection starts
 * fresh; no native storage is freed merely because fallback was requested. */
export const TerminalSurfaceFallbackSchemaZ = z
  .object({
    type: z.literal("terminal-surface-fallback"),
    ...scope,
    reason: z.enum(["unsupported", "timeout", "identity", "budget", "storage"]),
  })
  .strict();
export type TerminalSurfaceFallback = z.infer<typeof TerminalSurfaceFallbackSchemaZ>;
