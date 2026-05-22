/**
 * Four-button verdict row for an outstanding tool-call approval.
 * Companion to `ComposerPendingApprovalPanel` — that panel renders
 * the headline, this row owns the actions.
 *
 * Vocabulary mirrors the upstream `ProviderApprovalDecision` contract
 * so chat-solid stays in lockstep:
 *
 *   - `cancel`           — abandon the entire turn (ghost button)
 *   - `decline`          — reject this request, keep the turn alive
 *   - `acceptForSession` — accept and remember for this session
 *   - `accept`           — accept this single request
 *
 * Pure render — every interaction dispatches through
 * `onRespondToApproval`. The `isResponding` accessor drives the
 * in-flight gate so a double-click can't double-resolve. Buttons are
 * disabled (not hidden) so the row's footprint stays stable while a
 * verdict lands.
 */

import type { Accessor, JSX } from "solid-js";

export type ProviderApprovalDecision = "cancel" | "decline" | "acceptForSession" | "accept";

export interface ComposerPendingApprovalActionsProps {
  requestId: Accessor<string>;
  isResponding: Accessor<boolean>;
  onRespondToApproval: (
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void> | void;
}

const BTN =
  "inline-flex h-8 items-center rounded-md border px-3 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const VARIANTS = {
  cancel: `${BTN} border-transparent text-fg-secondary hover:text-fg`,
  decline: `${BTN} border-red/40 text-red hover:bg-red/10`,
  acceptForSession: `${BTN} border-border text-fg-secondary hover:border-accent hover:text-accent`,
  accept: `${BTN} border-transparent bg-accent text-bg hover:opacity-90`,
} as const;

export function ComposerPendingApprovalActions(
  props: ComposerPendingApprovalActionsProps,
): JSX.Element {
  const respond = (decision: ProviderApprovalDecision): void => {
    void props.onRespondToApproval(props.requestId(), decision);
  };

  return (
    <div
      data-testid="composer-pending-approval-actions"
      class="flex flex-wrap items-center gap-1.5 px-4 pb-3 sm:px-5"
    >
      <button
        type="button"
        data-testid="composer-pending-approval-cancel"
        data-decision="cancel"
        class={VARIANTS.cancel}
        disabled={props.isResponding()}
        onClick={() => respond("cancel")}
      >
        Cancel turn
      </button>
      <button
        type="button"
        data-testid="composer-pending-approval-decline"
        data-decision="decline"
        class={VARIANTS.decline}
        disabled={props.isResponding()}
        onClick={() => respond("decline")}
      >
        Decline
      </button>
      <button
        type="button"
        data-testid="composer-pending-approval-session"
        data-decision="acceptForSession"
        class={VARIANTS.acceptForSession}
        disabled={props.isResponding()}
        onClick={() => respond("acceptForSession")}
      >
        Always allow this session
      </button>
      <button
        type="button"
        data-testid="composer-pending-approval-accept"
        data-decision="accept"
        class={VARIANTS.accept}
        disabled={props.isResponding()}
        onClick={() => respond("accept")}
      >
        Approve once
      </button>
    </div>
  );
}
