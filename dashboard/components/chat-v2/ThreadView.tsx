/**
 * Right pane — turn-grouped activity stream for the active thread.
 *
 * Header is sticky-top (thread title + provider + usage chip), composer
 * is sticky-bottom. Everything in between is the scrollable activity
 * stream rendered as a sequence of TurnBlock components.
 */

import { useMemo } from "react";
import type { ThreadIndexEntry } from "../chat/types";
import type { TurnDiffEntry } from "@/lib/api";

/**
 * Minimal usage summary shape — kept local so we don't depend on a type
 * that lives in the legacy chat/types union. Mirror the daemon-side
 * ChatThreadUsageSummary; expand here as the WS surface adds fields.
 */
export interface ChatThreadUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}
import { ComposerInput } from "./ComposerInput";
import { TurnBlock } from "./TurnBlock";
import { groupActivitiesByTurn } from "./turnGrouping";
import type {
  ActivityView,
  CheckpointSummaryView,
  ProposedPlanView,
  TurnSummary,
} from "./useChatStore";

export interface ThreadViewProps {
  thread: ThreadIndexEntry | null;
  usage?: ChatThreadUsageSummary;
  activities: ActivityView[];
  turns: Record<string, TurnSummary>;
  checkpointsByTurn: Record<string, CheckpointSummaryView>;
  plansById: Record<string, ProposedPlanView>;
  /**
   * Per-turn file diffs (T101a). Optional — when omitted or empty for
   * a given turn, the TurnDiffPanel is skipped and the turn renders
   * exactly as it did pre-T101a.
   */
  diffsByTurn?: Readonly<Record<string, ReadonlyArray<TurnDiffEntry>>>;
  onSubmit(text: string): void;
  onRevert?(checkpointRef: string): void;
  onApprovePlan?: (input: { threadId: string; planId: string }) => Promise<void> | void;
  onRejectPlan?: (input: {
    threadId: string;
    planId: string;
    reason?: string;
  }) => Promise<void> | void;
}

export function ThreadView(props: ThreadViewProps) {
  const groups = useMemo(
    () => groupActivitiesByTurn({ activities: props.activities, turns: props.turns }),
    [props.activities, props.turns],
  );

  const composerDisabled = useMemo(() => groups.some((g) => g.state === "running"), [groups]);

  if (!props.thread) {
    return (
      <div
        data-testid="thread-view-empty"
        className="flex flex-1 items-center justify-center text-[11px] text-[var(--dim)]"
      >
        — pick or create a thread —
      </div>
    );
  }

  return (
    <div data-testid="thread-view" className="flex min-h-0 flex-1 flex-col">
      <header
        data-testid="thread-view-header"
        className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2 text-[11px]"
      >
        <div className="min-w-0">
          <div className="truncate text-[var(--fg)]" data-testid="thread-view-title">
            {props.thread.title || "untitled"}
          </div>
          <div className="text-[10px] text-[var(--dim)]">{props.thread.providerKind}</div>
        </div>
        {props.usage ? (
          <span
            data-testid="thread-view-usage"
            className="rounded border border-[var(--border-weak)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--fg-soft)]"
            title="Token usage"
          >
            {props.usage.inputTokens.toLocaleString()} in ·{" "}
            {props.usage.outputTokens.toLocaleString()} out
            {typeof props.usage.totalCostUsd === "number"
              ? ` · $${props.usage.totalCostUsd.toFixed(2)}`
              : ""}
          </span>
        ) : null}
      </header>

      <div data-testid="thread-view-stream" className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <div
            data-testid="thread-view-stream-empty"
            className="px-3 py-6 text-center text-[11px] text-[var(--dim)]"
          >
            — no activity yet —
          </div>
        ) : (
          groups.map((g) => (
            <TurnBlock
              key={g.turnId ?? "ambient"}
              group={g}
              checkpoint={g.turnId !== null ? props.checkpointsByTurn[g.turnId] : undefined}
              plansById={props.plansById}
              onRevert={props.onRevert}
              threadId={props.thread!.id}
              {...(g.turnId !== null && props.diffsByTurn?.[g.turnId]
                ? { diffEntries: props.diffsByTurn[g.turnId] }
                : {})}
              {...(props.onApprovePlan ? { onApprovePlan: props.onApprovePlan } : {})}
              {...(props.onRejectPlan ? { onRejectPlan: props.onRejectPlan } : {})}
            />
          ))
        )}
      </div>

      <ComposerInput disabled={composerDisabled} onSubmit={props.onSubmit} />
    </div>
  );
}
