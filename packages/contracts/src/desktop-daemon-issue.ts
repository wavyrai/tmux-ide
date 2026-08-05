/**
 * The daemon-side failure vocabulary the desktop host reports with, kept in a
 * leaf module of its own.
 *
 * These codes and the daemon child's captured output are needed by BOTH the
 * desktop host contract and the startup readiness ladder — and since m45 the
 * host state also carries a ladder, the two files would otherwise import each
 * other at module-evaluation time. Nothing here imports another contract, so
 * both sides can read it without a cycle.
 */
import { z } from "zod";

export const DesktopDaemonHostIssueCodeSchemaZ = z.enum([
  "record-missing",
  "record-invalid",
  "endpoint-not-loopback",
  "protocol-incompatible",
  "process-not-running",
  "identity-unreachable",
  "identity-mismatch",
  "health-unreachable",
  "health-mismatch",
  "probe-failed",
  "probe-timeout",
  "resource-broker-failed",
  "preview-only",
  // Added on m42/supervision: the Electron supervisor stopped restarting its
  // bundled daemon child after consecutive fatal failures. Unlike every other
  // issue code this one is terminal for the session — a recheck will not
  // recover it. (m42/connection-state rebases over this addition.)
  "supervisor-halted",
]);
export type DesktopDaemonHostIssueCode = z.infer<typeof DesktopDaemonHostIssueCodeSchemaZ>;

/** Hard ceiling on the daemon child's captured last words. Bounded by construction. */
export const DAEMON_CHILD_OUTPUT_MAX_LINES = 50;
export const DAEMON_CHILD_OUTPUT_MAX_LINE_LENGTH = 500;

/**
 * One captured line of the daemon child's own output. Control-free and
 * credential-redacted: a child that logged an Authorization header must not
 * turn a diagnostic into a credential leak across the renderer bridge.
 */
const DaemonChildOutputLineSchemaZ = z
  .string()
  .max(DAEMON_CHILD_OUTPUT_MAX_LINE_LENGTH)
  .refine(
    (line) =>
      [...line].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "daemon child output must be control-character-free",
  )
  .refine(
    (line) => !/(?:authorization|bearer\s+|owner.?token|redemptionticket|ta1_)/iu.test(line),
    "daemon child output must be credential-redacted",
  );

/**
 * The tail of what the bundled daemon child actually printed before it failed.
 *
 * The desktop supervisor has always captured the child's stdout/stderr into a
 * bounded buffer; before m44.3 nothing read it, so a child that died with a
 * clear message on stderr surfaced to the user as a blank "connection failed".
 * Carrying the last lines on the disconnected state is the whole fix: a stuck
 * readiness rung arrives with the child's own words attached.
 */
export const DaemonChildOutputTailSchemaZ = z
  .object({
    stream: z.literal("stderr"),
    lines: z.array(DaemonChildOutputLineSchemaZ).max(DAEMON_CHILD_OUTPUT_MAX_LINES),
    /** Older output was dropped to stay inside the capture bound. */
    truncated: z.boolean(),
    exitCode: z.number().int().min(-256).max(256).nullable(),
    signal: z
      .string()
      .max(16)
      .regex(/^SIG[A-Z0-9]{1,12}$/u)
      .nullable(),
  })
  .strict();
export type DaemonChildOutputTail = z.infer<typeof DaemonChildOutputTailSchemaZ>;
