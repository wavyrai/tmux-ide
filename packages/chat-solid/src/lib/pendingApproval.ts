/**
 * Bridges the daemon's `chat.permission.request` wire shape
 * (`PermissionRequest` — a tool call plus a list of allow / reject
 * options) onto the composer's inline approval surface
 * (`PendingApproval` + the four-verb `ProviderApprovalDecision`).
 *
 * The composer surface is intentionally coarse (Command / File-read /
 * File-change) so the headline reads cleanly without leaking the raw
 * tool name; the verdict row speaks the upstream four-verb vocabulary.
 * The actual permission round-trip still goes through the hook's
 * existing `respondToPermission(optionId)` — this module only resolves
 * a decision to the concrete `optionId` the daemon offered, so the
 * respond logic is reused rather than duplicated.
 */

import type {
  PendingApproval,
  PendingApprovalRequestKind,
} from "../components/ComposerPendingApprovalPanel";
import type { ProviderApprovalDecision } from "../components/ComposerPendingApprovalActions";
import type { PermissionOption, PermissionRequest } from "../types";

/**
 * Coarse classification of an ACP tool call for the approval
 * headline. ACP `ToolKind` is `read | edit | delete | move | search |
 * execute | think | fetch | other` (see daemon acp/schema.ts). We fold
 * that into the three buckets the panel renders.
 */
export function requestKindFromToolCall(
  kind: string | null | undefined,
): PendingApprovalRequestKind {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    case "read":
    case "search":
    case "fetch":
    case "think":
      return "file-read";
    case "execute":
    default:
      // `execute`, `other`, and any unknown/absent kind read as a
      // generic command-style approval — the safest non-leaky default.
      return "command";
  }
}

export function toPendingApproval(request: PermissionRequest): PendingApproval {
  return {
    requestId: request.requestId,
    requestKind: requestKindFromToolCall(request.toolCall.kind),
  };
}

/**
 * Preference order per decision. The daemon doesn't always offer all
 * four option kinds, so each decision falls back to the next-closest
 * available option rather than no-op'ing.
 */
const DECISION_KIND_PREFERENCE: Record<
  ProviderApprovalDecision,
  ReadonlyArray<PermissionOption["kind"]>
> = {
  accept: ["allow_once", "allow_always"],
  acceptForSession: ["allow_always", "allow_once"],
  decline: ["reject_once", "reject_always"],
  // "Cancel turn" maps to the strongest reject the daemon offered.
  cancel: ["reject_always", "reject_once"],
};

/**
 * Resolve a composer decision to a concrete `optionId` from the
 * options the daemon offered. Returns null when none of the preferred
 * kinds are present (caller should treat that as "can't act").
 */
export function resolveApprovalOptionId(
  request: PermissionRequest,
  decision: ProviderApprovalDecision,
): string | null {
  for (const kind of DECISION_KIND_PREFERENCE[decision]) {
    const match = request.options.find((option) => option.kind === kind);
    if (match) return match.optionId;
  }
  return null;
}
