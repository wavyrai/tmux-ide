/**
 * Composer-row banner that announces an outstanding tool-call
 * approval. Sits between the textarea and the message list, just
 * above `ComposerPendingApprovalActions` (the four-button verdict
 * row).
 *
 * The daemon currently emits permission requests through
 * `chat.permission.request`; the host maps that to a `PendingApproval`
 * with a coarse `requestKind` so the banner copy reads as "Command
 * approval requested" vs "File-change approval requested" without
 * leaking the raw tool name.
 *
 * Pure render — no internal state, no signals. The host owns whether
 * the panel mounts at all (by passing a non-null accessor) and the
 * pendingCount badge ("1/N") when multiple approvals are queued.
 */

import { Show, type JSX } from "solid-js";

export type PendingApprovalRequestKind = "command" | "file-read" | "file-change";

export interface PendingApproval {
  requestId: string;
  requestKind: PendingApprovalRequestKind;
}

export interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

function summaryFor(kind: PendingApprovalRequestKind): string {
  if (kind === "command") return "Command approval requested";
  if (kind === "file-read") return "File-read approval requested";
  return "File-change approval requested";
}

export function ComposerPendingApprovalPanel(
  props: ComposerPendingApprovalPanelProps,
): JSX.Element {
  return (
    <div
      data-testid="composer-pending-approval-panel"
      data-request-kind={props.approval.requestKind}
      class="px-4 py-3.5 sm:px-5 sm:py-4"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm uppercase tracking-[0.2em] text-fg-secondary">PENDING APPROVAL</span>
        <span class="text-md font-medium text-fg">{summaryFor(props.approval.requestKind)}</span>
        <Show when={props.pendingCount > 1}>
          <span class="text-sm text-dim">1/{props.pendingCount}</span>
        </Show>
      </div>
    </div>
  );
}
