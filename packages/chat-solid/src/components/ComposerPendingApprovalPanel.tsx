/**
 * Pending tool-call approval banner. Renders right above the composer
 * when the daemon's ProviderApprovalPolicy (T102) emits an approval
 * request that needs a user verdict before the agent can proceed.
 *
 * Visually a single banner; semantically a queue indicator when more
 * than one request is pending (`pendingCount > 1`).
 *
 * The host owns the response dispatch — the panel is render + click
 * surface only. Decisions follow the daemon's `ApprovalDecision`
 * vocabulary: accept | acceptForSession | decline | cancel.
 */

import { Show, type Accessor } from "solid-js";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ApprovalRequestKind = "command" | "file-read" | "file-change";

export interface PendingApprovalRequest {
  /** Stable id; the host uses this to identify the verdict callback target. */
  requestId: string;
  kind: ApprovalRequestKind;
  /** Short context the user reads (e.g. the bash command, the file path). */
  summary?: string;
  /** Optional caller (tool name, agent name). */
  source?: string;
}

interface ComposerPendingApprovalPanelProps {
  approval: Accessor<PendingApprovalRequest | null>;
  pendingCount: Accessor<number>;
  isResponding: Accessor<boolean>;
  onRespond: (requestId: string, decision: ApprovalDecision) => void;
}

const KIND_HEADLINE: Record<ApprovalRequestKind, string> = {
  command: "Command approval requested",
  "file-read": "File-read approval requested",
  "file-change": "File-change approval requested",
};

export function ComposerPendingApprovalPanel(props: ComposerPendingApprovalPanelProps) {
  return (
    <Show when={props.approval()}>
      {(approval) => (
        <section
          data-testid="composer-pending-approval-panel"
          data-request-id={approval().requestId}
          data-request-kind={approval().kind}
          class="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning-foreground"
        >
          <header class="flex flex-wrap items-center gap-2">
            <span class="text-[10px] uppercase tracking-[0.14em] opacity-80">
              Pending approval
            </span>
            <span class="font-medium">{KIND_HEADLINE[approval().kind]}</span>
            <Show when={props.pendingCount() > 1}>
              <span class="text-xs opacity-70" data-testid="pending-approval-counter">
                1/{props.pendingCount()}
              </span>
            </Show>
          </header>
          <Show when={approval().summary}>
            <pre class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-card/25 px-2 py-1 font-mono text-[11px] text-foreground">
              {approval().summary}
            </pre>
          </Show>
          <footer class="mt-2 flex flex-wrap items-center gap-1.5">
            <ApprovalButton
              testId="approval-cancel"
              label="Cancel turn"
              variant="ghost"
              disabled={props.isResponding()}
              onClick={() => props.onRespond(approval().requestId, "cancel")}
            />
            <ApprovalButton
              testId="approval-decline"
              label="Decline"
              variant="destructive"
              disabled={props.isResponding()}
              onClick={() => props.onRespond(approval().requestId, "decline")}
            />
            <ApprovalButton
              testId="approval-always-allow"
              label="Always allow this session"
              variant="outline"
              disabled={props.isResponding()}
              onClick={() => props.onRespond(approval().requestId, "acceptForSession")}
            />
            <ApprovalButton
              testId="approval-accept"
              label="Approve once"
              variant="primary"
              disabled={props.isResponding()}
              onClick={() => props.onRespond(approval().requestId, "accept")}
            />
          </footer>
        </section>
      )}
    </Show>
  );
}

function ApprovalButton(props: {
  testId: string;
  label: string;
  variant: "primary" | "destructive" | "outline" | "ghost";
  disabled: boolean;
  onClick: () => void;
}) {
  const variantClass = () => {
    switch (props.variant) {
      case "primary":
        return "bg-[var(--accent)] text-[var(--bg)] hover:opacity-90";
      case "destructive":
        return "border border-destructive/40 text-destructive-foreground hover:bg-destructive/10";
      case "outline":
        return "border border-border bg-[var(--surface)] text-foreground hover:bg-[var(--surface-hover)]";
      case "ghost":
        return "text-muted-foreground hover:bg-[var(--surface-hover)]";
    }
  };
  return (
    <button
      type="button"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={() => props.onClick()}
      class={`h-7 shrink-0 cursor-pointer rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantClass()}`}
    >
      {props.label}
    </button>
  );
}
