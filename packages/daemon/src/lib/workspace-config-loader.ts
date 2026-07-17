/**
 * Side-effect-free loader for repository-scoped WorkspaceConfigV1 files.
 *
 * Project/config discovery delegates to C01. This module only reads the
 * winning workspace file, optionally composes its sibling
 * `workspace.local.yml`, and validates the final effective value.
 */

import { WorkspaceConfigV1SchemaZ, type WorkspaceConfigV1 } from "@tmux-ide/contracts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import {
  resolveProject,
  type ProjectResolution,
  type ProjectResolverIo,
  type ResolveProjectOptions,
} from "./project-resolver.ts";

export type WorkspaceConfigLoadStage = "resolution" | "base" | "local" | "validation";

export type WorkspaceConfigLoadErrorCode =
  | "RESOLUTION_FAILED"
  | "WORKSPACE_CONFIG_REQUIRED"
  | "BASE_READ_FAILED"
  | "BASE_YAML_INVALID"
  | "BASE_NOT_MAPPING"
  | "BASE_CYCLIC_REFERENCE"
  | "BASE_VERSION_INVALID"
  | "LOCAL_READ_FAILED"
  | "LOCAL_YAML_INVALID"
  | "LOCAL_NOT_MAPPING"
  | "LOCAL_CYCLIC_REFERENCE"
  | "LOCAL_VERSION_INVALID"
  | "FINAL_VALIDATION_FAILED";

export interface WorkspaceConfigValidationIssue {
  path: (string | number)[];
  code: string;
  message: string;
}

export class WorkspaceConfigLoadError extends Error {
  readonly code: WorkspaceConfigLoadErrorCode;
  readonly stage: WorkspaceConfigLoadStage;
  readonly path: string | null;
  readonly issues: readonly WorkspaceConfigValidationIssue[];

  constructor(input: {
    code: WorkspaceConfigLoadErrorCode;
    stage: WorkspaceConfigLoadStage;
    message: string;
    path?: string | null;
    issues?: readonly WorkspaceConfigValidationIssue[];
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "WorkspaceConfigLoadError";
    this.code = input.code;
    this.stage = input.stage;
    this.path = input.path ?? null;
    this.issues = input.issues ?? [];
  }
}

/** Programmatic merge input contained a true object/array reference cycle. */
export class WorkspaceConfigMergeError extends Error {
  readonly code = "CYCLIC_VALUE";
  readonly path: readonly (string | number)[];

  constructor(path: readonly (string | number)[]) {
    const location = path.length > 0 ? path.join(".") : "<root>";
    super(`Workspace config value contains a cyclic reference at ${location}`);
    this.name = "WorkspaceConfigMergeError";
    this.path = [...path];
  }
}

export interface WorkspaceConfigSourceMetadata {
  basePath: string;
  localPath: string | null;
  resolution: ProjectResolution;
}

export interface LoadedWorkspaceConfig {
  config: WorkspaceConfigV1;
  source: WorkspaceConfigSourceMetadata;
}

export interface WorkspaceConfigLoaderIo {
  exists(path: string): boolean;
  readFile(path: string): string;
  realpath(path: string): string;
  resolveProject(dir: string, options?: ResolveProjectOptions): Promise<ProjectResolution>;
}

export interface LoadWorkspaceConfigOptions {
  explicitConfigPath?: string | null;
  /** Filesystem and resolver injection for deterministic loader tests/callers. */
  io?: Partial<WorkspaceConfigLoaderIo>;
  /** Passed through when using the C01 resolver implementation. */
  resolverIo?: Partial<ProjectResolverIo>;
}

const defaultLoaderIo: WorkspaceConfigLoaderIo = {
  exists: existsSync,
  readFile: (path) => readFileSync(path, "utf-8"),
  realpath: realpathSync,
  resolveProject,
};

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineValue(target: PlainObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Reject true cycles while allowing the same acyclic YAML alias/object to be
 * referenced by multiple siblings. `visited` avoids re-walking shared DAGs;
 * `ancestors` identifies only back-edges on the active traversal path.
 */
function assertAcyclicWorkspaceValue(
  value: unknown,
  ancestors = new Set<object>(),
  visited = new WeakSet<object>(),
  path: (string | number)[] = [],
): void {
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  const container: object = value;

  if (ancestors.has(container)) throw new WorkspaceConfigMergeError(path);
  if (visited.has(container)) return;

  ancestors.add(container);
  if (Array.isArray(value)) {
    for (const [index, nestedValue] of value.entries()) {
      assertAcyclicWorkspaceValue(nestedValue, ancestors, visited, [...path, index]);
    }
  } else {
    for (const [key, nestedValue] of Object.entries(value)) {
      assertAcyclicWorkspaceValue(nestedValue, ancestors, visited, [...path, key]);
    }
  }
  ancestors.delete(container);
  visited.add(container);
}

function cloneWorkspaceConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneWorkspaceConfigValue);
  if (!isPlainObject(value)) return value;

  const clone: PlainObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    defineValue(clone, key, cloneWorkspaceConfigValue(nestedValue));
  }
  return clone;
}

function mergeAcyclicWorkspaceConfigValues(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(overlay)) return cloneWorkspaceConfigValue(overlay);

  const merged: PlainObject = {};
  if (isPlainObject(base)) {
    for (const [key, baseValue] of Object.entries(base)) {
      defineValue(merged, key, cloneWorkspaceConfigValue(baseValue));
    }
  }

  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = isPlainObject(base) ? base[key] : undefined;
    defineValue(merged, key, mergeAcyclicWorkspaceConfigValues(baseValue, overlayValue));
  }
  return merged;
}

/**
 * Deterministic overlay merge: recurse through plain objects, replace arrays
 * wholesale, and replace scalars/null. Neither input is mutated or reused in
 * the returned object graph. Cyclic inputs throw WorkspaceConfigMergeError.
 */
export function mergeWorkspaceConfigValues(base: unknown, overlay: unknown): unknown {
  assertAcyclicWorkspaceValue(base);
  assertAcyclicWorkspaceValue(overlay);
  return mergeAcyclicWorkspaceConfigValues(base, overlay);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(path: string, stage: "base" | "local", io: WorkspaceConfigLoaderIo): string {
  try {
    return io.readFile(path);
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_READ_FAILED" : "LOCAL_READ_FAILED",
      stage,
      path,
      message: `Cannot read ${stage} workspace config at ${path}: ${errorDetail(cause)}`,
      cause,
    });
  }
}

function parseMapping(raw: string, path: string, stage: "base" | "local"): PlainObject {
  let document: unknown;
  try {
    document = yaml.load(raw);
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_YAML_INVALID" : "LOCAL_YAML_INVALID",
      stage,
      path,
      message: `Invalid YAML in ${stage} workspace config at ${path}: ${errorDetail(cause)}`,
      cause,
    });
  }

  if (!isPlainObject(document)) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_NOT_MAPPING" : "LOCAL_NOT_MAPPING",
      stage,
      path,
      message: `The ${stage} workspace config at ${path} must contain a YAML mapping`,
    });
  }

  try {
    assertAcyclicWorkspaceValue(document);
  } catch (cause) {
    if (!(cause instanceof WorkspaceConfigMergeError)) throw cause;
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_CYCLIC_REFERENCE" : "LOCAL_CYCLIC_REFERENCE",
      stage,
      path,
      message: `The ${stage} workspace config at ${path} contains a recursive YAML alias at ${cause.path.join(".") || "<root>"}`,
      cause,
    });
  }
  return document;
}

function assertBaseVersion(document: PlainObject, path: string): void {
  if (document.version !== 1) {
    throw new WorkspaceConfigLoadError({
      code: "BASE_VERSION_INVALID",
      stage: "base",
      path,
      message: `The base workspace config at ${path} must declare version: 1`,
    });
  }
}

function assertLocalVersion(document: PlainObject, path: string): void {
  if (Object.hasOwn(document, "version") && document.version !== 1) {
    throw new WorkspaceConfigLoadError({
      code: "LOCAL_VERSION_INVALID",
      stage: "local",
      path,
      message: `The local workspace config at ${path} cannot change version from 1`,
    });
  }
}

function safeExists(path: string, io: WorkspaceConfigLoaderIo): boolean {
  try {
    return io.exists(path);
  } catch {
    return false;
  }
}

function canonicalizeExisting(path: string, io: WorkspaceConfigLoaderIo): string {
  try {
    return io.realpath(path);
  } catch {
    return path;
  }
}

function validationIssues(error: {
  issues: readonly {
    path: readonly PropertyKey[];
    code: string;
    message: string;
  }[];
}): WorkspaceConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === "symbol" ? part.toString() : part)),
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Load and validate the effective WorkspaceConfigV1 for `dir`. Legacy or
 * missing discovery is intentionally rejected until C03 adds compatibility.
 */
export async function loadWorkspaceConfig(
  dir: string,
  options: LoadWorkspaceConfigOptions = {},
): Promise<LoadedWorkspaceConfig> {
  const io: WorkspaceConfigLoaderIo = { ...defaultLoaderIo, ...options.io };

  let resolution: ProjectResolution;
  try {
    resolution = await io.resolveProject(dir, {
      explicitConfigPath: options.explicitConfigPath,
      io: options.resolverIo,
    });
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: "RESOLUTION_FAILED",
      stage: "resolution",
      message: `Cannot resolve a workspace config for ${dir}: ${errorDetail(cause)}`,
      cause,
    });
  }

  if (resolution.config.kind !== "workspace") {
    const message =
      resolution.config.kind === "legacy"
        ? `Found legacy config at ${resolution.config.path}; a .tmux-ide/workspace.yml config is required until C03 migration support is available`
        : `No .tmux-ide/workspace.yml config was found for ${resolution.inputDir}`;
    throw new WorkspaceConfigLoadError({
      code: "WORKSPACE_CONFIG_REQUIRED",
      stage: "resolution",
      path: resolution.config.path,
      message,
    });
  }

  const basePath = resolution.config.path;
  const baseDocument = parseMapping(readText(basePath, "base", io), basePath, "base");
  assertBaseVersion(baseDocument, basePath);

  const localCandidate = join(dirname(basePath), "workspace.local.yml");
  let localPath: string | null = null;
  let effectiveValue: unknown = cloneWorkspaceConfigValue(baseDocument);

  if (safeExists(localCandidate, io)) {
    localPath = canonicalizeExisting(localCandidate, io);
    const localDocument = parseMapping(readText(localPath, "local", io), localPath, "local");
    assertLocalVersion(localDocument, localPath);
    effectiveValue = mergeWorkspaceConfigValues(baseDocument, localDocument);
  }

  const validated = WorkspaceConfigV1SchemaZ.safeParse(effectiveValue);
  if (!validated.success) {
    const issues = validationIssues(validated.error);
    throw new WorkspaceConfigLoadError({
      code: "FINAL_VALIDATION_FAILED",
      stage: "validation",
      path: basePath,
      issues,
      message: `Effective workspace config is invalid: ${issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    });
  }

  return {
    config: validated.data,
    source: { basePath, localPath, resolution },
  };
}
