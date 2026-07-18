/**
 * Project registry — persists the list of projects the user has registered
 * with tmux-ide via the dashboard. Stored at `~/.tmux-ide/projects.json`,
 * written atomically via temp+rename (same approach as task-store).
 *
 * The pure decider (`applyAction`) is exported separately from the io-bound
 * accessors so tests can reason about state transitions without hitting the
 * filesystem. The module also exposes a `projectRegistryEmitter` that the
 * `/ws/events` channel listens on to broadcast `projects.changed` frames.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { RegisteredProjectSchemaZ, type RegisteredProject } from "../schemas/registry.ts";
import { probeProject, sanitizeName, type ProbeIo, type ProjectProbe } from "./project-probe.ts";

const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";

const RegistryFileSchemaZ = z.object({
  version: z.literal(1),
  projects: z.array(RegisteredProjectSchemaZ),
});

type RegistryFile = z.infer<typeof RegistryFileSchemaZ>;

// ---------------------------------------------------------------------------
// Typed errors — never use stringly-typed catches at the boundary
// ---------------------------------------------------------------------------

export class ProjectRegistryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ProjectRegistryError";
    this.code = code;
  }
}

export class ProjectAlreadyRegisteredError extends ProjectRegistryError {
  readonly suggestion: string;
  constructor(name: string, suggestion: string) {
    super(`Project "${name}" is already registered`, "ALREADY_REGISTERED");
    this.name = "ProjectAlreadyRegisteredError";
    this.suggestion = suggestion;
  }
}

export class ProjectNotFoundError extends ProjectRegistryError {
  constructor(name: string) {
    super(`Project "${name}" not found in registry`, "NOT_FOUND");
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectDirNotFoundError extends ProjectRegistryError {
  constructor(dir: string) {
    super(`Directory "${dir}" does not exist`, "DIR_NOT_FOUND");
    this.name = "ProjectDirNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Pure decider: state in → state out. No io.
// ---------------------------------------------------------------------------

export type RegistryAction =
  | { type: "register"; project: RegisteredProject }
  | { type: "unregister"; name: string }
  | { type: "replace"; project: RegisteredProject };

export function applyAction(
  state: readonly RegisteredProject[],
  action: RegistryAction,
): RegisteredProject[] {
  switch (action.type) {
    case "register":
      return [...state, action.project];
    case "unregister":
      return state.filter((p) => p.name !== action.name);
    case "replace":
      return state.map((p) => (p.name === action.project.name ? action.project : p));
  }
}

/**
 * Resolve a unique name for a probed project, appending `-2`, `-3`, … until
 * we don't collide with an existing entry.
 */
export function resolveUniqueName(state: readonly RegisteredProject[], desired: string): string {
  const used = new Set(state.map((p) => p.name));
  if (!used.has(desired)) return desired;
  let counter = 2;
  while (used.has(`${desired}-${counter}`)) counter++;
  return `${desired}-${counter}`;
}

/**
 * Build a `RegisteredProject` value from a probe + chosen name + timestamp.
 * Pure — separated from `registerProject` so tests can verify the shape
 * without io.
 */
export function buildRegisteredProject(
  probe: ProjectProbe,
  name: string,
  registeredAt: string,
): RegisteredProject {
  return {
    name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    hasWorkspaceConfig: probe.hasWorkspaceConfig,
    configKind: probe.configKind,
    configPath: probe.configPath,
    ideConfigPath: probe.ideConfigPath,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    registeredAt,
  };
}

// ---------------------------------------------------------------------------
// Module-level emitter — listened on by ws-events.handleWsEventsConnection
// ---------------------------------------------------------------------------

export const projectRegistryEmitter = new EventEmitter();
// One listener per connected ws-events client; can grow with tabs.
projectRegistryEmitter.setMaxListeners(0);

// ---------------------------------------------------------------------------
// Persistence — io-bound, single mutex (registry is small + writes are rare)
// ---------------------------------------------------------------------------

function registryDir(): string {
  const override = process.env[REGISTRY_DIR_ENV];
  if (override && override.length > 0) return override;
  return join(homedir(), ".tmux-ide");
}

function registryPath(): string {
  return join(registryDir(), "projects.json");
}

let cache: RegisteredProject[] | null = null;

function readDisk(): RegisteredProject[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[project-registry] %s contains invalid JSON; ignoring", path);
    return [];
  }
  const result = RegistryFileSchemaZ.safeParse(parsed);
  if (!result.success) {
    console.warn(
      "[project-registry] %s failed schema validation; ignoring (%s)",
      path,
      result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
    return [];
  }
  return result.data.projects;
}

function writeDisk(projects: RegisteredProject[]): void {
  const path = registryPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const file: RegistryFile = { version: 1, projects };
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function ensureCache(): RegisteredProject[] {
  if (cache !== null) return cache;
  cache = readDisk();
  return cache;
}

function commit(next: RegisteredProject[]): void {
  cache = next;
  writeDisk(next);
  projectRegistryEmitter.emit("change");
}

// ---------------------------------------------------------------------------
// Public api
// ---------------------------------------------------------------------------

export function listProjects(): RegisteredProject[] {
  // Return a defensive copy so callers can't mutate the cache.
  return [...ensureCache()];
}

export function getProject(name: string): RegisteredProject | null {
  return ensureCache().find((p) => p.name === name) ?? null;
}

export interface RegisterInput {
  dir: string;
  name?: string;
  /** Pluggable io for tests. */
  io?: ProbeIo;
  /** Override `Date.now()` for deterministic tests. */
  now?: () => Date;
  /** Override existsSync for the dir-validity check (tests). */
  exists?: (path: string) => boolean;
}

export async function registerProject(input: RegisterInput): Promise<RegisteredProject> {
  const exists = input.exists ?? existsSync;
  const absoluteDir = isAbsolute(input.dir) ? input.dir : resolve(input.dir);
  if (!exists(absoluteDir)) {
    throw new ProjectDirNotFoundError(absoluteDir);
  }

  const probe = await probeProject(absoluteDir, input.io);
  const state = ensureCache();

  // If a name was explicitly requested, treat collisions as hard errors and
  // suggest an alternative. If no name was given, auto-resolve via -2/-3/…
  const desired = input.name ? sanitizeName(input.name) : probe.name;
  const cleaned = desired.length > 0 ? desired : probe.name;
  let resolvedName: string;
  if (input.name) {
    if (state.some((p) => p.name === cleaned)) {
      throw new ProjectAlreadyRegisteredError(cleaned, resolveUniqueName(state, cleaned));
    }
    resolvedName = cleaned;
  } else {
    resolvedName = resolveUniqueName(state, cleaned);
  }

  // Reject re-registering the same dir (different name). Probe again under a
  // different name is fine, but we want to avoid duplicate dirs in the list.
  const dupDir = state.find((p) => p.dir === probe.dir);
  if (dupDir) {
    throw new ProjectAlreadyRegisteredError(dupDir.name, dupDir.name);
  }

  const now = (input.now ?? (() => new Date()))();
  const project = buildRegisteredProject(probe, resolvedName, now.toISOString());
  commit(applyAction(state, { type: "register", project }));
  return project;
}

export function unregisterProject(name: string): void {
  const state = ensureCache();
  if (!state.some((p) => p.name === name)) {
    throw new ProjectNotFoundError(name);
  }
  commit(applyAction(state, { type: "unregister", name }));
}

export interface ProbeOptions {
  io?: ProbeIo;
}

/**
 * Re-probe a registered project by name, persist the refreshed snapshot, and
 * broadcast the change. Throws if the project isn't registered.
 */
export async function refreshProject(
  name: string,
  options: ProbeOptions = {},
): Promise<RegisteredProject> {
  const state = ensureCache();
  const existing = state.find((p) => p.name === name);
  if (!existing) throw new ProjectNotFoundError(name);

  const probe = await probeProject(existing.dir, options.io);
  const refreshed = buildRegisteredProject(probe, existing.name, existing.registeredAt);
  commit(applyAction(state, { type: "replace", project: refreshed }));
  return refreshed;
}

// ---------------------------------------------------------------------------
// Test helpers — never call from production code
// ---------------------------------------------------------------------------

/** Reset the in-memory cache. Tests use this between cases. */
export function _resetCacheForTests(): void {
  cache = null;
}

/** Force a re-read from disk on next access. */
export function _invalidateCacheForTests(): void {
  cache = null;
}
