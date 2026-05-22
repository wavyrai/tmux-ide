/**
 * Plan orchestrator — coordinates the approve / reject lifecycle for
 * ProposedPlan records. Composes the pure plan-store with two
 * caller-provided primitives:
 *   - `sendTurn`: spawn a new turn for a thread with content derived
 *     from the plan markdown. The caller threads the new turn id back
 *     so we can record the implementation pointer.
 *   - `isTurnRunning`: snapshot whether the thread currently has an
 *     in-flight turn. Approve refuses to proceed if so.
 *
 * Pure-domain so unit tests can drive every branch without any HTTP /
 * ACP scaffolding.
 */

import type { ProposedPlan, RuntimeMode, SourceProposedPlanReference } from "@tmux-ide/contracts";
import { PlanNotFoundError, type PlanStore } from "./plan-store.ts";

export interface SendTurnInput {
  threadId: string;
  planMarkdown: string;
  sourceProposedPlan: SourceProposedPlanReference;
  runtimeMode?: RuntimeMode;
}

export interface SendTurnResult {
  turnId: string;
}

export interface PlanOrchestrator {
  list(threadId: string): ProposedPlan[];
  get(threadId: string, planId: string): ProposedPlan | null;
  approve(input: ApprovePlanInput): Promise<ApprovePlanResult>;
  reject(input: RejectPlanInput): ProposedPlan;
}

export interface ApprovePlanInput {
  threadId: string;
  planId: string;
  runtimeMode?: RuntimeMode;
}

export interface ApprovePlanResult {
  plan: ProposedPlan;
  turnId: string;
}

export interface RejectPlanInput {
  threadId: string;
  planId: string;
  reason?: string;
}

export interface MakePlanOrchestratorOptions {
  planStore: PlanStore;
  sendTurn: (input: SendTurnInput) => Promise<SendTurnResult>;
  isTurnRunning?: (threadId: string) => boolean;
  now?: () => Date;
}

export class PlanAlreadyImplementedError extends Error {
  readonly threadId: string;
  readonly planId: string;
  constructor(threadId: string, planId: string) {
    super(`Plan ${planId} on thread ${threadId} is already implemented`);
    this.name = "PlanAlreadyImplementedError";
    this.threadId = threadId;
    this.planId = planId;
  }
}

export class PlanAlreadyRejectedError extends Error {
  readonly threadId: string;
  readonly planId: string;
  constructor(threadId: string, planId: string) {
    super(`Plan ${planId} on thread ${threadId} is already rejected`);
    this.name = "PlanAlreadyRejectedError";
    this.threadId = threadId;
    this.planId = planId;
  }
}

export class TurnAlreadyRunningError extends Error {
  readonly threadId: string;
  constructor(threadId: string) {
    super(`A turn is already running on thread ${threadId}`);
    this.name = "TurnAlreadyRunningError";
    this.threadId = threadId;
  }
}

export { PlanNotFoundError };

export function makePlanOrchestrator(opts: MakePlanOrchestratorOptions): PlanOrchestrator {
  const isTurnRunning = opts.isTurnRunning ?? (() => false);

  return {
    list(threadId) {
      return opts.planStore.list(threadId);
    },
    get(threadId, planId) {
      return opts.planStore.get(threadId, planId);
    },
    async approve(input) {
      const existing = opts.planStore.get(input.threadId, input.planId);
      if (!existing) throw new PlanNotFoundError(input.threadId, input.planId);
      if (existing.implementedAt) {
        throw new PlanAlreadyImplementedError(input.threadId, input.planId);
      }
      if (existing.rejected) {
        throw new PlanAlreadyRejectedError(input.threadId, input.planId);
      }
      if (isTurnRunning(input.threadId)) {
        throw new TurnAlreadyRunningError(input.threadId);
      }

      const { turnId } = await opts.sendTurn({
        threadId: input.threadId,
        planMarkdown: existing.planMarkdown,
        sourceProposedPlan: { threadId: input.threadId, planId: input.planId },
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      });

      const stamped = opts.planStore.markImplemented(input.threadId, input.planId, input.threadId);

      return { plan: stamped, turnId };
    },
    reject(input) {
      const existing = opts.planStore.get(input.threadId, input.planId);
      if (!existing) throw new PlanNotFoundError(input.threadId, input.planId);
      if (existing.implementedAt) {
        throw new PlanAlreadyImplementedError(input.threadId, input.planId);
      }
      if (existing.rejected) {
        throw new PlanAlreadyRejectedError(input.threadId, input.planId);
      }
      return opts.planStore.markRejected(input.threadId, input.planId, {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
    },
  };
}
