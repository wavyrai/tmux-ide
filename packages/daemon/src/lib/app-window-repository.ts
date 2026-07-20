import { AppWindowDocumentV1SchemaZ, type AppWindowDocumentV1 } from "@tmux-ide/contracts";

import {
  RevisionConflictError,
  type JsonValue,
  type ProjectRuntimeRepository,
} from "./project-runtime-repository.ts";
import {
  AppWindowKernelError,
  applyAppWindowCommand,
  type AppWindowCommand,
} from "./app-window-kernel.ts";
import { withWorkspaceStateLock } from "./workspace-state-repository.ts";
import {
  emptyAppWindowDocument,
  migrateWorkspaceUiStateV2ToAppWindowDocument,
  parseAppWindowDocument,
  serializeAppWindowDocument,
  type AppWindowStateDiagnostic,
} from "../tui/mirror/app-window-state.ts";

export const APP_WINDOW_DOCUMENT_PATH = "ui/app-windows.json";
const LEGACY_WORKSPACE_UI_PATH = "ui/workspace.json";

export type AppWindowRepositoryDiagnosticCode =
  | AppWindowStateDiagnostic["code"]
  | "MISSING"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "WRITE_PROTECTED"
  | "MIGRATION_FAILED"
  | "REVISION_CONFLICT"
  | "RECOVERED";

export interface AppWindowRepositoryDiagnostic {
  code: AppWindowRepositoryDiagnosticCode;
  path: string;
  message: string;
}

export interface LoadedAppWindowDocument {
  document: AppWindowDocumentV1;
  revision: number | null;
  writeProtected: boolean;
  diagnostics: AppWindowRepositoryDiagnostic[];
  /** Exact parsed payload retained for inspection; never used as a write source. */
  preservedPayload?: unknown;
  /** Token required by explicit recovery. It identifies the exact on-disk bytes. */
  recoveryToken: string | null;
}

export interface LoadAppWindowDocumentOptions {
  loadedAt: string;
  migrateLegacy?: boolean;
  migratedAt?: string;
  terminalSourceIds?: readonly string[];
  focusedTerminalSourceId?: string | null;
}

export type AppWindowRepositoryErrorCode =
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "WRITE_PROTECTED"
  | "REVISION_CONFLICT"
  | "INVALID_DOCUMENT"
  | "RECOVERY_NOT_REQUIRED"
  | "RECOVERY_CONFLICT";

export class AppWindowRepositoryError extends Error {
  readonly code: AppWindowRepositoryErrorCode;
  readonly diagnostics: AppWindowRepositoryDiagnostic[];
  override readonly cause: unknown;

  constructor(
    code: AppWindowRepositoryErrorCode,
    message: string,
    diagnostics: AppWindowRepositoryDiagnostic[] = [],
    cause?: unknown,
  ) {
    super(message);
    this.name = "AppWindowRepositoryError";
    this.code = code;
    this.diagnostics = diagnostics;
    this.cause = cause;
  }
}

export interface ResetAppWindowDocumentRequest {
  expectedRecoveryToken: string;
  reason: string;
  resetAt: string;
  document?: AppWindowDocumentV1;
}

export interface ResetAppWindowDocumentResult extends LoadedAppWindowDocument {
  backupPath: string;
  metadataPath: string;
  reason: string;
}

export interface AppWindowServiceOptions {
  now?: () => string;
  migration?: Omit<LoadAppWindowDocumentOptions, "loadedAt" | "migratedAt">;
  writerLock?: AppWindowWriterLockOptions;
}

export interface AppWindowWriterLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface ExecuteAppWindowCommandOptions {
  /** When supplied, stale callers fail rather than rebasing the command. */
  expectedRevision?: number | null;
  maxRetries?: number;
}

export class AppWindowService {
  readonly #runtime: ProjectRuntimeRepository;
  readonly #now: () => string;
  readonly #migration: AppWindowServiceOptions["migration"];
  readonly #writerLock: AppWindowWriterLockOptions | undefined;

  constructor(runtime: ProjectRuntimeRepository, options: AppWindowServiceOptions = {}) {
    this.#runtime = runtime;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#migration = options.migration;
    this.#writerLock = options.writerLock;
  }

  load(): LoadedAppWindowDocument {
    const timestamp = this.#now();
    return loadAppWindowDocument(this.#runtime, {
      loadedAt: timestamp,
      migratedAt: timestamp,
      ...this.#migration,
    });
  }

  execute(
    command: AppWindowCommand,
    options: ExecuteAppWindowCommandOptions = {},
  ): LoadedAppWindowDocument {
    const expectedRevision = validateExpectedRevision(options.expectedRevision);
    return withAppWindowWriterLock(this.#runtime, this.#writerLock, () => {
      const retries = boundedRetries(options.maxRetries);
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const loaded = this.load();
        assertWritable(loaded);
        if (expectedRevision !== undefined && expectedRevision !== loaded.revision) {
          throw revisionError(expectedRevision, loaded.revision);
        }
        const clock = this.#now();
        const timestamp =
          Date.parse(clock) < Date.parse(loaded.document.updatedAt)
            ? loaded.document.updatedAt
            : clock;
        const next = applyAppWindowCommand(loaded.document, command, timestamp);
        try {
          return writeAppWindowDocument(this.#runtime, loaded.revision, next);
        } catch (error) {
          if (
            error instanceof AppWindowRepositoryError &&
            error.code === "REVISION_CONFLICT" &&
            expectedRevision === undefined &&
            attempt < retries
          ) {
            continue;
          }
          throw error;
        }
      }
      throw new Error("unreachable app-window retry exhaustion");
    });
  }

  reset(request: ResetAppWindowDocumentRequest): ResetAppWindowDocumentResult {
    return withAppWindowWriterLock(this.#runtime, this.#writerLock, () =>
      resetAppWindowDocument(this.#runtime, request),
    );
  }
}

export function loadAppWindowDocument(
  repository: ProjectRuntimeRepository,
  options: LoadAppWindowDocumentOptions,
): LoadedAppWindowDocument {
  let runtimeDocument;
  try {
    runtimeDocument = repository.readDocument<unknown>(APP_WINDOW_DOCUMENT_PATH);
  } catch (error) {
    return protectedReadFailure(repository, options.loadedAt, error);
  }
  if (!runtimeDocument.found) {
    if (options.migrateLegacy !== false) {
      const migration = attemptFirstMigration(repository, options);
      if (migration) return migration;
    }
    return {
      document: emptyAppWindowDocument(options.loadedAt),
      revision: null,
      writeProtected: false,
      diagnostics: [diagnostic("MISSING", APP_WINDOW_DOCUMENT_PATH, "app window state is absent")],
      recoveryToken: null,
    };
  }
  const parsed = parseAppWindowDocument(runtimeDocument.payload, options.loadedAt);
  const diagnostics = parsed.diagnostics.map((entry) => ({ ...entry }));
  const writeProtected = parsed.writeProtected || diagnostics.length > 0;
  return {
    document: parsed.document,
    revision: runtimeDocument.revision,
    writeProtected,
    diagnostics,
    ...(writeProtected ? { preservedPayload: structuredClone(runtimeDocument.payload) } : {}),
    recoveryToken: safeRecoveryToken(repository),
  };
}

export function writeAppWindowDocument(
  repository: ProjectRuntimeRepository,
  expectedRevision: number | null,
  document: AppWindowDocumentV1,
): LoadedAppWindowDocument {
  const validation = AppWindowDocumentV1SchemaZ.safeParse(document);
  if (!validation.success) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      validation.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const loaded = loadAppWindowDocument(repository, {
    loadedAt: validation.data.updatedAt,
    migrateLegacy: false,
  });
  assertWritable(loaded);
  if (loaded.revision !== expectedRevision) throw revisionError(expectedRevision, loaded.revision);
  assertNextDocumentRevision(loaded, validation.data);
  try {
    const payload = JSON.parse(serializeAppWindowDocument(validation.data)) as JsonValue;
    const written = repository.writeDocument(APP_WINDOW_DOCUMENT_PATH, payload, {
      expectedRevision,
    });
    return {
      document: validation.data,
      revision: written.revision,
      writeProtected: false,
      diagnostics: [],
      recoveryToken: safeRecoveryToken(repository),
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      throw revisionError(error.expectedRevision, error.actualRevision, error);
    }
    throw new AppWindowRepositoryError(
      "WRITE_FAILED",
      `app window state could not be written: ${(error as Error).message}`,
      [diagnostic("WRITE_FAILED", APP_WINDOW_DOCUMENT_PATH, (error as Error).message)],
      error,
    );
  }
}

export function resetAppWindowDocument(
  repository: ProjectRuntimeRepository,
  request: ResetAppWindowDocumentRequest,
): ResetAppWindowDocumentResult {
  const loaded = loadAppWindowDocument(repository, {
    loadedAt: request.resetAt,
    migrateLegacy: false,
  });
  if (!loaded.writeProtected) {
    throw new AppWindowRepositoryError(
      "RECOVERY_NOT_REQUIRED",
      "app window state is valid; normal revision CAS must be used",
    );
  }
  if (!loaded.recoveryToken || loaded.recoveryToken !== request.expectedRecoveryToken) {
    throw new AppWindowRepositoryError(
      "RECOVERY_CONFLICT",
      "app window recovery token no longer matches the preserved document",
    );
  }
  let resetDocument: unknown = request.document;
  if (resetDocument === undefined) {
    try {
      resetDocument = emptyAppWindowDocument(request.resetAt);
    } catch (error) {
      throw new AppWindowRepositoryError(
        "INVALID_DOCUMENT",
        `resetAt must be a valid app window timestamp: ${(error as Error).message}`,
        [],
        error,
      );
    }
  }
  const validation = AppWindowDocumentV1SchemaZ.safeParse(resetDocument);
  if (!validation.success) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      validation.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  const document = validation.data;
  try {
    const payload = JSON.parse(serializeAppWindowDocument(document)) as JsonValue;
    const recovered = repository.recoverDocument(APP_WINDOW_DOCUMENT_PATH, payload, {
      expectedRawSha256: request.expectedRecoveryToken,
      reason: request.reason,
      details: {
        diagnostics: loaded.diagnostics.map((entry) => ({ ...entry })),
      },
    });
    return {
      document,
      revision: recovered.revision,
      writeProtected: false,
      diagnostics: [
        diagnostic(
          "RECOVERED",
          APP_WINDOW_DOCUMENT_PATH,
          `app window state was explicitly reset; prior bytes preserved at ${recovered.backupPath}`,
        ),
      ],
      recoveryToken: safeRecoveryToken(repository),
      backupPath: recovered.backupPath,
      metadataPath: recovered.metadataPath,
      reason: recovered.reason,
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      throw new AppWindowRepositoryError(
        "RECOVERY_CONFLICT",
        "app window document changed before explicit recovery",
        [],
        error,
      );
    }
    throw new AppWindowRepositoryError(
      "WRITE_FAILED",
      `app window recovery failed: ${(error as Error).message}`,
      [],
      error,
    );
  }
}

function assertNextDocumentRevision(
  loaded: LoadedAppWindowDocument,
  next: AppWindowDocumentV1,
): void {
  if (loaded.revision === null) {
    if (next.revision === 0 || next.revision === 1) return;
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      "a new app window document must start at domain revision 0 or 1",
    );
  }
  if (next.revision !== loaded.document.revision + 1) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      `app window domain revision must advance exactly once from ${loaded.document.revision}`,
    );
  }
  if (Date.parse(next.updatedAt) < Date.parse(loaded.document.updatedAt)) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      "app window updatedAt must not move backwards",
    );
  }
}

function withAppWindowWriterLock<T>(
  repository: ProjectRuntimeRepository,
  options: AppWindowWriterLockOptions | undefined,
  action: () => T,
): T {
  try {
    return withWorkspaceStateLock(repository, options, action);
  } catch (error) {
    if (error instanceof AppWindowRepositoryError || error instanceof AppWindowKernelError) {
      throw error;
    }
    throw new AppWindowRepositoryError(
      "WRITE_FAILED",
      `app window writer lock failed: ${(error as Error).message}`,
      [diagnostic("WRITE_FAILED", APP_WINDOW_DOCUMENT_PATH, (error as Error).message)],
      error,
    );
  }
}

function attemptFirstMigration(
  repository: ProjectRuntimeRepository,
  options: LoadAppWindowDocumentOptions,
): LoadedAppWindowDocument | null {
  let legacy;
  try {
    legacy = repository.readDocument<unknown>(LEGACY_WORKSPACE_UI_PATH);
  } catch (error) {
    return {
      document: emptyAppWindowDocument(options.loadedAt),
      revision: null,
      writeProtected: false,
      diagnostics: [
        diagnostic(
          "MIGRATION_FAILED",
          LEGACY_WORKSPACE_UI_PATH,
          `legacy workspace UI state could not be read: ${(error as Error).message}`,
        ),
      ],
      recoveryToken: null,
    };
  }
  if (!legacy.found) return null;
  try {
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(legacy.payload, {
      migratedAt: options.migratedAt ?? options.loadedAt,
      terminalSourceIds: options.terminalSourceIds,
      focusedTerminalSourceId: options.focusedTerminalSourceId,
    });
    const payload = JSON.parse(serializeAppWindowDocument(migrated.document)) as JsonValue;
    const written = repository.writeDocument(APP_WINDOW_DOCUMENT_PATH, payload, {
      expectedRevision: null,
    });
    return {
      document: migrated.document,
      revision: written.revision,
      writeProtected: false,
      diagnostics: migrated.diagnostics,
      recoveryToken: safeRecoveryToken(repository),
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return loadAppWindowDocument(repository, { ...options, migrateLegacy: false });
    }
    return {
      document: emptyAppWindowDocument(options.loadedAt),
      revision: null,
      writeProtected: false,
      diagnostics: [
        diagnostic(
          "MIGRATION_FAILED",
          LEGACY_WORKSPACE_UI_PATH,
          `legacy workspace UI state was not migrated: ${(error as Error).message}`,
        ),
      ],
      recoveryToken: null,
    };
  }
}

function protectedReadFailure(
  repository: ProjectRuntimeRepository,
  loadedAt: string,
  error: unknown,
): LoadedAppWindowDocument {
  return {
    document: emptyAppWindowDocument(loadedAt),
    revision: null,
    writeProtected: true,
    diagnostics: [
      diagnostic(
        "READ_FAILED",
        APP_WINDOW_DOCUMENT_PATH,
        `app window state could not be read safely: ${(error as Error).message}`,
      ),
    ],
    recoveryToken: safeRecoveryToken(repository),
  };
}

function assertWritable(loaded: LoadedAppWindowDocument): void {
  if (!loaded.writeProtected) return;
  throw new AppWindowRepositoryError(
    "WRITE_PROTECTED",
    "app window state is not safe to overwrite without explicit recovery",
    [
      ...loaded.diagnostics,
      diagnostic(
        "WRITE_PROTECTED",
        APP_WINDOW_DOCUMENT_PATH,
        "preserved current app window bytes without writing",
      ),
    ],
  );
}

function safeRecoveryToken(repository: ProjectRuntimeRepository): string | null {
  try {
    return repository.documentRecoveryToken(APP_WINDOW_DOCUMENT_PATH);
  } catch {
    return null;
  }
}

function revisionError(
  expected: number | null,
  actual: number | null,
  cause?: unknown,
): AppWindowRepositoryError {
  return new AppWindowRepositoryError(
    "REVISION_CONFLICT",
    `app window revision conflict: expected ${String(expected)}, actual ${String(actual)}`,
    [
      diagnostic(
        "REVISION_CONFLICT",
        APP_WINDOW_DOCUMENT_PATH,
        `expected ${String(expected)}, actual ${String(actual)}`,
      ),
    ],
    cause,
  );
}

function boundedRetries(value: number | undefined): number {
  if (value === undefined) return 2;
  if (!Number.isInteger(value) || value < 0 || value > 8) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      "maxRetries must be an integer between 0 and 8",
    );
  }
  return value;
}

function validateExpectedRevision(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppWindowRepositoryError(
      "INVALID_DOCUMENT",
      "expectedRevision must be null or a nonnegative safe integer",
    );
  }
  return value;
}

function diagnostic(
  code: AppWindowRepositoryDiagnosticCode,
  path: string,
  message: string,
): AppWindowRepositoryDiagnostic {
  return { code, path, message };
}
