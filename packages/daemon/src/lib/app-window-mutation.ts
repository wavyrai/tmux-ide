import {
  AppWindowMutationRequestSchemaZ,
  AppWindowMutationResultSchemaZ,
  type AppWindowMutationRequest,
  type AppWindowMutationResult,
} from "@tmux-ide/contracts";

import { AppWindowKernelError } from "./app-window-kernel.ts";
import { AppWindowRepositoryError, AppWindowService } from "./app-window-repository.ts";
import {
  openProjectRuntimeRepository,
  type ProjectRuntimeRepository,
} from "./project-runtime-repository.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

const MAX_OPERATIONS = 256;

export type AppWindowMutationErrorCode =
  | "daemon_instance_mismatch"
  | "workspace_not_found"
  | "workspace_unavailable"
  | "revision_conflict"
  | "operation_conflict"
  | "operation_capacity"
  | "document_unavailable"
  | "mutation_failed";

const ERROR_MESSAGES: Readonly<Record<AppWindowMutationErrorCode, string>> = {
  daemon_instance_mismatch: "The daemon generation changed before the app window was updated.",
  workspace_not_found: "The requested workspace is not registered.",
  workspace_unavailable: "The requested workspace is unavailable for app-window mutation.",
  revision_conflict: "The app-window document changed before this command was applied.",
  operation_conflict: "The operation id was already used for a different app-window command.",
  operation_capacity: "The daemon has reached its bounded app-window operation capacity.",
  document_unavailable: "The durable app-window document is unavailable.",
  mutation_failed: "The durable app-window command could not be applied.",
};

export class AppWindowMutationError extends Error {
  constructor(
    readonly code: AppWindowMutationErrorCode,
    readonly context: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "AppWindowMutationError";
  }
}

interface AppWindowMutationRegistry {
  get(name: string): { readonly projectDir: string } | null | undefined;
}

interface OperationRecord {
  readonly fingerprint: string;
  readonly result: Promise<AppWindowMutationResult>;
  settled: boolean;
}

export interface AppWindowMutationAuthorityOptions {
  readonly daemonInstanceId: string;
  readonly registry: Pick<WorkspaceRegistry, "get"> | AppWindowMutationRegistry;
  readonly openRuntime?: (projectDir: string) => Promise<ProjectRuntimeRepository>;
  readonly maxOperations?: number;
}

function boundedOperationLimit(value: number | undefined): number {
  if (value === undefined) return MAX_OPERATIONS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_OPERATIONS) {
    throw new TypeError(
      `app-window operation limit must be an integer from 1 to ${MAX_OPERATIONS}`,
    );
  }
  return value;
}

function translateMutationError(error: unknown): AppWindowMutationError {
  if (error instanceof AppWindowMutationError) return error;
  if (error instanceof AppWindowRepositoryError) {
    if (error.code === "REVISION_CONFLICT") {
      return new AppWindowMutationError("revision_conflict", {}, error);
    }
    if (error.code === "WRITE_PROTECTED" || error.code === "READ_FAILED") {
      return new AppWindowMutationError("document_unavailable", {}, error);
    }
    return new AppWindowMutationError("mutation_failed", {}, error);
  }
  if (error instanceof AppWindowKernelError) {
    return new AppWindowMutationError("mutation_failed", { path: error.path }, error);
  }
  return new AppWindowMutationError("workspace_unavailable", {}, error);
}

/** Daemon-generation-owned semantic authority over the persisted AppWindow document. */
export class AppWindowMutationAuthority {
  readonly #daemonInstanceId: string;
  readonly #registry: AppWindowMutationRegistry;
  readonly #openRuntime: (projectDir: string) => Promise<ProjectRuntimeRepository>;
  readonly #maxOperations: number;
  readonly #operations = new Map<string, OperationRecord>();
  #disposed = false;

  constructor(options: AppWindowMutationAuthorityOptions) {
    this.#daemonInstanceId = options.daemonInstanceId;
    this.#registry = options.registry;
    this.#openRuntime = options.openRuntime ?? openProjectRuntimeRepository;
    this.#maxOperations = boundedOperationLimit(options.maxOperations);
  }

  async mutate(rawRequest: AppWindowMutationRequest): Promise<AppWindowMutationResult> {
    if (this.#disposed) throw new AppWindowMutationError("workspace_unavailable");
    const request = AppWindowMutationRequestSchemaZ.parse(rawRequest);
    if (request.expectedDaemonInstanceId !== this.#daemonInstanceId) {
      throw new AppWindowMutationError("daemon_instance_mismatch");
    }
    const fingerprint = JSON.stringify(request);
    const existing = this.#operations.get(request.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AppWindowMutationError("operation_conflict");
      }
      const result = await existing.result;
      return AppWindowMutationResultSchemaZ.parse({ ...result, outcome: "replayed" });
    }
    if (this.#operations.size >= this.#maxOperations) {
      const settled = [...this.#operations].find(([, record]) => record.settled);
      if (!settled) throw new AppWindowMutationError("operation_capacity");
      this.#operations.delete(settled[0]);
    }
    const result = this.#execute(request);
    const record: OperationRecord = { fingerprint, result, settled: false };
    this.#operations.set(request.operationId, record);
    try {
      return await result;
    } catch (error) {
      this.#operations.delete(request.operationId);
      throw error;
    } finally {
      record.settled = true;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#operations.clear();
  }

  async #execute(request: AppWindowMutationRequest): Promise<AppWindowMutationResult> {
    try {
      const workspace = this.#registry.get(request.intent.workspaceName);
      if (!workspace) throw new AppWindowMutationError("workspace_not_found");
      const runtime = await this.#openRuntime(workspace.projectDir);
      if (this.#disposed) throw new AppWindowMutationError("workspace_unavailable");
      const service = new AppWindowService(runtime);
      const loaded = service.load();
      if (loaded.writeProtected) throw new AppWindowMutationError("document_unavailable");
      if (loaded.document.revision !== request.intent.expectedDocumentRevision) {
        throw new AppWindowMutationError("revision_conflict", {
          expectedRevision: String(request.intent.expectedDocumentRevision),
          actualRevision: String(loaded.document.revision),
        });
      }
      // execute performs its satisfied check while holding the repository's
      // writer lock and pins the storage revision, so unchanged is linearizable.
      const next = service.execute(request.intent.command, { expectedRevision: loaded.revision });
      const unchanged = next.document.revision === loaded.document.revision;
      return AppWindowMutationResultSchemaZ.parse({
        operationId: request.operationId,
        daemonInstanceId: this.#daemonInstanceId,
        outcome: unchanged ? "unchanged" : "applied",
        workspaceName: request.intent.workspaceName,
        documentRevision: next.document.revision,
      });
    } catch (error) {
      throw translateMutationError(error);
    }
  }
}
