/**
 * Render one Turn group (and its activities) with header + checkpoint
 * chip. Plan activities (kind === "propose-plan") expand into the
 * `PlanCardStub` slot via the supplied `plansById` lookup.
 */

import { ActivityRow } from "./ActivityRow";
import { CheckpointChip } from "./CheckpointChip";
import { PlanCardStub } from "./PlanCardStub";
import { TurnDiffPanel } from "./TurnDiffPanel";
import type { TurnGroup } from "./turnGrouping";
import type { ActivityView, CheckpointSummaryView, ProposedPlanView } from "./useChatStore";
import type { TurnDiffEntry } from "@/lib/api";

export interface TurnBlockProps {
  group: TurnGroup;
  checkpoint?: CheckpointSummaryView;
  plansById?: Record<string, ProposedPlanView>;
  onRevert?: (checkpointRef: string) => void;
  threadId?: string;
  /**
   * Per-turn file diffs (T101a). When provided, the TurnDiffPanel
   * renders at the bottom of the block as a collapsible summary. Empty
   * arrays render nothing — turns that produced no checkpoint stay
   * visually identical to pre-T101a.
   */
  diffEntries?: ReadonlyArray<TurnDiffEntry>;
  onApprovePlan?: (input: { threadId: string; planId: string }) => Promise<void> | void;
  onRejectPlan?: (input: {
    threadId: string;
    planId: string;
    reason?: string;
  }) => Promise<void> | void;
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function planForActivity(
  activity: ActivityView,
  plansById: Record<string, ProposedPlanView> | undefined,
): ProposedPlanView | undefined {
  if (!plansById) return undefined;
  if (activity.kind !== "propose-plan") return undefined;
  const payload = activity.payload;
  if (typeof payload === "object" && payload !== null && "planId" in payload) {
    const planId = (payload as { planId?: unknown }).planId;
    if (typeof planId === "string" && plansById[planId]) return plansById[planId];
  }
  // Fallback: first plan for the turn.
  return Object.values(plansById).find((p) => p.turnId === activity.turnId);
}

export function TurnBlock({
  group,
  checkpoint,
  plansById,
  onRevert,
  threadId,
  diffEntries,
  onApprovePlan,
  onRejectPlan,
}: TurnBlockProps) {
  if (group.turnId === null) {
    // Ambient activities — no header, no checkpoint chip.
    return (
      <section data-testid="turn-block-ambient" className="flex flex-col gap-0.5 px-2 py-1">
        {group.activities.map((a) => (
          <ActivityRow key={a.id} activity={a} />
        ))}
      </section>
    );
  }

  return (
    <section
      data-testid="turn-block"
      data-turn-id={group.turnId}
      data-state={group.state}
      data-unfinished={group.unfinished ? "true" : "false"}
      className="flex flex-col gap-1 border-t border-[var(--border-weak)] px-2 py-2"
    >
      <header className="flex items-center gap-2 text-[11px]">
        {checkpoint ? <CheckpointChip checkpoint={checkpoint} onRevert={onRevert} /> : null}
        <span className="font-medium text-[var(--fg)]">
          Turn {group.ordinal} —{" "}
          <span data-testid="turn-state" className="text-[var(--fg-soft)]">
            {group.state}
          </span>
        </span>
        {group.completedAt ? (
          <span className="text-[10px] text-[var(--dim)]">{formatTime(group.completedAt)}</span>
        ) : null}
        {group.unfinished ? (
          <span
            data-testid="turn-streaming-indicator"
            className="text-[10px] text-[var(--accent)]"
            aria-live="polite"
          >
            streaming…
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-0.5">
        {group.activities.map((a) => {
          const plan = planForActivity(a, plansById);
          if (plan) {
            return (
              <PlanCardStub
                key={a.id}
                plan={plan}
                threadId={threadId ?? ""}
                {...(onApprovePlan ? { onApprove: onApprovePlan } : {})}
                {...(onRejectPlan ? { onReject: onRejectPlan } : {})}
              />
            );
          }
          return <ActivityRow key={a.id} activity={a} />;
        })}
      </div>
      {diffEntries && diffEntries.length > 0 ? <TurnDiffPanel entries={diffEntries} /> : null}
    </section>
  );
}
