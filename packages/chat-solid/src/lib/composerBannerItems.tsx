/**
 * Builders that translate chat-surface state into
 * `ComposerBannerItem` records suitable for the
 * `ComposerBannerStack` slot on `ChatComposer`.
 *
 * Lives in `lib/` (not under `components/`) so callers can import
 * without pulling in the rendered card itself, and so unit tests can
 * exercise the builders directly without mounting `ChatThreadView`.
 *
 * Today the only chat-surface banner is the plan follow-up payload
 * produced from `useChatThread.pendingPlan`. T102 approval (W6) and
 * any future surface-owned banners will land here next to it.
 */

import type { JSX } from "solid-js";
import type { ComposerBannerItem } from "../components/ComposerBannerStack";
import type { ProposedPlanSummary } from "../types";

export interface PlanBannerHandlers {
  onApply: (planId: string) => void;
  onReject: (planId: string) => void;
  onModify: (planId: string) => void;
  /** Mirror of `useChatThread.planResponding()` — disables all three
   *  buttons while a request is in flight. */
  isResponding: boolean;
}

/**
 * Pull a human-friendly title from a plan's markdown. Returns the
 * first heading text (without the leading `#`s), or the static
 * fallback if the markdown carries no headings.
 */
export function planBannerTitle(plan: ProposedPlanSummary): string {
  const firstHeading = plan.planMarkdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  const stripped = firstHeading?.replace(/^#+\s*/, "").trim();
  return stripped && stripped.length > 0 ? stripped : "Plan ready";
}

/**
 * Build the banner-stack item for the currently-pending plan. Returns
 * `null` when no plan is pending so callers can spread the result
 * into a list without filtering.
 */
export function buildPlanBannerItem(
  plan: ProposedPlanSummary | null | undefined,
  handlers: PlanBannerHandlers,
): ComposerBannerItem | null {
  if (!plan) return null;
  const title = planBannerTitle(plan);
  const planId = plan.id;
  const actions: JSX.Element = (
    <div data-testid="plan-banner-actions" class="flex flex-wrap gap-1.5">
      <button
        type="button"
        data-testid="plan-banner-reject"
        disabled={handlers.isResponding}
        onClick={() => handlers.onReject(planId)}
        class="h-7 cursor-pointer rounded-md border border-destructive/40 px-2.5 text-xs text-destructive-foreground transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Reject
      </button>
      <button
        type="button"
        data-testid="plan-banner-modify"
        disabled={handlers.isResponding}
        onClick={() => handlers.onModify(planId)}
        class="h-7 cursor-pointer rounded-md border border-border bg-[var(--surface)] px-2.5 text-xs text-foreground transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Modify
      </button>
      <button
        type="button"
        data-testid="plan-banner-apply"
        disabled={handlers.isResponding}
        onClick={() => handlers.onApply(planId)}
        class="h-7 cursor-pointer rounded-md bg-[var(--accent)] px-2.5 text-xs text-[var(--bg)] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Apply
      </button>
    </div>
  );
  return {
    id: `plan:${planId}`,
    variant: "info",
    title: (
      <span>
        <span class="text-[10px] uppercase tracking-[0.14em] opacity-80">Plan ready</span>
        <span class="ml-2 font-medium">{title}</span>
      </span>
    ),
    actions,
  };
}
