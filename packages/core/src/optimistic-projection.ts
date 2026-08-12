/**
 * Renderer-neutral committed/pending/derived projection.
 *
 * The daemon owns committed truth. Clients may predict accepted local intents,
 * but never mutate that truth in place. React, OpenTUI, and SDK adapters can all
 * render `deriveOptimisticProjection` and reconcile the same operation IDs.
 */

export interface CommittedProjection<T> {
  readonly generation: string;
  readonly revision: number;
  readonly value: T;
}

export interface PendingProjectionOperation<TIntent> {
  readonly operationId: string;
  readonly intent: TIntent;
  readonly order: number;
  readonly acceptedAtMs: number;
  readonly deadlineAtMs: number;
}

export interface OptimisticProjectionState<TCommitted, TIntent> {
  readonly committed: CommittedProjection<TCommitted>;
  readonly pending: readonly PendingProjectionOperation<TIntent>[];
  /** Recently terminal IDs make duplicate/reordered receipts harmless. */
  readonly terminalOperationIds: readonly string[];
  readonly nextOrder: number;
}

export type OperationTerminalPhase = "observed" | "rejected" | "timed-out";

export interface OptimisticProjectionOptions<TCommitted, TIntent> {
  readonly predict: (committed: TCommitted, intent: TIntent) => TCommitted;
  readonly terminalHistoryLimit?: number;
}

const DEFAULT_TERMINAL_HISTORY_LIMIT = 256;

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
  return value;
}

function safeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("committed revision must be a non-negative safe integer");
  }
  return value;
}

function finiteTime(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function terminalLimit<TCommitted, TIntent>(
  options: OptimisticProjectionOptions<TCommitted, TIntent>,
): number {
  const limit = options.terminalHistoryLimit ?? DEFAULT_TERMINAL_HISTORY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("terminal history limit must be a positive safe integer");
  }
  return limit;
}

function freezeState<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
): OptimisticProjectionState<TCommitted, TIntent> {
  return Object.freeze({
    ...state,
    committed: Object.freeze(state.committed),
    pending: Object.freeze([...state.pending]),
    terminalOperationIds: Object.freeze([...state.terminalOperationIds]),
  });
}

export function createOptimisticProjection<TCommitted, TIntent>(
  committed: CommittedProjection<TCommitted>,
): OptimisticProjectionState<TCommitted, TIntent> {
  return freezeState({
    committed: {
      generation: nonEmpty(committed.generation, "committed generation"),
      revision: safeRevision(committed.revision),
      value: committed.value,
    },
    pending: [],
    terminalOperationIds: [],
    nextOrder: 0,
  });
}

export function enqueueOptimisticOperation<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
  input: Omit<PendingProjectionOperation<TIntent>, "order">,
): OptimisticProjectionState<TCommitted, TIntent> {
  const operationId = nonEmpty(input.operationId, "operation id");
  if (
    state.terminalOperationIds.includes(operationId) ||
    state.pending.some((operation) => operation.operationId === operationId)
  ) {
    return state;
  }
  const acceptedAtMs = finiteTime(input.acceptedAtMs, "acceptedAtMs");
  const deadlineAtMs = finiteTime(input.deadlineAtMs, "deadlineAtMs");
  if (deadlineAtMs <= acceptedAtMs) throw new RangeError("deadline must follow acceptance");
  const pending = [
    ...state.pending,
    Object.freeze({
      operationId,
      intent: input.intent,
      order: state.nextOrder,
      acceptedAtMs,
      deadlineAtMs,
    }),
  ];
  return freezeState({ ...state, pending, nextOrder: state.nextOrder + 1 });
}

/**
 * Replace daemon truth and reconcile operation IDs included in that snapshot.
 * A generation replacement is valid even when its revision restarts at zero.
 */
export function replaceCommittedProjection<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
  committed: CommittedProjection<TCommitted>,
  options: {
    readonly observedOperationIds?: readonly string[];
    readonly nowMs: number;
  },
): OptimisticProjectionState<TCommitted, TIntent> {
  const generation = nonEmpty(committed.generation, "committed generation");
  const revision = safeRevision(committed.revision);
  if (generation === state.committed.generation && revision < state.committed.revision)
    return state;
  const observed = new Set(options.observedOperationIds ?? []);
  const nowMs = finiteTime(options.nowMs, "nowMs");
  const terminal = state.pending
    .filter(({ operationId, deadlineAtMs }) => observed.has(operationId) || deadlineAtMs <= nowMs)
    .map(({ operationId }) => operationId);
  return freezeState({
    ...state,
    committed: { generation, revision, value: committed.value },
    pending: state.pending.filter(
      ({ operationId, deadlineAtMs }) => !observed.has(operationId) && deadlineAtMs > nowMs,
    ),
    terminalOperationIds: [
      ...terminal,
      ...state.terminalOperationIds.filter((operationId) => !terminal.includes(operationId)),
    ].slice(0, DEFAULT_TERMINAL_HISTORY_LIMIT),
  });
}

/** Accepted keeps the prediction alive; every terminal phase removes it once. */
export function reconcileOptimisticOperation<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
  operationIdInput: string,
  phase: "accepted" | OperationTerminalPhase,
  options?: OptimisticProjectionOptions<TCommitted, TIntent>,
): OptimisticProjectionState<TCommitted, TIntent> {
  const operationId = nonEmpty(operationIdInput, "operation id");
  if (phase === "accepted" || state.terminalOperationIds.includes(operationId)) return state;
  const limit = options ? terminalLimit(options) : DEFAULT_TERMINAL_HISTORY_LIMIT;
  return freezeState({
    ...state,
    pending: state.pending.filter((operation) => operation.operationId !== operationId),
    terminalOperationIds: [operationId, ...state.terminalOperationIds].slice(0, limit),
  });
}

export function expireOptimisticOperations<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
  nowMs: number,
  options?: OptimisticProjectionOptions<TCommitted, TIntent>,
): OptimisticProjectionState<TCommitted, TIntent> {
  let next = state;
  for (const operation of state.pending) {
    if (operation.deadlineAtMs <= finiteTime(nowMs, "nowMs")) {
      next = reconcileOptimisticOperation(next, operation.operationId, "timed-out", options);
    }
  }
  return next;
}

/** Pure ordered prediction. No renderer, transport, timer, or tmux dependency. */
export function deriveOptimisticProjection<TCommitted, TIntent>(
  state: OptimisticProjectionState<TCommitted, TIntent>,
  options: OptimisticProjectionOptions<TCommitted, TIntent>,
): TCommitted {
  terminalLimit(options);
  return [...state.pending]
    .sort((left, right) => left.order - right.order)
    .reduce((value, operation) => options.predict(value, operation.intent), state.committed.value);
}
