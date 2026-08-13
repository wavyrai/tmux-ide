import { randomUUID } from "node:crypto";

import type {
  WorkspaceOpenCancelledResult,
  WorkspaceOpenCommittedResult,
  WorkspaceOpenDecisionArguments,
  WorkspaceOpenMutationRequest,
  WorkspaceOpenMutationResult,
  WorkspaceOpenPrepareArguments,
  WorkspaceOpenPreparedResult,
  WorkspacePromoteMutationRequest,
  WorkspacePromoteMutationResult,
} from "@tmux-ide/contracts";

export type WorkspaceOpenHandoffErrorCode =
  | "daemon_instance_mismatch"
  | "workspace_prepare_superseded"
  | "workspace_prepare_not_found"
  | "workspace_prepare_expired"
  | "workspace_prepare_conflict"
  | "workspace_prepare_failed"
  | "workspace_prepare_disposed";

export class WorkspaceOpenHandoffError extends Error {
  readonly code: WorkspaceOpenHandoffErrorCode;

  constructor(code: WorkspaceOpenHandoffErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceOpenHandoffError";
    this.code = code;
  }
}

export interface WorkspaceOpenPreparationProof {
  readonly semanticPaneId: string;
  readonly paneCount: number;
  readonly terminalRevision: number;
  readonly terminalStateHash: string;
}

export interface WorkspaceOpenHandoffDependencies {
  readonly daemonInstanceId: string;
  readonly openProject: (
    request: WorkspaceOpenMutationRequest,
  ) => Promise<WorkspaceOpenMutationResult>;
  readonly adoptLiveSession: (
    request: WorkspacePromoteMutationRequest,
  ) => Promise<WorkspacePromoteMutationResult>;
  /** Prewarms the canonical SessionRuntime and resolves only after layout + first seed. */
  readonly prepareRuntime: (
    workspaceName: string,
    preferredPaneId?: string,
  ) => Promise<WorkspaceOpenPreparationProof>;
  /** Keeps the prior client selection hot while the candidate is proven. */
  readonly prewarmPrevious?: (workspaceName: string) => Promise<void>;
  readonly prepareTtlMs?: number;
  readonly maxLiveClients?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface PreparedRecord {
  readonly ownerClientId: string;
  readonly token: string;
  readonly revision: number;
  readonly workspaceName: string;
  readonly previousWorkspaceName: string | null;
  readonly result: WorkspaceOpenPreparedResult;
  readonly expiryTimer: ReturnType<typeof setTimeout>;
  readonly expiresAt: number;
}

/**
 * Client-local, generation-fenced two-phase workspace handoff.
 *
 * Preparation may make a workspace discoverable, but it never changes a
 * client's selection. Only the matching latest token can commit. The daemon's
 * SessionRuntime remains the sole terminal authority throughout.
 */
export class WorkspaceOpenHandoffCoordinator {
  readonly #deps: WorkspaceOpenHandoffDependencies;
  readonly #prepareTtlMs: number;
  readonly #maxLiveClients: number;
  readonly #setTimer: NonNullable<WorkspaceOpenHandoffDependencies["setTimer"]>;
  readonly #clearTimer: NonNullable<WorkspaceOpenHandoffDependencies["clearTimer"]>;
  readonly #now: NonNullable<WorkspaceOpenHandoffDependencies["now"]>;
  readonly #latestRevisionByClient = new Map<string, number>();
  readonly #preparedByToken = new Map<string, PreparedRecord>();
  readonly #expiredTokens = new Set<string>();
  #disposed = false;

  constructor(deps: WorkspaceOpenHandoffDependencies) {
    this.#deps = deps;
    this.#prepareTtlMs = deps.prepareTtlMs ?? 15_000;
    this.#maxLiveClients = deps.maxLiveClients ?? 256;
    this.#now = deps.now ?? Date.now;
    this.#setTimer =
      deps.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return timer;
      });
    this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    if (this.#prepareTtlMs <= 0 || this.#maxLiveClients <= 0) {
      throw new Error("Workspace handoff TTL and client capacity must be positive.");
    }
  }

  async prepare(
    operationId: string,
    expectedDaemonInstanceId: string,
    ownerClientId: string,
    intent: WorkspaceOpenPrepareArguments,
  ): Promise<WorkspaceOpenPreparedResult> {
    this.#assertAvailable(expectedDaemonInstanceId);
    const revision = this.#beginClientRevision(ownerClientId);

    const previousWorkspaceName = intent.previousWorkspaceName ?? null;
    try {
      if (previousWorkspaceName && this.#deps.prewarmPrevious) {
        await this.#deps.prewarmPrevious(previousWorkspaceName);
      }
      const opened =
        intent.source.kind === "project"
          ? await this.#deps.openProject({
              operationId,
              expectedDaemonInstanceId,
              intent: { projectDir: intent.source.projectDir },
            })
          : await this.#deps.adoptLiveSession({
              operationId,
              expectedDaemonInstanceId,
              intent: { sessionId: intent.source.sessionId },
            });
      this.#assertCurrent(ownerClientId, revision, expectedDaemonInstanceId);

      const workspaceName = opened.resource.workspaceName;
      const preferredPaneId =
        "initialPaneId" in opened.resource ? opened.resource.initialPaneId : undefined;
      const proof = await this.#deps.prepareRuntime(workspaceName, preferredPaneId);
      this.#assertCurrent(ownerClientId, revision, expectedDaemonInstanceId);

      const token = randomUUID();
      const result: WorkspaceOpenPreparedResult = {
        operationId,
        daemonInstanceId: this.#deps.daemonInstanceId,
        phase: "prepared",
        prepareToken: token,
        preparedRevision: revision,
        outcome: opened.outcome,
        workspaceName,
        previousWorkspaceName,
        proof,
      };
      this.#dropClientRecords(ownerClientId);
      const expiryTimer = this.#setTimer(() => this.#expire(token), this.#prepareTtlMs);
      this.#preparedByToken.set(token, {
        ownerClientId,
        token,
        revision,
        workspaceName,
        previousWorkspaceName,
        result,
        expiryTimer,
        expiresAt: this.#now() + this.#prepareTtlMs,
      });
      return result;
    } catch (error) {
      if (error instanceof WorkspaceOpenHandoffError) throw error;
      throw new WorkspaceOpenHandoffError(
        "workspace_prepare_failed",
        error instanceof Error ? error.message : "Workspace preparation failed.",
      );
    }
  }

  commit(
    operationId: string,
    expectedDaemonInstanceId: string,
    ownerClientId: string,
    intent: WorkspaceOpenDecisionArguments,
  ): WorkspaceOpenCommittedResult {
    const record = this.#decisionRecord(expectedDaemonInstanceId, ownerClientId, intent);
    this.#consume(record);
    return this.#decisionResult(operationId, record, "committed");
  }

  cancel(
    operationId: string,
    expectedDaemonInstanceId: string,
    ownerClientId: string,
    intent: WorkspaceOpenDecisionArguments,
  ): WorkspaceOpenCancelledResult {
    const record = this.#decisionRecord(expectedDaemonInstanceId, ownerClientId, intent);
    this.#consume(record);
    return this.#decisionResult(operationId, record, "cancelled");
  }

  #decisionRecord(
    expectedDaemonInstanceId: string,
    ownerClientId: string,
    intent: WorkspaceOpenDecisionArguments,
  ): PreparedRecord {
    this.#assertAvailable(expectedDaemonInstanceId);
    const record = this.#preparedByToken.get(intent.prepareToken);
    if (record && this.#now() >= record.expiresAt) {
      this.#expire(record.token);
    }
    const liveRecord = this.#preparedByToken.get(intent.prepareToken);
    if (!liveRecord) {
      if (this.#expiredTokens.delete(intent.prepareToken)) {
        throw new WorkspaceOpenHandoffError(
          "workspace_prepare_expired",
          "Prepare token expired before a decision was made.",
        );
      }
      throw new WorkspaceOpenHandoffError(
        "workspace_prepare_not_found",
        "Prepare token is no longer live.",
      );
    }
    if (
      liveRecord.ownerClientId !== ownerClientId ||
      liveRecord.revision !== intent.preparedRevision ||
      this.#latestRevisionByClient.get(ownerClientId) !== liveRecord.revision
    ) {
      throw new WorkspaceOpenHandoffError(
        "workspace_prepare_conflict",
        "Prepare token does not own the latest client revision.",
      );
    }
    return liveRecord;
  }

  #decisionResult<T extends "committed" | "cancelled">(
    operationId: string,
    record: PreparedRecord,
    phase: T,
  ): T extends "committed" ? WorkspaceOpenCommittedResult : WorkspaceOpenCancelledResult {
    return {
      operationId,
      daemonInstanceId: this.#deps.daemonInstanceId,
      prepareToken: record.token,
      preparedRevision: record.revision,
      phase,
      workspaceName: record.workspaceName,
      previousWorkspaceName: record.previousWorkspaceName,
    } as T extends "committed" ? WorkspaceOpenCommittedResult : WorkspaceOpenCancelledResult;
  }

  #assertGeneration(expected: string): void {
    if (expected !== this.#deps.daemonInstanceId) {
      throw new WorkspaceOpenHandoffError(
        "daemon_instance_mismatch",
        "Daemon generation changed during workspace handoff.",
      );
    }
  }

  #assertAvailable(expected: string): void {
    if (this.#disposed) {
      throw new WorkspaceOpenHandoffError(
        "workspace_prepare_disposed",
        "Workspace handoff coordinator has stopped.",
      );
    }
    this.#assertGeneration(expected);
  }

  #assertCurrent(ownerClientId: string, revision: number, generation: string): void {
    this.#assertAvailable(generation);
    if (this.#latestRevisionByClient.get(ownerClientId) !== revision) {
      throw new WorkspaceOpenHandoffError(
        "workspace_prepare_superseded",
        "A newer workspace prepare superseded this request.",
      );
    }
  }

  #dropClientRecords(ownerClientId: string): void {
    for (const [token, record] of this.#preparedByToken) {
      if (record.ownerClientId === ownerClientId) {
        this.#clearTimer(record.expiryTimer);
        this.#preparedByToken.delete(token);
      }
    }
  }

  #beginClientRevision(ownerClientId: string): number {
    const previous = this.#latestRevisionByClient.get(ownerClientId);
    if (previous !== undefined) this.#latestRevisionByClient.delete(ownerClientId);
    while (previous === undefined && this.#latestRevisionByClient.size >= this.#maxLiveClients) {
      const oldestClientId = this.#latestRevisionByClient.keys().next().value as string | undefined;
      if (!oldestClientId) break;
      this.#dropClientRecords(oldestClientId);
      this.#latestRevisionByClient.delete(oldestClientId);
    }
    const revision = (previous ?? 0) + 1;
    this.#latestRevisionByClient.set(ownerClientId, revision);
    return revision;
  }

  #expire(token: string): void {
    const record = this.#preparedByToken.get(token);
    if (!record) return;
    this.#clearTimer(record.expiryTimer);
    this.#preparedByToken.delete(token);
    if (this.#latestRevisionByClient.get(record.ownerClientId) === record.revision) {
      this.#latestRevisionByClient.delete(record.ownerClientId);
    }
    this.#expiredTokens.add(token);
    while (this.#expiredTokens.size > this.#maxLiveClients) {
      const oldest = this.#expiredTokens.values().next().value as string | undefined;
      if (!oldest) break;
      this.#expiredTokens.delete(oldest);
    }
  }

  #consume(record: PreparedRecord): void {
    this.#clearTimer(record.expiryTimer);
    this.#preparedByToken.delete(record.token);
    if (this.#latestRevisionByClient.get(record.ownerClientId) === record.revision) {
      this.#latestRevisionByClient.delete(record.ownerClientId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of this.#preparedByToken.values()) this.#clearTimer(record.expiryTimer);
    this.#preparedByToken.clear();
    this.#latestRevisionByClient.clear();
    this.#expiredTokens.clear();
  }
}
