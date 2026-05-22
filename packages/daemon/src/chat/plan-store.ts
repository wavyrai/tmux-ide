/**
 * Plan store — record store for ProposedPlan objects keyed by
 * (threadId, planId). Mirrors the t3 orchestration concept of
 * "proposed plans" attached to a thread: a plan markdown blob produced
 * by an agent that the user can approve and execute.
 *
 * On upsert of a previously-unseen plan, emit `chat.plan.upserted` so
 * dashboard clients can react. Updates to an existing plan also emit
 * — t3 fires the same event on every meaningful change.
 */

import type { ChatThreadEvent, ProposedPlan } from "@tmux-ide/contracts";

export interface PlanStore {
  upsert(threadId: string, plan: ProposedPlan): ProposedPlan;
  get(threadId: string, planId: string): ProposedPlan | null;
  list(threadId: string): ProposedPlan[];
  /** Alias for list, retained for parity with the t3 vocabulary. */
  listForThread(threadId: string): ProposedPlan[];
  /**
   * Stamp a plan as implemented. Returns the updated record and emits a
   * follow-up `chat.plan.upserted` so subscribers see the implementation
   * metadata.
   */
  markImplemented(
    threadId: string,
    planId: string,
    implementationThreadId: string,
    implementedAt?: string,
  ): ProposedPlan;
  /**
   * Stamp a plan as rejected. Returns the updated record and emits a
   * follow-up `chat.plan.upserted` so subscribers see the rejection.
   */
  markRejected(
    threadId: string,
    planId: string,
    opts?: { reason?: string; at?: string },
  ): ProposedPlan;
  remove(threadId: string, planId: string): boolean;
  /** Clear all plans for a thread (used on thread.delete). */
  clear(threadId: string): void;
}

export class PlanNotFoundError extends Error {
  readonly threadId: string;
  readonly planId: string;
  constructor(threadId: string, planId: string) {
    super(`Plan ${planId} not found on thread ${threadId}`);
    this.name = "PlanNotFoundError";
    this.threadId = threadId;
    this.planId = planId;
  }
}

export interface MakePlanStoreOptions {
  emit?: (event: ChatThreadEvent) => void;
  now?: () => Date;
}

export function makePlanStore(opts: MakePlanStoreOptions = {}): PlanStore {
  const byThread = new Map<string, Map<string, ProposedPlan>>();
  const emit = opts.emit ?? (() => undefined);
  const now = opts.now ?? (() => new Date());

  function bucket(threadId: string): Map<string, ProposedPlan> {
    let b = byThread.get(threadId);
    if (!b) {
      b = new Map();
      byThread.set(threadId, b);
    }
    return b;
  }

  function getOrThrow(threadId: string, planId: string): ProposedPlan {
    const b = byThread.get(threadId);
    const existing = b?.get(planId);
    if (!existing) throw new PlanNotFoundError(threadId, planId);
    return existing;
  }

  function sortedList(threadId: string): ProposedPlan[] {
    const b = byThread.get(threadId);
    if (!b) return [];
    // Stable order by createdAt for deterministic UIs.
    return [...b.values()].sort((a, b2) => a.createdAt.localeCompare(b2.createdAt));
  }

  return {
    upsert(threadId, plan) {
      bucket(threadId).set(plan.id, plan);
      emit({ type: "chat.plan.upserted", threadId, plan });
      return plan;
    },
    get(threadId, planId) {
      return byThread.get(threadId)?.get(planId) ?? null;
    },
    list(threadId) {
      return sortedList(threadId);
    },
    listForThread(threadId) {
      return sortedList(threadId);
    },
    markImplemented(threadId, planId, implementationThreadId, implementedAt) {
      const existing = getOrThrow(threadId, planId);
      const ts = implementedAt ?? now().toISOString();
      const next: ProposedPlan = {
        ...existing,
        implementedAt: ts,
        implementationThreadId,
        updatedAt: ts,
      };
      bucket(threadId).set(planId, next);
      emit({ type: "chat.plan.upserted", threadId, plan: next });
      return next;
    },
    markRejected(threadId, planId, options = {}) {
      const existing = getOrThrow(threadId, planId);
      const ts = options.at ?? now().toISOString();
      const rejection: NonNullable<ProposedPlan["rejected"]> =
        options.reason !== undefined ? { at: ts, reason: options.reason } : { at: ts };
      const next: ProposedPlan = {
        ...existing,
        rejected: rejection,
        updatedAt: ts,
      };
      bucket(threadId).set(planId, next);
      emit({ type: "chat.plan.upserted", threadId, plan: next });
      return next;
    },
    remove(threadId, planId) {
      return byThread.get(threadId)?.delete(planId) ?? false;
    },
    clear(threadId) {
      byThread.delete(threadId);
    },
  };
}
