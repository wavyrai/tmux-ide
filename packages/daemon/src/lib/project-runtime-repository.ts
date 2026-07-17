import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

import type { ProjectResolution, ResolveProjectOptions } from "./project-resolver.js";
import { resolveProject } from "./project-resolver.js";
import { stateHome } from "./state-home.js";

const DOCUMENT_ENVELOPE_VERSION = 1;
const EVENT_ENVELOPE_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  | "IO_ERROR";

export interface ProjectRuntimeRepositoryIo {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
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
    const raw = this.readOptionalFile(target, path);
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
    if (
      options.expectedRevision !== null &&
      (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)
    ) {
      throw new RevisionConflictError(path, options.expectedRevision, null);
    }
    const target = this.resolveRuntimePath(path);
    const existing = this.readOptionalFile(target, path);
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

  readEvents<T = JsonValue>(stream: string): RuntimeEvent<T>[] {
    const target = this.resolveEventPath(stream);
    const raw = this.readOptionalFile(target, `events/${stream}.jsonl`);
    if (raw === null) return [];
    return parseEventLog<T>(stream, raw);
  }

  appendEvent<T>(stream: string, payload: T, options: AppendEventOptions = {}): RuntimeEvent<T> {
    if (
      options.expectedPreviousSequence !== undefined &&
      (!Number.isSafeInteger(options.expectedPreviousSequence) ||
        options.expectedPreviousSequence < 0)
    ) {
      throw new EventSequenceConflictError(stream, options.expectedPreviousSequence, 0);
    }
    const target = this.resolveEventPath(stream);
    const raw = this.readOptionalFile(target, `events/${stream}.jsonl`);
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

  private readOptionalFile(path: string, displayPath: string): string | null {
    try {
      return this.io.readFile(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw new ProjectRuntimeIoError(displayPath, "read", error);
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
      this.io.rename(tempPath, target);
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
