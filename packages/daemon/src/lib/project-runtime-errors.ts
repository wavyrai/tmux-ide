export type ProjectRuntimeErrorCode =
  | "INVALID_PATH"
  | "DOCUMENT_MISSING"
  | "DOCUMENT_CORRUPT"
  | "UNSUPPORTED_DOCUMENT_VERSION"
  | "INVALID_JSON_VALUE"
  | "REVISION_CONFLICT"
  | "EVENT_SEQUENCE_CONFLICT"
  | "EVENT_LOG_CORRUPT"
  | "WRITER_LOCK_TIMEOUT"
  | "IO_ERROR";

/** Pure error identity shared by repository IO and renderer-side retry logic. */
export class ProjectRuntimeRepositoryError extends Error {
  readonly code: ProjectRuntimeErrorCode;

  constructor(code: ProjectRuntimeErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Pure optimistic-concurrency signal; importing it performs no repository IO. */
export class RevisionConflictError extends ProjectRuntimeRepositoryError {
  readonly path: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(path: string, expectedRevision: number | null, actualRevision: number | null) {
    super(
      "REVISION_CONFLICT",
      `Revision conflict for "${path}": expected ${String(expectedRevision)}, actual ${String(
        actualRevision,
      )}`,
    );
    this.path = path;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}
