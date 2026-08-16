import type { InteractionReceipt } from "@tmux-ide/contracts";

import type { GenerationBoundClock } from "./generation-bound-store.ts";
import { acquireRuntimeResource } from "./runtime-resource-ledger.ts";

export interface WorkspaceClientPendingOperation {
  readonly operationId: string;
  readonly generation: number;
  readonly kind: "semantic-intent" | "owner-action";
  readonly acceptedAt: number;
  readonly deadlineAt: number;
  readonly phase: "pending" | "accepted";
}

export interface WorkspaceClientOperationSnapshot {
  readonly pending: readonly WorkspaceClientPendingOperation[];
  readonly terminalOperationIds: readonly string[];
  readonly lastReceipt: InteractionReceipt | null;
}

export interface WorkspaceClientOperationLedger {
  getSnapshot(): WorkspaceClientOperationSnapshot;
  begin(input: {
    readonly operationId: string;
    readonly generation: number;
    readonly kind: WorkspaceClientPendingOperation["kind"];
    readonly timeoutMs: number;
  }): boolean;
  receipt(receipt: InteractionReceipt, generation: number): boolean;
  terminal(operationId: string, generation: number): boolean;
  replaceGeneration(generation: number): void;
  dispose(): void;
}

const TERMINAL_HISTORY_LIMIT = 256;

/**
 * One small exactly-once ledger for every renderer. It owns operation timeouts
 * and deliberately knows nothing about transport, projections, or UI state.
 */
export function createWorkspaceClientOperationLedger(options: {
  readonly clock: GenerationBoundClock;
  readonly initialGeneration: number;
  readonly onChange: () => void;
}): WorkspaceClientOperationLedger {
  const pending = new Map<
    string,
    { operation: WorkspaceClientPendingOperation; timer: unknown; releaseTimer: () => void }
  >();
  const terminal = new Set<string>();
  let terminalOrder: string[] = [];
  let lastReceipt: InteractionReceipt | null = null;
  let generation = options.initialGeneration;
  let disposed = false;

  const publish = (): void => {
    if (!disposed) options.onChange();
  };
  const rememberTerminal = (operationId: string): void => {
    if (terminal.has(operationId)) return;
    terminal.add(operationId);
    terminalOrder = [operationId, ...terminalOrder].slice(0, TERMINAL_HISTORY_LIMIT);
    terminal.clear();
    for (const id of terminalOrder) terminal.add(id);
  };
  const settle = (operationId: string, expectedGeneration: number): boolean => {
    if (disposed || expectedGeneration !== generation || terminal.has(operationId)) return false;
    const entry = pending.get(operationId);
    if (entry === undefined || entry.operation.generation !== expectedGeneration) return false;
    options.clock.clearTimeout(entry.timer);
    entry.releaseTimer();
    pending.delete(operationId);
    rememberTerminal(operationId);
    publish();
    return true;
  };

  return {
    getSnapshot() {
      return Object.freeze({
        pending: Object.freeze([...pending.values()].map(({ operation }) => operation)),
        terminalOperationIds: Object.freeze([...terminalOrder]),
        lastReceipt,
      });
    },
    begin(input) {
      if (
        disposed ||
        input.generation !== generation ||
        terminal.has(input.operationId) ||
        pending.has(input.operationId)
      ) {
        return false;
      }
      const acceptedAt = options.clock.now();
      const operation: WorkspaceClientPendingOperation = Object.freeze({
        operationId: input.operationId,
        generation: input.generation,
        kind: input.kind,
        acceptedAt,
        deadlineAt: acceptedAt + input.timeoutMs,
        phase: "pending",
      });
      const releaseTimer = acquireRuntimeResource("runtime-timer");
      const timer = options.clock.setTimeout(() => {
        releaseTimer();
        settle(input.operationId, input.generation);
      }, input.timeoutMs);
      pending.set(input.operationId, { operation, timer, releaseTimer });
      publish();
      return true;
    },
    receipt(receipt, expectedGeneration) {
      if (disposed || expectedGeneration !== generation) return false;
      if (receipt.phase === "accepted") {
        const entry = pending.get(receipt.operationId);
        if (
          entry === undefined ||
          entry.operation.generation !== expectedGeneration ||
          entry.operation.phase === "accepted"
        ) {
          return false;
        }
        pending.set(receipt.operationId, {
          ...entry,
          operation: Object.freeze({ ...entry.operation, phase: "accepted" }),
        });
        lastReceipt = receipt;
        publish();
        return true;
      }
      if (terminal.has(receipt.operationId)) return false;
      const entry = pending.get(receipt.operationId);
      if (entry === undefined || entry.operation.generation !== expectedGeneration) return false;
      options.clock.clearTimeout(entry.timer);
      entry.releaseTimer();
      pending.delete(receipt.operationId);
      rememberTerminal(receipt.operationId);
      lastReceipt = receipt;
      publish();
      return true;
    },
    terminal: settle,
    replaceGeneration(nextGeneration) {
      if (disposed || nextGeneration === generation) return;
      generation = nextGeneration;
      for (const { timer, releaseTimer } of pending.values()) {
        options.clock.clearTimeout(timer);
        releaseTimer();
      }
      pending.clear();
      terminal.clear();
      terminalOrder = [];
      lastReceipt = null;
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const { timer, releaseTimer } of pending.values()) {
        options.clock.clearTimeout(timer);
        releaseTimer();
      }
      pending.clear();
      terminal.clear();
      terminalOrder = [];
      lastReceipt = null;
    },
  };
}
