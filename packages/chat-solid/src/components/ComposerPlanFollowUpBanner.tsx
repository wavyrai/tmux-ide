/**
 * "Plan ready" banner rendered between the timeline and the composer
 * when the latest assistant message proposed a plan that needs a user
 * verdict. Three actions: Apply / Modify / Reject. Render-only — the
 * host owns the dispatch (mutating the plan store, sending the next
 * turn with a follow-up directive).
 */

import { Show, type Accessor } from "solid-js";

export interface PlanFollowUpPayload {
  /** Stable plan id (matches `chat.plan.upserted` event payload). */
  planId: string;
  /** Optional headline pulled from the plan markdown frontmatter. */
  title: string | null;
  /** Optional caller — agent name or session id. */
  source?: string;
}

interface ComposerPlanFollowUpBannerProps {
  plan: Accessor<PlanFollowUpPayload | null>;
  isResponding: Accessor<boolean>;
  onApply: (planId: string) => void;
  onModify: (planId: string) => void;
  onReject: (planId: string) => void;
}

export function ComposerPlanFollowUpBanner(props: ComposerPlanFollowUpBannerProps) {
  return (
    <Show when={props.plan()}>
      {(plan) => (
        <section
          data-testid="composer-plan-follow-up-banner"
          data-plan-id={plan().planId}
          class="rounded-lg border border-info/40 bg-info/10 px-3 py-2.5 text-sm text-info-foreground"
        >
          <header class="flex flex-wrap items-center gap-2">
            <span class="text-[10px] uppercase tracking-[0.14em] opacity-80">Plan ready</span>
            <Show when={plan().title}>
              <span class="min-w-0 flex-1 truncate font-medium">{plan().title}</span>
            </Show>
            <Show when={plan().source}>
              <span class="text-xs opacity-70">· {plan().source}</span>
            </Show>
          </header>
          <footer class="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="plan-follow-up-reject"
              disabled={props.isResponding()}
              onClick={() => props.onReject(plan().planId)}
              class="h-7 cursor-pointer rounded-md border border-destructive/40 px-2.5 text-xs text-destructive-foreground transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              data-testid="plan-follow-up-modify"
              disabled={props.isResponding()}
              onClick={() => props.onModify(plan().planId)}
              class="h-7 cursor-pointer rounded-md border border-border bg-[var(--surface)] px-2.5 text-xs text-foreground transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Modify
            </button>
            <button
              type="button"
              data-testid="plan-follow-up-apply"
              disabled={props.isResponding()}
              onClick={() => props.onApply(plan().planId)}
              class="h-7 cursor-pointer rounded-md bg-[var(--accent)] px-2.5 text-xs text-[var(--bg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Apply
            </button>
          </footer>
        </section>
      )}
    </Show>
  );
}
