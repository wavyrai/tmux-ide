import { z } from "zod";

/** Shared transport errors without loading optional desktop resource schemas. */
export const DesktopDaemonCapabilityErrorCodeSchemaZ = z.enum([
  "preview-only",
  "daemon-unavailable",
  "daemon-degraded",
  "invalid-request",
  "workspace-not-found",
  "request-timeout",
  "response-too-large",
  "invalid-response",
  "daemon-identity-mismatch",
  "request-failed",
  "resource-changed",
  "event-unavailable",
  "protocol-error",
  "disposed",
]);

export const DesktopDaemonCapabilityErrorSchemaZ = z
  .object({
    code: DesktopDaemonCapabilityErrorCodeSchemaZ,
    reason: z.string().min(1).max(240),
  })
  .strict();

export type DesktopDaemonCapabilityErrorCode = z.infer<
  typeof DesktopDaemonCapabilityErrorCodeSchemaZ
>;
export type DesktopDaemonCapabilityError = z.infer<typeof DesktopDaemonCapabilityErrorSchemaZ>;
