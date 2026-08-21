import {
  createOptimisticProjection,
  deriveOptimisticProjection,
  enqueueOptimisticOperation,
  reconcileOptimisticOperation,
  replaceCommittedProjection,
  type OptimisticProjectionState,
} from "@tmux-ide/core";

import type { WorkspacePanePreview } from "./workspace-pane-manipulation.ts";

export interface WebTiledProjection {
  readonly focusPane: string | null;
  readonly manipulationPreview: WorkspacePanePreview | null;
}

export type WebTiledOptimisticIntent =
  | { readonly kind: "focus"; readonly pane: string }
  | { readonly kind: "manipulation"; readonly preview: WorkspacePanePreview };

export type WebTiledOptimisticState = OptimisticProjectionState<
  WebTiledProjection,
  WebTiledOptimisticIntent
>;

export const WEB_TILED_OPTIMISTIC_OPTIONS = {
  predict: (value: WebTiledProjection, intent: WebTiledOptimisticIntent): WebTiledProjection =>
    intent.kind === "focus"
      ? { ...value, focusPane: intent.pane }
      : { ...value, manipulationPreview: intent.preview },
};

export function createWebTiledOptimisticState(
  generation: string,
  focusPane: string | null,
): WebTiledOptimisticState {
  return createOptimisticProjection({
    generation,
    revision: 0,
    value: { focusPane, manipulationPreview: null },
  });
}

export function deriveWebTiledProjection(state: WebTiledOptimisticState): WebTiledProjection {
  return deriveOptimisticProjection(state, WEB_TILED_OPTIMISTIC_OPTIONS);
}

export function enqueueWebTiledIntent(
  state: WebTiledOptimisticState,
  operationId: string,
  intent: WebTiledOptimisticIntent,
  nowMs: number,
  timeoutMs: number,
): WebTiledOptimisticState {
  return enqueueOptimisticOperation(state, {
    operationId,
    intent,
    acceptedAtMs: nowMs,
    deadlineAtMs: nowMs + timeoutMs,
  });
}

export function settleWebTiledIntent(
  state: WebTiledOptimisticState,
  operationId: string,
  phase: "observed" | "rejected" | "timed-out",
): WebTiledOptimisticState {
  return reconcileOptimisticOperation(state, operationId, phase, WEB_TILED_OPTIMISTIC_OPTIONS);
}

/** Atomically replace an accepted prediction without exposing a rollback frame. */
export function supersedeWebTiledManipulation(
  state: WebTiledOptimisticState,
  previousOperationId: string,
  nextOperationId: string,
  preview: WorkspacePanePreview,
  nowMs: number,
  timeoutMs: number,
): WebTiledOptimisticState {
  const settled = settleWebTiledIntent(state, previousOperationId, "observed");
  return enqueueWebTiledIntent(
    settled,
    nextOperationId,
    { kind: "manipulation", preview },
    nowMs,
    timeoutMs,
  );
}

export function commitWebTiledFocus(
  state: WebTiledOptimisticState,
  input: {
    readonly generation: string;
    readonly revision: number;
    readonly focusPane: string | null;
    readonly nowMs: number;
  },
): WebTiledOptimisticState {
  const observedOperationIds = state.pending
    .filter(
      (operation) => operation.intent.kind === "focus" && operation.intent.pane === input.focusPane,
    )
    .map((operation) => operation.operationId);
  return replaceCommittedProjection(
    state,
    {
      generation: input.generation,
      revision: input.revision,
      value: { focusPane: input.focusPane, manipulationPreview: null },
    },
    { observedOperationIds, nowMs: input.nowMs },
  );
}
