import type {
  CommittedProjection,
  OperationTerminalPhase,
  OptimisticProjectionOptions,
} from "./optimistic-projection.ts";
import { OptimisticProjectionStore } from "./optimistic-projection-store.ts";

export type OptimisticConformanceCommand<TCommitted, TIntent> =
  | {
      readonly type: "enqueue";
      readonly operationId: string;
      readonly intent: TIntent;
      readonly acceptedAtMs: number;
      readonly deadlineAtMs: number;
    }
  | {
      readonly type: "receipt";
      readonly operationId: string;
      readonly phase: "accepted" | OperationTerminalPhase;
    }
  | {
      readonly type: "replace";
      readonly committed: CommittedProjection<TCommitted>;
      readonly observedOperationIds?: readonly string[];
      readonly nowMs: number;
    }
  | { readonly type: "expire"; readonly nowMs: number };
export interface OptimisticConformanceFixture<TCommitted, TIntent> {
  readonly name: string;
  readonly committed: CommittedProjection<TCommitted>;
  readonly commands: readonly OptimisticConformanceCommand<TCommitted, TIntent>[];
}
export function runOptimisticProjectionConformance<TCommitted, TIntent>(
  fixture: OptimisticConformanceFixture<TCommitted, TIntent>,
  options: OptimisticProjectionOptions<TCommitted, TIntent>,
): readonly unknown[] {
  const store = new OptimisticProjectionStore(fixture.committed, options);
  const observations: unknown[] = [];
  store.subscribe(({ state, derived }) =>
    observations.push({
      generation: state.committed.generation,
      revision: state.committed.revision,
      derived,
      pending: state.pending.map(({ operationId }) => operationId),
      terminal: [...state.terminalOperationIds],
    }),
  );
  for (const command of fixture.commands) {
    if (command.type === "enqueue") store.enqueue(command);
    else if (command.type === "receipt") store.receipt(command.operationId, command.phase);
    else if (command.type === "expire") store.expire(command.nowMs);
    else
      store.replaceCommitted(command.committed, {
        ...(command.observedOperationIds
          ? { observedOperationIds: command.observedOperationIds }
          : {}),
        nowMs: command.nowMs,
      });
  }
  return Object.freeze(observations);
}
