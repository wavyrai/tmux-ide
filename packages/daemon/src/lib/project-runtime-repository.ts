import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import type { ProjectResolution, ResolveProjectOptions } from "./project-resolver.js";
import { resolveProject } from "./project-resolver.js";
import { stateHome } from "./state-home.js";

const DOCUMENT_ENVELOPE_VERSION = 1;
const EVENT_ENVELOPE_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROJECT_RUNTIME_WRITER_LOCK_FILENAME = "workspace/.state.lock";
const PROJECT_RUNTIME_PROCESS_INSTANCE_ID = randomUUID();

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

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

export interface ProjectRuntimeRepositoryIo {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  readBytes(path: string): Uint8Array;
  writeBytes(path: string, data: Uint8Array): void;
  fsyncFile(path: string): void;
  fsyncDirectory(path: string): void;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  isSymbolicLink(path: string): boolean;
  now(): Date;
  randomId(): string;
}

export interface ProjectRuntimeRepositoryOptions {
  /** Preferred state-home override. */
  home?: string;
  /** @deprecated Use `home`; retained for callers that adopted the C04 draft API. */
  stateHome?: string;
  io?: Partial<ProjectRuntimeRepositoryIo>;
}

export interface OpenProjectRuntimeRepositoryOptions extends ProjectRuntimeRepositoryOptions {
  explicitConfigPath?: string | null;
  resolverIo?: ResolveProjectOptions["io"];
  resolveOptions?: ResolveProjectOptions;
  resolver?: (dir: string, options?: ResolveProjectOptions) => Promise<ProjectResolution>;
}

export interface ProjectRuntimeMetadata {
  identityKey: string;
  identitySource: ProjectResolution["identitySource"];
  identityAnchor: string;
  projectRoot: string;
  runtimeRoot: string;
}

export type ProjectRuntimeDocument<T> =
  | { found: false; path: string; revision: null }
  | {
      found: true;
      path: string;
      version: typeof DOCUMENT_ENVELOPE_VERSION;
      revision: number;
      payload: T;
    };

export interface WriteDocumentOptions {
  /** `null` means create-only; a number must match the current on-disk revision. */
  expectedRevision: number | null;
}

export interface WriteDocumentResult<T> {
  path: string;
  version: typeof DOCUMENT_ENVELOPE_VERSION;
  revision: number;
  payload: T;
}

export interface RecoverDocumentOptions {
  /** Exact token returned by `documentRecoveryToken`; prevents stale recovery. */
  expectedRawSha256: string;
  /** Required operator-facing explanation for the destructive reset. */
  reason: string;
  /** Optional JSON audit context persisted beside the exact-byte backup. */
  details?: JsonValue;
}

export interface RecoverDocumentResult<T> extends WriteDocumentResult<T> {
  previousRawSha256: string;
  backupPath: string;
  metadataPath: string;
  reason: string;
}

export interface ProjectRuntimeWriterLockOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface ProjectRuntimeWriterLockOutcome<T> {
  value: T;
  releaseError: Error | null;
}

/** Short-lived capability valid only while the project writer lock is held. */
export interface ProjectRuntimeLockedWriter {
  writeDocument<T>(path: string, payload: T, options: WriteDocumentOptions): WriteDocumentResult<T>;
  recoverDocument<T>(
    path: string,
    payload: T,
    options: RecoverDocumentOptions,
  ): RecoverDocumentResult<T>;
  appendEvent<T>(stream: string, payload: T, options?: AppendEventOptions): RuntimeEvent<T>;
}

export interface RuntimeEvent<T> {
  version: typeof EVENT_ENVELOPE_VERSION;
  sequence: number;
  timestamp: string;
  payload: T;
}

export interface AppendEventOptions {
  expectedPreviousSequence?: number;
}

export class ProjectRuntimeRepositoryError extends Error {
  readonly code: ProjectRuntimeErrorCode;

  constructor(code: ProjectRuntimeErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidRuntimePathError extends ProjectRuntimeRepositoryError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super("INVALID_PATH", `Invalid runtime path "${path}": ${reason}`);
    this.path = path;
  }
}

export class InvalidEventStreamError extends InvalidRuntimePathError {
  readonly stream: string;

  constructor(stream: string, reason: string) {
    super(stream, reason);
    this.name = "InvalidEventStreamError";
    this.stream = stream;
  }
}

export class MissingRuntimeDocumentError extends ProjectRuntimeRepositoryError {
  readonly path: string;

  constructor(path: string) {
    super("DOCUMENT_MISSING", `Runtime document "${path}" does not exist`);
    this.path = path;
  }
}

export class CorruptRuntimeDocumentError extends ProjectRuntimeRepositoryError {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super("DOCUMENT_CORRUPT", `Runtime document "${path}" is corrupt: ${reason}`);
    this.path = path;
    this.reason = reason;
  }
}

export class UnsupportedRuntimeDocumentVersionError extends ProjectRuntimeRepositoryError {
  readonly path: string;
  readonly version: unknown;

  constructor(path: string, version: unknown) {
    super(
      "UNSUPPORTED_DOCUMENT_VERSION",
      `Runtime document "${path}" uses unsupported envelope version ${String(version)}`,
    );
    this.path = path;
    this.version = version;
  }
}

export class InvalidJsonValueError extends ProjectRuntimeRepositoryError {
  readonly valuePath: string;
  readonly reason: string;

  constructor(valuePath: string, reason: string) {
    super("INVALID_JSON_VALUE", `Invalid JSON value at ${valuePath}: ${reason}`);
    this.valuePath = valuePath;
    this.reason = reason;
  }
}

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

export class ProjectRuntimeWriterLockTimeoutError extends ProjectRuntimeRepositoryError {
  readonly lockPath: string;
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number) {
    super(
      "WRITER_LOCK_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for project runtime writer lock`,
    );
    this.name = "ProjectRuntimeWriterLockTimeoutError";
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export class EventSequenceConflictError extends ProjectRuntimeRepositoryError {
  readonly stream: string;
  readonly expectedPreviousSequence: number;
  readonly actualPreviousSequence: number;

  constructor(stream: string, expectedPreviousSequence: number, actualPreviousSequence: number) {
    super(
      "EVENT_SEQUENCE_CONFLICT",
      `Event sequence conflict for "${stream}": expected previous ${expectedPreviousSequence}, actual previous ${actualPreviousSequence}`,
    );
    this.stream = stream;
    this.expectedPreviousSequence = expectedPreviousSequence;
    this.actualPreviousSequence = actualPreviousSequence;
  }
}

export class CorruptEventLogError extends ProjectRuntimeRepositoryError {
  readonly stream: string;
  readonly lineNumber: number;
  readonly reason: string;

  constructor(stream: string, lineNumber: number, reason: string) {
    super("EVENT_LOG_CORRUPT", `Event log "${stream}" is corrupt at line ${lineNumber}: ${reason}`);
    this.stream = stream;
    this.lineNumber = lineNumber;
    this.reason = reason;
  }
}

export class ProjectRuntimeIoError extends ProjectRuntimeRepositoryError {
  readonly path: string;
  override readonly cause: unknown;

  constructor(path: string, operation: string, cause: unknown) {
    super("IO_ERROR", `Unable to ${operation} runtime path "${path}"`);
    this.path = path;
    this.cause = cause;
  }
}

interface DocumentEnvelope {
  version: typeof DOCUMENT_ENVELOPE_VERSION;
  revision: number;
  payload: JsonValue;
}

interface EventEnvelope {
  version: typeof EVENT_ENVELOPE_VERSION;
  sequence: number;
  timestamp: string;
  payload: JsonValue;
}

const defaultIo: ProjectRuntimeRepositoryIo = {
  readFile: (path) => readFileSync(path, "utf-8"),
  writeFile: (path, data) => writeFileSync(path, data, "utf-8"),
  readBytes: (path) => readFileSync(path),
  writeBytes: (path, data) => writeFileSync(path, data),
  fsyncFile: (path) => {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  fsyncDirectory: (path) => {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
  unlink: unlinkSync,
  isSymbolicLink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  },
  now: () => new Date(),
  randomId: randomUUID,
};

let tempCounter = 0;

export class ProjectRuntimeRepository {
  readonly resolution: ProjectResolution;
  readonly runtimeRoot: string;
  readonly metadata: ProjectRuntimeMetadata;

  private readonly io: ProjectRuntimeRepositoryIo;

  constructor(resolution: ProjectResolution, options: ProjectRuntimeRepositoryOptions = {}) {
    validateSafeId(resolution.identityKey, "identity key");
    this.resolution = resolution;
    this.io = { ...defaultIo, ...options.io };
    this.runtimeRoot = join(
      resolve(options.home ?? options.stateHome ?? stateHome()),
      "projects",
      resolution.identityKey,
    );
    this.metadata = {
      identityKey: resolution.identityKey,
      identitySource: resolution.identitySource,
      identityAnchor: resolution.identityAnchor,
      projectRoot: resolution.projectRoot,
      runtimeRoot: this.runtimeRoot,
    };
  }

  readDocument<T = JsonValue>(path: string): ProjectRuntimeDocument<T> {
    const target = this.resolveRuntimePath(path);
    const bytes = this.readOptionalBytes(target, path);
    const raw = bytes === null ? null : decodeUtf8Strict(bytes, path);
    if (raw === null) return { found: false, path, revision: null };
    const envelope = parseDocumentEnvelope(path, raw);
    return {
      found: true,
      path,
      version: DOCUMENT_ENVELOPE_VERSION,
      revision: envelope.revision,
      payload: cloneJson(envelope.payload) as T,
    };
  }

  readRequiredDocument<T = JsonValue>(path: string): WriteDocumentResult<T> {
    const document = this.readDocument<T>(path);
    if (!document.found) throw new MissingRuntimeDocumentError(path);
    return {
      path: document.path,
      version: document.version,
      revision: document.revision,
      payload: document.payload,
    };
  }

  writeDocument<T>(
    path: string,
    payload: T,
    options: WriteDocumentOptions,
  ): WriteDocumentResult<T> {
    return this.withWriterLock(undefined, (writer) => writer.writeDocument(path, payload, options));
  }

  /**
   * Serialize a compound read/check/write transaction with every other
   * compliant project-runtime writer, including writers in other processes.
   * The supplied capability expires as soon as the callback returns.
   */
  withWriterLock<T>(
    options: ProjectRuntimeWriterLockOptions | undefined,
    action: (writer: ProjectRuntimeLockedWriter) => T,
  ): T {
    const outcome = this.withWriterLockOutcome(options, action);
    if (outcome.releaseError) throw outcome.releaseError;
    return outcome.value;
  }

  withWriterLockOutcome<T>(
    options: ProjectRuntimeWriterLockOptions | undefined,
    action: (writer: ProjectRuntimeLockedWriter) => T,
  ): ProjectRuntimeWriterLockOutcome<T> {
    const release = this.acquireWriterLock(options);
    let active = true;
    const assertActive = (): void => {
      if (!active) {
        throw new ProjectRuntimeRepositoryError(
          "IO_ERROR",
          "Project runtime locked-writer capability is no longer active",
        );
      }
    };
    const writer: ProjectRuntimeLockedWriter = {
      writeDocument: <TValue>(
        path: string,
        payload: TValue,
        writeOptions: WriteDocumentOptions,
      ): WriteDocumentResult<TValue> => {
        assertActive();
        return this.writeDocumentUnlocked(path, payload, writeOptions);
      },
      recoverDocument: <TValue>(
        path: string,
        payload: TValue,
        recoverOptions: RecoverDocumentOptions,
      ): RecoverDocumentResult<TValue> => {
        assertActive();
        return this.recoverDocumentUnlocked(path, payload, recoverOptions);
      },
      appendEvent: <TValue>(
        stream: string,
        payload: TValue,
        appendOptions: AppendEventOptions = {},
      ): RuntimeEvent<TValue> => {
        assertActive();
        return this.appendEventUnlocked(stream, payload, appendOptions);
      },
    };
    let value: T;
    try {
      value = action(writer);
      if (isPromiseLike(value)) {
        throw new ProjectRuntimeRepositoryError(
          "IO_ERROR",
          "Project runtime writer transactions must be synchronous",
        );
      }
    } catch (error) {
      active = false;
      try {
        release();
      } catch {
        // Preserve the operation error; an abandoned lock is inspectable and
        // must be recovered explicitly rather than hiding the original cause.
      }
      throw error;
    }
    active = false;
    try {
      release();
      return { value, releaseError: null };
    } catch (error) {
      return {
        value,
        releaseError: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  private writeDocumentUnlocked<T>(
    path: string,
    payload: T,
    options: WriteDocumentOptions,
  ): WriteDocumentResult<T> {
    if (
      options.expectedRevision !== null &&
      (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)
    ) {
      throw new RevisionConflictError(path, options.expectedRevision, null);
    }
    const target = this.resolveRuntimePath(path);
    const existingBytes = this.readOptionalBytes(target, path);
    const existing = existingBytes === null ? null : decodeUtf8Strict(existingBytes, path);
    const current = existing === null ? null : parseDocumentEnvelope(path, existing);
    const actualRevision = current?.revision ?? null;

    if (options.expectedRevision !== actualRevision) {
      throw new RevisionConflictError(path, options.expectedRevision, actualRevision);
    }

    const serializedPayload = serializeJsonPayload(payload);
    const envelope: DocumentEnvelope = {
      version: DOCUMENT_ENVELOPE_VERSION,
      revision: actualRevision === null ? 1 : actualRevision + 1,
      payload: serializedPayload,
    };
    this.atomicWrite(target, `${JSON.stringify(envelope, null, 2)}\n`, path);
    return {
      path,
      version: DOCUMENT_ENVELOPE_VERSION,
      revision: envelope.revision,
      payload: cloneJson(serializedPayload) as T,
    };
  }

  /**
   * Token for explicit recovery of a document whose envelope or payload cannot
   * be safely written through normal revision CAS. No bytes are exposed.
   */
  documentRecoveryToken(path: string): string | null {
    const target = this.resolveRuntimePath(path);
    const raw = this.readOptionalBytes(target, path);
    return raw === null ? null : sha256(raw);
  }

  /**
   * Explicit destructive recovery. The exact prior bytes are atomically copied
   * beneath `recovery/` before the target is replaced. Normal writes must never
   * call this path.
   */
  recoverDocument<T>(
    path: string,
    payload: T,
    options: RecoverDocumentOptions,
  ): RecoverDocumentResult<T> {
    return this.withWriterLock(undefined, (writer) =>
      writer.recoverDocument(path, payload, options),
    );
  }

  private recoverDocumentUnlocked<T>(
    path: string,
    payload: T,
    options: RecoverDocumentOptions,
  ): RecoverDocumentResult<T> {
    const reason = options.reason.trim();
    if (reason.length === 0 || reason.length > 512 || reason.includes("\0")) {
      throw new InvalidJsonValueError(
        "$.reason",
        "recovery reason must contain 1-512 non-NUL characters",
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(options.expectedRawSha256)) {
      throw new InvalidJsonValueError("$.expectedRawSha256", "recovery token must be SHA-256");
    }
    const target = this.resolveRuntimePath(path);
    const raw = this.readOptionalBytes(target, path);
    if (raw === null) throw new MissingRuntimeDocumentError(path);
    const actualToken = sha256(raw);
    if (actualToken !== options.expectedRawSha256) {
      throw new RevisionConflictError(path, null, null);
    }
    const serializedPayload = serializeJsonPayload(payload);
    let priorRevision = 0;
    try {
      priorRevision = parseDocumentEnvelope(path, decodeUtf8(raw)).revision;
    } catch {
      // Corrupt/unsupported envelopes restart at revision 1 after backup.
    }
    const recoveredAt = this.io.now();
    if (!Number.isFinite(recoveredAt.getTime())) {
      throw new InvalidJsonValueError("$.recoveredAt", "recovery timestamp must be valid");
    }
    const envelope: DocumentEnvelope = {
      version: DOCUMENT_ENVELOPE_VERSION,
      revision: priorRevision + 1,
      payload: serializedPayload,
    };
    const replacement = encodeUtf8(`${JSON.stringify(envelope, null, 2)}\n`);
    const recovery = this.reserveRecoveryOperation(path, actualToken);
    const backupPath = `${recovery.relativePath}/previous.bak`;
    const metadataPath = `${recovery.relativePath}/audit.json`;
    const preparedMetadata = {
      version: 1,
      status: "prepared",
      operationId: recovery.operationId,
      path,
      backupPath,
      previousRawSha256: actualToken,
      replacementRawSha256: sha256(replacement),
      replacementRevision: envelope.revision,
      reason,
      recoveredAt: recoveredAt.toISOString(),
      details: options.details ?? null,
    } as const;
    const backupTarget = this.resolveRuntimePath(backupPath);
    try {
      this.atomicWriteBytes(backupTarget, raw, backupPath, true);
    } catch (error) {
      try {
        rmdirSync(recovery.target);
        this.io.fsyncDirectory(resolve(recovery.target, ".."));
      } catch {
        // Preserve the backup failure; a non-empty artifact remains inspectable.
      }
      throw error;
    }
    this.atomicWriteBytes(
      this.resolveRuntimePath(metadataPath),
      encodeUtf8(`${JSON.stringify(serializeJsonPayload(preparedMetadata), null, 2)}\n`),
      metadataPath,
      true,
    );
    const recheckedRaw = this.readOptionalBytes(target, path);
    if (recheckedRaw === null || sha256(recheckedRaw) !== actualToken) {
      throw new RevisionConflictError(path, null, null);
    }
    this.atomicWriteBytes(target, replacement, path, true);
    const completedMetadata = serializeJsonPayload({
      ...preparedMetadata,
      status: "completed",
      completedAt: this.io.now().toISOString(),
    });
    this.atomicWriteBytes(
      this.resolveRuntimePath(metadataPath),
      encodeUtf8(`${JSON.stringify(completedMetadata, null, 2)}\n`),
      metadataPath,
      true,
    );
    return {
      path,
      version: DOCUMENT_ENVELOPE_VERSION,
      revision: envelope.revision,
      payload: cloneJson(serializedPayload) as T,
      previousRawSha256: actualToken,
      backupPath,
      metadataPath,
      reason,
    };
  }

  readEvents<T = JsonValue>(stream: string): RuntimeEvent<T>[] {
    const target = this.resolveEventPath(stream);
    const bytes = this.readOptionalBytes(target, `events/${stream}.jsonl`);
    const raw = bytes === null ? null : decodeUtf8Strict(bytes, `events/${stream}.jsonl`);
    if (raw === null) return [];
    return parseEventLog<T>(stream, raw);
  }

  appendEvent<T>(stream: string, payload: T, options: AppendEventOptions = {}): RuntimeEvent<T> {
    return this.withWriterLock(undefined, (writer) => writer.appendEvent(stream, payload, options));
  }

  private appendEventUnlocked<T>(
    stream: string,
    payload: T,
    options: AppendEventOptions = {},
  ): RuntimeEvent<T> {
    if (
      options.expectedPreviousSequence !== undefined &&
      (!Number.isSafeInteger(options.expectedPreviousSequence) ||
        options.expectedPreviousSequence < 0)
    ) {
      throw new EventSequenceConflictError(stream, options.expectedPreviousSequence, 0);
    }
    const target = this.resolveEventPath(stream);
    const bytes = this.readOptionalBytes(target, `events/${stream}.jsonl`);
    const raw = bytes === null ? null : decodeUtf8Strict(bytes, `events/${stream}.jsonl`);
    const events = raw === null ? [] : parseEventLog<JsonValue>(stream, raw);
    const actualPreviousSequence = events.at(-1)?.sequence ?? 0;

    if (
      options.expectedPreviousSequence !== undefined &&
      options.expectedPreviousSequence !== actualPreviousSequence
    ) {
      throw new EventSequenceConflictError(
        stream,
        options.expectedPreviousSequence,
        actualPreviousSequence,
      );
    }

    const now = this.io.now();
    if (!Number.isFinite(now.getTime())) {
      throw new InvalidJsonValueError("$.timestamp", "timestamp must be a valid date");
    }
    const event: EventEnvelope = {
      version: EVENT_ENVELOPE_VERSION,
      sequence: actualPreviousSequence + 1,
      timestamp: now.toISOString(),
      payload: serializeJsonPayload(payload),
    };
    this.atomicWrite(
      target,
      `${[...events, event].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      `events/${stream}.jsonl`,
    );
    return cloneJson(event) as RuntimeEvent<T>;
  }

  private resolveRuntimePath(path: string, allowEventNamespace = false): string {
    if (path.length === 0) throw new InvalidRuntimePathError(path, "path must not be empty");
    if (path.includes("\0")) throw new InvalidRuntimePathError(path, "path must not contain NUL");
    if (path.includes("\\")) {
      throw new InvalidRuntimePathError(path, "path must use forward slashes");
    }
    if (isAbsolute(path) || win32.isAbsolute(path)) {
      throw new InvalidRuntimePathError(path, "path must be relative");
    }
    const parts = path.split("/");
    if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
      throw new InvalidRuntimePathError(path, "path contains an unsafe segment");
    }
    if (!allowEventNamespace && parts[0] === "events") {
      throw new InvalidRuntimePathError(path, "the events namespace is reserved for event streams");
    }
    const target = resolve(this.runtimeRoot, ...parts);
    if (!isWithinDirectory(target, this.runtimeRoot)) {
      throw new InvalidRuntimePathError(path, "path escapes the runtime root");
    }
    this.assertNoSymbolicLink(path, parts);
    return target;
  }

  private resolveEventPath(stream: string): string {
    validateSafeStreamId(stream);
    return this.resolveRuntimePath(`events/${stream}.jsonl`, true);
  }

  private assertNoSymbolicLink(displayPath: string, parts: string[]): void {
    let current = this.runtimeRoot;
    for (const part of parts) {
      current = join(current, part);
      try {
        if (this.io.isSymbolicLink(current)) {
          throw new InvalidRuntimePathError(displayPath, "symbolic links are not allowed");
        }
      } catch (error) {
        if (error instanceof ProjectRuntimeRepositoryError) throw error;
        throw new ProjectRuntimeIoError(displayPath, "inspect", error);
      }
    }
  }

  private readOptionalBytes(path: string, displayPath: string): Uint8Array | null {
    try {
      return this.io.readBytes(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new ProjectRuntimeIoError(displayPath, "read exact bytes from", error);
    }
  }

  private atomicWrite(target: string, data: string, displayPath: string): void {
    const destinationDir = resolve(target, "..");
    this.io.mkdir(destinationDir);
    const tempPath = join(
      destinationDir,
      `.tmp-${process.pid}-${tempCounter++}-${safeTempId(this.io.randomId())}`,
    );
    try {
      this.io.writeFile(tempPath, data);
      this.io.fsyncFile(tempPath);
      this.io.rename(tempPath, target);
      this.io.fsyncDirectory(destinationDir);
    } catch (error) {
      try {
        this.io.unlink(tempPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          // Preserve the write/rename failure; cleanup is best-effort.
        }
      }
      throw new ProjectRuntimeIoError(displayPath, "atomically write", error);
    }
  }

  private atomicWriteBytes(
    target: string,
    data: Uint8Array,
    displayPath: string,
    durable: boolean,
  ): void {
    const destinationDir = resolve(target, "..");
    this.io.mkdir(destinationDir);
    const tempPath = join(
      destinationDir,
      `.tmp-${process.pid}-${tempCounter++}-${safeTempId(this.io.randomId())}`,
    );
    try {
      this.io.writeBytes(tempPath, data);
      if (durable) this.io.fsyncFile(tempPath);
      this.io.rename(tempPath, target);
      if (durable) {
        this.io.fsyncFile(target);
        this.io.fsyncDirectory(destinationDir);
      }
    } catch (error) {
      try {
        this.io.unlink(tempPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError) || cleanupError.code !== "ENOENT") {
          // Preserve the write/rename/fsync failure; cleanup is best-effort.
        }
      }
      throw new ProjectRuntimeIoError(displayPath, "durably atomically write", error);
    }
  }

  private acquireWriterLock(options: ProjectRuntimeWriterLockOptions | undefined): () => void {
    const timeoutMs = normalizeLockDuration(options?.timeoutMs, 2_000, 0, 60_000, "timeoutMs");
    const pollMs = normalizeLockDuration(options?.pollMs, 10, 1, 250, "pollMs");
    const lockPath = join(this.runtimeRoot, PROJECT_RUNTIME_WRITER_LOCK_FILENAME);
    const lockDirectory = resolve(lockPath, "..");
    this.io.mkdir(this.runtimeRoot);
    assertLockDirectory(this.runtimeRoot);
    this.io.mkdir(lockDirectory);
    assertLockDirectory(lockDirectory);
    const token = randomUUID();
    const owner = `${JSON.stringify({
      version: 1,
      token,
      processInstanceId: PROJECT_RUNTIME_PROCESS_INSTANCE_ID,
      pid: process.pid,
      createdAtMs: Date.now(),
    })}\n`;
    const startedAt = Date.now();
    let installedIdentity: { device: number; inode: number } | null = null;

    for (;;) {
      let descriptor: number | null = null;
      let created = false;
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        created = true;
        writeFileSync(descriptor, owner, "utf-8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        const installed = lstatSync(lockPath);
        installedIdentity = { device: installed.dev, inode: installed.ino };
        this.io.fsyncDirectory(lockDirectory);
        break;
      } catch (error) {
        if (descriptor !== null) {
          try {
            closeSync(descriptor);
          } catch {
            // Preserve the acquisition failure.
          }
        }
        if (created) {
          try {
            unlinkSync(lockPath);
            this.io.fsyncDirectory(lockDirectory);
          } catch {
            // Cleanup is best effort; the lock remains visible for recovery.
          }
        }
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new ProjectRuntimeIoError(PROJECT_RUNTIME_WRITER_LOCK_FILENAME, "acquire", error);
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new ProjectRuntimeWriterLockTimeoutError(lockPath, timeoutMs);
        }
        sleepSync(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - startedAt))));
      }
    }

    return () => {
      try {
        const before = lstatSync(lockPath);
        if (
          !installedIdentity ||
          before.dev !== installedIdentity.device ||
          before.ino !== installedIdentity.inode ||
          !before.isFile() ||
          before.isSymbolicLink()
        ) {
          throw new Error("writer lock filesystem identity changed before release");
        }
        const currentOwner = readFileSync(lockPath, "utf-8");
        const afterRead = lstatSync(lockPath);
        const parsed = JSON.parse(currentOwner) as {
          token?: unknown;
          processInstanceId?: unknown;
        };
        if (
          afterRead.dev !== before.dev ||
          afterRead.ino !== before.ino ||
          parsed.token !== token ||
          parsed.processInstanceId !== PROJECT_RUNTIME_PROCESS_INSTANCE_ID
        ) {
          throw new Error("writer lock ownership changed before release");
        }
        const releasedPath = `${lockPath}.released-${token}`;
        renameSync(lockPath, releasedPath);
        const moved = lstatSync(releasedPath);
        if (moved.dev !== before.dev || moved.ino !== before.ino) {
          throw new Error("writer lock filesystem identity changed while releasing");
        }
        unlinkSync(releasedPath);
        this.io.fsyncDirectory(lockDirectory);
      } catch (error) {
        throw new ProjectRuntimeIoError(PROJECT_RUNTIME_WRITER_LOCK_FILENAME, "release", error);
      }
    };
  }

  private reserveRecoveryOperation(
    path: string,
    rawToken: string,
  ): { operationId: string; relativePath: string; target: string } {
    const recoveryRoot = this.resolveRuntimePath("recovery");
    this.io.mkdir(recoveryRoot);
    this.io.fsyncDirectory(resolve(recoveryRoot, ".."));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const operationId = safeTempId(this.io.randomId());
      const relativePath = `recovery/${sha256(path)}-${rawToken}-${operationId}`;
      const target = this.resolveRuntimePath(relativePath);
      try {
        mkdirSync(target, { mode: 0o700 });
        this.io.fsyncDirectory(recoveryRoot);
        return { operationId, relativePath, target };
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw new ProjectRuntimeIoError(relativePath, "reserve recovery operation", error);
      }
    }
    throw new ProjectRuntimeIoError(
      "recovery",
      "reserve recovery operation",
      new Error("recovery operation id collided too many times"),
    );
  }
}

export function createProjectRuntimeRepository(
  resolution: ProjectResolution,
  options: ProjectRuntimeRepositoryOptions = {},
): ProjectRuntimeRepository {
  return new ProjectRuntimeRepository(resolution, options);
}

export async function openProjectRuntimeRepository(
  dir: string,
  options: OpenProjectRuntimeRepositoryOptions = {},
): Promise<ProjectRuntimeRepository> {
  const resolver = options.resolver ?? resolveProject;
  const resolution = await resolver(dir, {
    ...options.resolveOptions,
    explicitConfigPath: options.explicitConfigPath ?? options.resolveOptions?.explicitConfigPath,
    io: options.resolverIo ?? options.resolveOptions?.io,
  });
  return createProjectRuntimeRepository(resolution, options);
}

function parseDocumentEnvelope(path: string, raw: string): DocumentEnvelope {
  const value = parseJson(raw, () => new CorruptRuntimeDocumentError(path, "invalid JSON"));
  if (!isRecord(value)) throw new CorruptRuntimeDocumentError(path, "envelope must be an object");
  if (!sameKeys(Object.keys(value), ["version", "revision", "payload"])) {
    throw new CorruptRuntimeDocumentError(path, "envelope has invalid keys");
  }
  if (value.version !== DOCUMENT_ENVELOPE_VERSION) {
    if (Number.isInteger(value.version)) {
      throw new UnsupportedRuntimeDocumentVersionError(path, value.version);
    }
    throw new CorruptRuntimeDocumentError(path, "envelope version must be a supported integer");
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new CorruptRuntimeDocumentError(path, "revision must be a positive safe integer");
  }
  assertJsonPayload(value.payload);
  return {
    version: DOCUMENT_ENVELOPE_VERSION,
    revision,
    payload: cloneJson(value.payload),
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeUtf8(value: string): Uint8Array {
  return Buffer.from(value, "utf-8");
}

function decodeUtf8(value: Uint8Array): string {
  return Buffer.from(value).toString("utf-8");
}

function decodeUtf8Strict(value: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new CorruptRuntimeDocumentError(path, "document is not valid UTF-8");
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function normalizeLockDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new InvalidJsonValueError(
      `$.${field}`,
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertLockDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    throw new InvalidRuntimePathError(path, "symbolic links are not allowed");
  if (!stat.isDirectory())
    throw new InvalidRuntimePathError(path, "writer lock parent must be a directory");
}

function parseEventLog<T>(stream: string, raw: string): RuntimeEvent<T>[] {
  if (raw.length === 0) return [];
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  if (lines.length === 1 && lines[0] === "") return [];

  return lines.map((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0) {
      throw new CorruptEventLogError(stream, lineNumber, "blank lines are not allowed");
    }
    const value = parseJson(
      line,
      () => new CorruptEventLogError(stream, lineNumber, "invalid JSON"),
    );
    if (!isRecord(value))
      throw new CorruptEventLogError(stream, lineNumber, "event must be an object");
    if (!sameKeys(Object.keys(value), ["version", "sequence", "timestamp", "payload"])) {
      throw new CorruptEventLogError(stream, lineNumber, "event has invalid keys");
    }
    if (value.version !== EVENT_ENVELOPE_VERSION) {
      throw new CorruptEventLogError(stream, lineNumber, "unsupported event version");
    }
    if (value.sequence !== lineNumber) {
      throw new CorruptEventLogError(stream, lineNumber, "event sequence must be continuous");
    }
    if (typeof value.timestamp !== "string" || !isCanonicalTimestamp(value.timestamp)) {
      throw new CorruptEventLogError(
        stream,
        lineNumber,
        "timestamp must be a canonical ISO string",
      );
    }
    assertJsonPayload(
      value.payload,
      (payloadPath, reason) =>
        new CorruptEventLogError(stream, lineNumber, `${payloadPath}: ${reason}`),
    );
    return {
      version: EVENT_ENVELOPE_VERSION,
      sequence: value.sequence,
      timestamp: value.timestamp,
      payload: cloneJson(value.payload) as T,
    };
  });
}

function parseJson<TError extends Error>(raw: string, errorFactory: () => TError): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw errorFactory();
  }
}

function serializeJsonPayload(value: unknown): JsonValue {
  assertJsonPayload(value);
  return cloneJson(value);
}

function assertJsonPayload(
  value: unknown,
  errorFactory: (path: string, reason: string) => Error = (path, reason) =>
    new InvalidJsonValueError(path, reason),
): asserts value is JsonValue {
  const stack = new Set<object>();

  function visit(candidate: unknown, path: string): void {
    if (candidate === null) return;
    if (typeof candidate === "string" || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw errorFactory(path, "number must be finite");
      return;
    }
    if (typeof candidate === "undefined") throw errorFactory(path, "undefined is not JSON");
    if (typeof candidate === "bigint") throw errorFactory(path, "bigint is not JSON");
    if (typeof candidate === "function") throw errorFactory(path, "function is not JSON");
    if (typeof candidate === "symbol") throw errorFactory(path, "symbol is not JSON");
    if (typeof candidate !== "object") throw errorFactory(path, "value is not JSON");

    if (stack.has(candidate)) throw errorFactory(path, "cyclic values are not JSON");
    stack.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            throw errorFactory(`${path}[${index}]`, "sparse arrays are not JSON");
          }
          visit(candidate[index], `${path}[${index}]`);
        }
        const customKeys = Reflect.ownKeys(candidate).filter((key) => {
          if (key === "length") return false;
          return typeof key === "symbol" || !/^(?:0|[1-9]\d*)$/.test(String(key));
        });
        if (customKeys.length > 0) throw errorFactory(path, "arrays must not have custom keys");
        return;
      }
      if (Object.getPrototypeOf(candidate) !== Object.prototype) {
        throw errorFactory(path, "object must be a plain object");
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key === "symbol") throw errorFactory(path, "symbol keys are not JSON");
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor) continue;
        if ("get" in descriptor || "set" in descriptor) {
          throw errorFactory(`${path}.${key}`, "accessors are not JSON");
        }
        visit((candidate as Record<string, unknown>)[key], `${path}.${key}`);
      }
    } finally {
      stack.delete(candidate);
    }
  }

  visit(value, "$");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKeys(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return expected.every((key) => actualSet.has(key));
}

function validateSafeId(value: string, label: string): void {
  if (
    !SAFE_ID_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.includes("\0")
  ) {
    throw new InvalidRuntimePathError(value, `${label} must be a safe filesystem id`);
  }
}

function validateSafeStreamId(value: string): void {
  if (
    !SAFE_ID_PATTERN.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes("..") ||
    value.includes("\0")
  ) {
    throw new InvalidEventStreamError(value, "event stream must be a safe filesystem id");
  }
}

function isWithinDirectory(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

function safeTempId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
