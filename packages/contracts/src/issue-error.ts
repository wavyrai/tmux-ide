import { z } from "zod";

/**
 * THE issue-error vocabulary for renderer-visible lease issuance (m45 item 4).
 *
 * Interactive terminal attachments and read-only pane streams are two payloads
 * of one protocol shape — host issues a descriptor, the renderer redeems a
 * single-use ticket — and they used to carry two enums for it. Nine of the ten
 * pane-stream members were byte-identical to their attachment twin and the
 * tenth (`stream-unavailable`) named the same fault as `attachment-unavailable`,
 * so the split bought nothing and cost accuracy: the shell had to collapse
 * `daemon-degraded` into `daemon-unavailable` and drop `request-timeout`,
 * `response-too-large` and `invalid-response` whenever a broker fault happened
 * to be on the pane-stream side of the fence.
 *
 * One enum, and the surviving spelling is the attachment one:
 *
 *  - it already ships on the older and wider path (the daemon's admission
 *    verdicts, its WebSocket close reasons, and the readiness ladder's
 *    `terminal-attachment-issue` vocabulary tag all use it), so standardizing
 *    on it leaves every string on that path byte-identical;
 *  - `resource-unavailable`, the other candidate, would read as belonging to
 *    the ladder's existing `terminal-resource-unavailable` vocabulary — a new
 *    ambiguity in the exact place this merge exists to remove one.
 *
 * A pane stream is an attachment to a pane in the plain sense; the noun the
 * user reads lives in `reason`, not in this machine token.
 */
export const TERMINAL_ISSUE_ERROR_CODES = [
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
] as const;

export const TerminalIssueErrorCodeSchemaZ = z.enum(TERMINAL_ISSUE_ERROR_CODES);
export type TerminalIssueErrorCode = z.infer<typeof TerminalIssueErrorCodeSchemaZ>;

/**
 * Wire compatibility, one direction. The daemon is installable on its own, so a
 * desktop build carrying this vocabulary can meet an older daemon that still
 * answers a pane-stream issue with `stream-unavailable`; parsing accepts that
 * literal and normalizes it. Nothing EMITS it any more.
 *
 * The reverse pairing — an old renderer meeting a new daemon — fails its strict
 * parse and degrades to the generic `request-failed`, which is the same verdict
 * that pairing already produced for every unrecognized shape.
 *
 * Follow-up: this alias can be deleted once the minimum supported daemon
 * protocol version is past the merge.
 */
export const LEGACY_TERMINAL_ISSUE_ERROR_CODES: Readonly<Record<string, TerminalIssueErrorCode>> = {
  "stream-unavailable": "attachment-unavailable",
};

export const TerminalIssueErrorCodeCompatSchemaZ = z.preprocess(
  (value) =>
    typeof value === "string" && value in LEGACY_TERMINAL_ISSUE_ERROR_CODES
      ? LEGACY_TERMINAL_ISSUE_ERROR_CODES[value]
      : value,
  TerminalIssueErrorCodeSchemaZ,
);

/**
 * Renderer-facing failure text: bounded, and never a carrier for credential
 * material. The redaction covers both lease families' ticket prefixes because
 * one vocabulary means one reason discipline.
 */
export const RendererSafeIssueReasonSchemaZ = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (reason) =>
      !/(?:authorization|bearer\s+|owner.?token|redemptionticket|ps1_|ta1_)/iu.test(reason),
    "issue error reason must be credential-redacted",
  );

export const TerminalIssueErrorSchemaZ = z
  .object({
    code: TerminalIssueErrorCodeSchemaZ,
    reason: RendererSafeIssueReasonSchemaZ,
    retryable: z.boolean(),
  })
  .strict();
export type TerminalIssueError = z.infer<typeof TerminalIssueErrorSchemaZ>;

/** The same error, accepting a pre-merge daemon's legacy code on input. */
export const TerminalIssueErrorCompatSchemaZ = z
  .object({
    code: TerminalIssueErrorCodeCompatSchemaZ,
    reason: RendererSafeIssueReasonSchemaZ,
    retryable: z.boolean(),
  })
  .strict();
