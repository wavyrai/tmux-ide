import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { z } from "zod";
import { slugify } from "./slugify.ts";
import { GoalSchemaZ, MissionSchemaZ, TaskSchemaZ } from "../schemas/domain.ts";
import type { ProofSchema } from "../types.ts";

const TASKS_DIR = ".tasks";
const SCHEMA_VERSION = 1;
const OWN_WRITE_SUPPRESSION_MS = 200;
const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_WATCH_DEBOUNCE_MS = 100;
const RECONCILE_LOG_PREFIX = "[task-store]";
const ASSERTION_ID_PATTERN = /\*\*((?:VAL|ASSERT)[A-Z0-9_-]+)\*\*/g;

export interface Milestone {
  id: string;
  title: string;
  description: string;
  status: "locked" | "active" | "done" | "validating";
  order: number;
  created: string;
  updated: string;
}

export interface Mission {
  title: string;
  description: string;
  status: "planning" | "active" | "validating" | "complete";
  branch: string | null;
  milestones: Milestone[];
  created: string;
  updated: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done";
  acceptance: string;
  priority: number;
  created: string;
  updated: string;
  assignee: string | null;
  specialty: string | null;
  milestone: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  goal: string | null;
  status: "todo" | "in-progress" | "review" | "done";
  assignee: string | null;
  priority: number;
  created: string;
  updated: string;
  tags: string[];
  proof: ProofSchema | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  nextRetryAt: string | null;
  depends_on: string[];
  milestone: string | null;
  specialty: string | null;
  fulfills: string[];
  discoveredIssues: string[];
  salientSummary: string | null;
}

type SchemaName = "mission" | "goal" | "task";
type StoreValue = Mission | Goal | Task;

export interface TaskStoreChangeEvent {
  path: string | null;
  schemaName?: SchemaName;
  source: string;
  op?: "create" | "update" | "delete" | "invalidate" | "reconcile";
  id?: string;
  drift?: number;
}

const schemas: Record<SchemaName, z.ZodType<StoreValue>> = {
  mission: MissionSchemaZ,
  goal: GoalSchemaZ,
  task: TaskSchemaZ,
};

interface CacheEntry<T extends StoreValue = StoreValue> {
  filePath: string;
  schemaName: SchemaName;
  value: T;
  hash: string;
}

interface MigrationResult {
  raw: unknown;
  migrations: string[];
}

export interface TaskStoreIssue {
  type:
    | "schema"
    | "orphan-goal"
    | "orphan-dependency"
    | "missing-proof"
    | "unclaimed-assertion"
    | "stale-lock"
    | "drift";
  file?: string;
  message: string;
  taskId?: string;
  fixed?: boolean;
}

export interface TaskStoreIntegrityReport {
  ok: boolean;
  issues: TaskStoreIssue[];
}

export interface TaskStoreHealth {
  ok: boolean;
  uptimeMs: number;
  lastReconcileMs: number;
  cacheSize: number;
  driftCount: number;
  watcherActive: boolean;
  writeQueueDepth: number;
}

export interface TaskStoreMetrics {
  uptimeMs: number;
  cache: {
    size: number;
    maxSize: number;
    hits: number;
    misses: number;
    evictions: number;
  };
  watcher: {
    active: boolean;
    debounceMs: number;
    events: number;
    suppressed: number;
    batchedFlushes: number;
    pending: number;
  };
  reconcile: {
    runs: number;
    driftCount: number;
    lastMs: number;
  };
  writes: {
    active: number;
    count: number;
    lastMs: number;
    p95Ms: number;
  };
}

export class TaskStoreValidationError extends Error {
  readonly filePath: string;
  readonly schemaName: SchemaName;
  readonly summary: string;

  constructor(filePath: string, schemaName: SchemaName, summary: string) {
    super(`${filePath}: ${schemaName} schema validation failed: ${summary}`);
    this.name = "TaskStoreValidationError";
    this.filePath = filePath;
    this.schemaName = schemaName;
    this.summary = summary;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function serializeJson(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function zodSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function readVersion(raw: unknown): number {
  if (!isRecord(raw)) return 0;
  return typeof raw._version === "number" ? raw._version : 0;
}

export function normalizeMission(raw: Record<string, unknown>): Mission {
  const epoch = "1970-01-01T00:00:00.000Z";
  return {
    title: (raw.title as string) ?? "",
    description: (raw.description as string) ?? "",
    status: (raw.status as Mission["status"]) ?? "active",
    branch: (raw.branch as string | null) ?? null,
    milestones: Array.isArray(raw.milestones) ? (raw.milestones as Mission["milestones"]) : [],
    created: (raw.created as string) ?? epoch,
    updated: (raw.updated as string) ?? epoch,
  };
}

export function normalizeGoal(raw: Record<string, unknown>): Goal {
  const epoch = "1970-01-01T00:00:00.000Z";
  const rest = { ...raw };
  delete rest._version;
  return {
    ...(rest as Omit<Goal, "assignee" | "specialty" | "created" | "updated" | "milestone">),
    created: (raw.created as string) ?? epoch,
    updated: (raw.updated as string) ?? epoch,
    assignee: (raw.assignee as string | null) ?? null,
    specialty: (raw.specialty as string | null) ?? null,
    milestone: (raw.milestone as string | null) ?? null,
  } as Goal;
}

export function normalizeTask(raw: Record<string, unknown>): Task {
  let proof = raw.proof as ProofSchema | null | undefined;
  if (isRecord(proof) && "note" in proof && !("notes" in proof)) {
    const { note, ...rest } = proof;
    proof = { ...rest, notes: String(note) } as ProofSchema;
  }

  const defaults = {
    goal: null,
    assignee: null,
    tags: [] as string[],
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [] as string[],
  };

  const rest = { ...raw };
  delete rest._version;
  return {
    ...defaults,
    ...(rest as Omit<
      Task,
      | "goal"
      | "assignee"
      | "tags"
      | "retryCount"
      | "maxRetries"
      | "lastError"
      | "nextRetryAt"
      | "depends_on"
    >),
    goal: (raw.goal as string | null) ?? defaults.goal,
    assignee: (raw.assignee as string | null) ?? defaults.assignee,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : defaults.tags,
    proof: proof ?? null,
    retryCount: (raw.retryCount as number) ?? defaults.retryCount,
    maxRetries: (raw.maxRetries as number) ?? defaults.maxRetries,
    lastError: (raw.lastError as string | null) ?? defaults.lastError,
    nextRetryAt: (raw.nextRetryAt as string | null) ?? defaults.nextRetryAt,
    depends_on: Array.isArray(raw.depends_on) ? (raw.depends_on as string[]) : defaults.depends_on,
    milestone: (raw.milestone as string | null) ?? null,
    specialty: (raw.specialty as string | null) ?? null,
    fulfills: Array.isArray(raw.fulfills) ? (raw.fulfills as string[]) : [],
    discoveredIssues: Array.isArray(raw.discoveredIssues) ? (raw.discoveredIssues as string[]) : [],
    salientSummary: (raw.salientSummary as string | null) ?? null,
  } as Task;
}

export function migrateOnRead(raw: unknown, schemaName: SchemaName): MigrationResult {
  if (!isRecord(raw)) return { raw, migrations: [] };

  const version = readVersion(raw);
  const migrations: string[] = [];
  let next: Record<string, unknown> = { ...raw };

  if (schemaName === "task") {
    const proof = next.proof;
    if (isRecord(proof) && "note" in proof && !("notes" in proof)) {
      next = {
        ...next,
        proof: {
          ...proof,
          notes: proof.note,
        },
      };
      delete (next.proof as Record<string, unknown>).note;
      migrations.push("proof.note -> proof.notes");
    }
  }

  if (version < SCHEMA_VERSION) {
    if (schemaName === "mission")
      next = normalizeMission(next) as unknown as Record<string, unknown>;
    if (schemaName === "goal") next = normalizeGoal(next) as unknown as Record<string, unknown>;
    if (schemaName === "task") next = normalizeTask(next) as unknown as Record<string, unknown>;
    migrations.push(`v${version} -> v${SCHEMA_VERSION}`);
  }

  return { raw: next, migrations };
}

function cacheableFiles(dir: string): { filePath: string; schemaName: SchemaName }[] {
  const root = getTasksRoot(dir);
  const files: { filePath: string; schemaName: SchemaName }[] = [];
  const mission = join(root, "mission.json");
  if (existsSync(mission)) files.push({ filePath: mission, schemaName: "mission" });

  for (const [subdir, schemaName] of [
    ["goals", "goal"],
    ["tasks", "task"],
  ] as const) {
    const directory = join(root, subdir);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      files.push({ filePath: join(directory, file), schemaName });
    }
  }

  return files;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else out.push(path);
  }
  return out;
}

function parseAssertionIds(contract: string): string[] {
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ASSERTION_ID_PATTERN.exec(contract)) !== null) {
    ids.add(match[1]!);
  }
  return [...ids];
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getCacheLimit(): number {
  return readPositiveIntEnv("TMUX_IDE_TASKSTORE_CACHE_SIZE", DEFAULT_CACHE_SIZE);
}

function getWatcherDebounceMs(): number {
  return readPositiveIntEnv("TMUX_IDE_WATCHER_DEBOUNCE_MS", DEFAULT_WATCH_DEBOUNCE_MS);
}

function getStoreValueId(value: StoreValue): string | undefined {
  if ("id" in value) return value.id;
  return undefined;
}

function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

function findFileById(directory: string, id: string): string | null {
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (file.startsWith(id + "-") || file === id + ".json") {
      return join(directory, file);
    }
  }
  return null;
}

export class TaskStore extends EventEmitter {
  private cache = new Map<string, CacheEntry>();
  private ownWriteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingWatchPaths = new Set<string>();
  private watchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: FSWatcher | null = null;
  private watchedRoot: string | null = null;
  private startedAt = Date.now();
  private lastReconcileMs = 0;
  private driftCount = 0;
  private activeWrites = 0;
  private taskById = new Map<string, Task>();
  private taskPathById = new Map<string, string>();
  private tasksByStatus = new Map<Task["status"], Set<string>>();
  private tasksByAgentPane = new Map<string, Set<string>>();
  private tasksByGoal = new Map<string, Set<string>>();
  private tasksByMilestone = new Map<string, Set<string>>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private watcherEvents = 0;
  private watcherSuppressed = 0;
  private watcherBatchedFlushes = 0;
  private reconcileRuns = 0;
  private writeCount = 0;
  private lastWriteMs = 0;
  private writeSamples: number[] = [];

  read<T extends StoreValue>(filePath: string, schemaName: SchemaName): T {
    const absolute = resolve(filePath);
    const cached = this.cache.get(absolute);
    if (cached) {
      this.cacheHits++;
      this.cache.delete(absolute);
      this.cache.set(absolute, cached);
      return cached.value as T;
    }

    this.cacheMisses++;
    const content = readFileSync(absolute, "utf-8");
    const parsed = this.parseContent<T>(absolute, schemaName, content);
    this.seedCache(absolute, schemaName, parsed, content);
    return parsed;
  }

  safeRead<T extends StoreValue>(filePath: string, schemaName: SchemaName): T | null {
    try {
      return this.read<T>(filePath, schemaName);
    } catch (err) {
      console.warn("[task-store] %s", (err as Error).message);
      return null;
    }
  }

  writeAtomic<T extends StoreValue>(filePath: string, schemaName: SchemaName, value: T): void {
    const absolute = resolve(filePath);
    const op = existsSync(absolute) ? "update" : "create";
    const body = { _version: SCHEMA_VERSION, ...value };
    const content = serializeJson(body);
    const parsed = this.parseContent<T>(absolute, schemaName, content);
    const tmpPath = `${absolute}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

    mkdirSync(dirname(absolute), { recursive: true });
    this.activeWrites++;
    const started = Date.now();
    try {
      writeFileSync(tmpPath, content);
      this.markOwnWrite(absolute);
      renameSync(tmpPath, absolute);
      this.seedCache(absolute, schemaName, parsed, content);
      this.emit("change", {
        path: absolute,
        schemaName,
        source: "write",
        op,
        id: getStoreValueId(parsed),
      } satisfies TaskStoreChangeEvent);
    } finally {
      this.recordWriteSample(Date.now() - started);
      this.activeWrites--;
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // best-effort temp cleanup
        }
      }
    }
  }

  unlink(filePath: string): void {
    const absolute = resolve(filePath);
    const cached = this.cache.get(absolute);
    const schemaName = cached?.schemaName ?? schemaForCacheablePath(absolute) ?? undefined;
    const id = cached ? getStoreValueId(cached.value) : undefined;
    this.markOwnWrite(absolute);
    unlinkSync(absolute);
    this.removeFromCache(absolute);
    this.emit("change", { path: absolute, schemaName, source: "delete", op: "delete", id });
  }

  invalidate(filePath: string, source = "external"): void {
    const absolute = resolve(filePath);
    const removed = this.removeFromCache(absolute);
    if (removed) {
      this.emit("change", {
        path: absolute,
        schemaName: removed.schemaName,
        source,
        op: "invalidate",
        id: getStoreValueId(removed.value),
      } satisfies TaskStoreChangeEvent);
    }
  }

  invalidateAll(): void {
    if (this.cache.size === 0) return;
    this.cache.clear();
    this.clearIndexes();
    this.emit("change", { path: null, source: "invalidate-all" });
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  getHealth(): TaskStoreHealth {
    return {
      ok: this.driftCount === 0,
      uptimeMs: Date.now() - this.startedAt,
      lastReconcileMs: this.lastReconcileMs,
      cacheSize: this.cache.size,
      driftCount: this.driftCount,
      watcherActive: this.watcher !== null,
      writeQueueDepth: this.activeWrites,
    };
  }

  getMetrics(): TaskStoreMetrics {
    return {
      uptimeMs: Date.now() - this.startedAt,
      cache: {
        size: this.cache.size,
        maxSize: getCacheLimit(),
        hits: this.cacheHits,
        misses: this.cacheMisses,
        evictions: this.cacheEvictions,
      },
      watcher: {
        active: this.watcher !== null,
        debounceMs: getWatcherDebounceMs(),
        events: this.watcherEvents,
        suppressed: this.watcherSuppressed,
        batchedFlushes: this.watcherBatchedFlushes,
        pending: this.pendingWatchPaths.size,
      },
      reconcile: {
        runs: this.reconcileRuns,
        driftCount: this.driftCount,
        lastMs: this.lastReconcileMs,
      },
      writes: {
        active: this.activeWrites,
        count: this.writeCount,
        lastMs: this.lastWriteMs,
        p95Ms: p95(this.writeSamples),
      },
    };
  }

  getTasksByStatus(status: Task["status"]): Task[] {
    return this.tasksFromIndex(this.tasksByStatus.get(status));
  }

  getTasksByAgentPane(agentPane: string): Task[] {
    return this.tasksFromIndex(this.tasksByAgentPane.get(agentPane));
  }

  getTasksByGoal(goalId: string): Task[] {
    return this.tasksFromIndex(this.tasksByGoal.get(goalId));
  }

  getTasksByMilestone(milestoneId: string): Task[] {
    return this.tasksFromIndex(this.tasksByMilestone.get(milestoneId));
  }

  startWatcher(dir: string): () => Promise<void> {
    const root = getTasksRoot(dir);
    if (this.watcher && this.watchedRoot === root) {
      return async () => this.stopWatcher();
    }

    void this.stopWatcher();
    ensureTasksDir(dir);
    this.watchedRoot = root;
    this.watcher = watch(root, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    });

    const invalidateFromWatch = (path: string) => {
      this.watcherEvents++;
      const absolute = resolve(path);
      if (this.isOwnWrite(absolute)) {
        this.watcherSuppressed++;
        return;
      }

      this.pendingWatchPaths.add(absolute);
      this.scheduleWatchFlush();
    };

    this.watcher.on("add", invalidateFromWatch);
    this.watcher.on("change", invalidateFromWatch);
    this.watcher.on("unlink", invalidateFromWatch);
    this.watcher.on("unlinkDir", invalidateFromWatch);
    this.watcher.on("error", (err) => {
      console.warn("[task-store] watcher error: %s", (err as Error).message);
    });

    return async () => this.stopWatcher();
  }

  async stopWatcher(): Promise<void> {
    if (this.watchFlushTimer) clearTimeout(this.watchFlushTimer);
    this.watchFlushTimer = null;
    this.pendingWatchPaths.clear();
    if (!this.watcher) return;
    const watcher = this.watcher;
    this.watcher = null;
    this.watchedRoot = null;
    await watcher.close();
  }

  reconcile(dir: string): number {
    this.reconcileRuns++;
    const started = Date.now();
    const root = getTasksRoot(dir);
    const diskFiles = cacheableFiles(dir);
    const diskPaths = new Set(diskFiles.map((f) => resolve(f.filePath)));
    let drift = 0;

    for (const { filePath } of diskFiles) {
      const absolute = resolve(filePath);
      const cached = this.cache.get(absolute);
      if (!cached) {
        drift++;
        continue;
      }
      const hash = hashContent(readFileSync(absolute, "utf-8"));
      if (hash !== cached.hash) drift++;
    }

    for (const [filePath] of this.cache) {
      if (!filePath.startsWith(root)) continue;
      if (!diskPaths.has(filePath)) {
        drift++;
      }
    }

    this.lastReconcileMs = Date.now() - started;
    this.driftCount = drift;
    if (drift > 0) {
      console.warn("%s reconcile detected %d cache drift issue(s)", RECONCILE_LOG_PREFIX, drift);
      this.emit("change", {
        path: root,
        source: "reconcile",
        op: "reconcile",
        drift,
      } satisfies TaskStoreChangeEvent);
    }
    return drift;
  }

  validateFile(filePath: string, schemaName: SchemaName): StoreValue {
    const absolute = resolve(filePath);
    const content = readFileSync(absolute, "utf-8");
    return this.parseContent(absolute, schemaName, content);
  }

  private parseContent<T extends StoreValue>(
    filePath: string,
    schemaName: SchemaName,
    content: string,
  ): T {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (err) {
      throw new TaskStoreValidationError(
        filePath,
        schemaName,
        `invalid JSON: ${(err as Error).message}`,
      );
    }

    const migrated = migrateOnRead(raw, schemaName);
    for (const migration of migrated.migrations) {
      console.warn("[task-store] migrated %s (%s): %s", filePath, schemaName, migration);
    }

    const result = schemas[schemaName].safeParse(migrated.raw);
    if (!result.success) {
      throw new TaskStoreValidationError(filePath, schemaName, zodSummary(result.error));
    }
    return result.data as T;
  }

  private seedCache<T extends StoreValue>(
    filePath: string,
    schemaName: SchemaName,
    value: T,
    content: string,
  ): void {
    const absolute = resolve(filePath);
    this.removeFromCache(absolute);
    this.cache.set(absolute, {
      filePath: absolute,
      schemaName,
      value,
      hash: hashContent(content),
    });
    if (schemaName === "task") this.addTaskToIndexes(absolute, value as Task);
    this.enforceCacheLimit();
  }

  private removeFromCache(filePath: string): CacheEntry | null {
    const absolute = resolve(filePath);
    const existing = this.cache.get(absolute);
    if (!existing) return null;
    this.cache.delete(absolute);
    if (existing.schemaName === "task") this.removeTaskFromIndexes(existing.value as Task);
    return existing;
  }

  private addTaskToIndexes(filePath: string, task: Task): void {
    const oldPath = this.taskPathById.get(task.id);
    if (oldPath && oldPath !== filePath) this.removeFromCache(oldPath);
    this.taskById.set(task.id, task);
    this.taskPathById.set(task.id, filePath);
    this.addIndex(this.tasksByStatus, task.status, task.id);
    if (task.assignee) this.addIndex(this.tasksByAgentPane, task.assignee, task.id);
    if (task.goal) this.addIndex(this.tasksByGoal, task.goal, task.id);
    if (task.milestone) this.addIndex(this.tasksByMilestone, task.milestone, task.id);
  }

  private removeTaskFromIndexes(task: Task): void {
    this.taskById.delete(task.id);
    this.taskPathById.delete(task.id);
    this.removeIndex(this.tasksByStatus, task.status, task.id);
    if (task.assignee) this.removeIndex(this.tasksByAgentPane, task.assignee, task.id);
    if (task.goal) this.removeIndex(this.tasksByGoal, task.goal, task.id);
    if (task.milestone) this.removeIndex(this.tasksByMilestone, task.milestone, task.id);
  }

  private addIndex(map: Map<string, Set<string>>, key: string, id: string): void {
    let ids = map.get(key);
    if (!ids) {
      ids = new Set();
      map.set(key, ids);
    }
    ids.add(id);
  }

  private removeIndex(map: Map<string, Set<string>>, key: string, id: string): void {
    const ids = map.get(key);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) map.delete(key);
  }

  private clearIndexes(): void {
    this.taskById.clear();
    this.taskPathById.clear();
    this.tasksByStatus.clear();
    this.tasksByAgentPane.clear();
    this.tasksByGoal.clear();
    this.tasksByMilestone.clear();
  }

  private tasksFromIndex(ids: Set<string> | undefined): Task[] {
    if (!ids) return [];
    return [...ids].map((id) => this.taskById.get(id)).filter((task): task is Task => !!task);
  }

  private enforceCacheLimit(): void {
    const limit = getCacheLimit();
    while (this.cache.size > limit) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) return;
      this.removeFromCache(oldest);
      this.cacheEvictions++;
    }
  }

  private scheduleWatchFlush(): void {
    if (this.watchFlushTimer) return;
    this.watchFlushTimer = setTimeout(() => {
      this.watchFlushTimer = null;
      const paths = [...this.pendingWatchPaths];
      this.pendingWatchPaths.clear();
      if (paths.length === 0) return;
      this.watcherBatchedFlushes++;
      for (const path of paths) this.invalidate(path, "watcher");
    }, getWatcherDebounceMs());
  }

  private recordWriteSample(durationMs: number): void {
    this.writeCount++;
    this.lastWriteMs = durationMs;
    this.writeSamples.push(durationMs);
    if (this.writeSamples.length > 100) this.writeSamples.shift();
  }

  private markOwnWrite(filePath: string): void {
    const absolute = resolve(filePath);
    const existing = this.ownWriteTimers.get(absolute);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.ownWriteTimers.delete(absolute);
    }, OWN_WRITE_SUPPRESSION_MS);
    this.ownWriteTimers.set(absolute, timer);
  }

  private isOwnWrite(filePath: string): boolean {
    return this.ownWriteTimers.has(resolve(filePath));
  }
}

export const taskStore = new TaskStore();

export function getTasksRoot(dir: string): string {
  return resolve(dir, TASKS_DIR);
}

export function ensureTasksDir(dir: string): void {
  const root = getTasksRoot(dir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const goalsDir = join(root, "goals");
  if (!existsSync(goalsDir)) mkdirSync(goalsDir);
  const tasksDir = join(root, "tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir);
}

export function startTaskStoreWatcher(dir: string): () => Promise<void> {
  return taskStore.startWatcher(dir);
}

export function reconcileTaskStore(dir: string): number {
  return taskStore.reconcile(dir);
}

export function getTaskStoreHealth(): TaskStoreHealth {
  return taskStore.getHealth();
}

export function getTaskStoreMetrics(): TaskStoreMetrics {
  return taskStore.getMetrics();
}

export function invalidateTaskStore(path: string): void {
  taskStore.invalidate(path);
}

export function invalidateAllTaskStore(): void {
  taskStore.invalidateAll();
}

export function validateTaskStoreFile(filePath: string, schemaName: SchemaName): StoreValue {
  return taskStore.validateFile(filePath, schemaName);
}

// --- Mission ---

export function loadMission(dir: string): Mission | null {
  const path = join(getTasksRoot(dir), "mission.json");
  if (!existsSync(path)) return null;
  return taskStore.safeRead<Mission>(path, "mission");
}

export function saveMission(dir: string, mission: Mission): void {
  ensureTasksDir(dir);
  taskStore.writeAtomic(
    join(getTasksRoot(dir), "mission.json"),
    "mission",
    normalizeMission(mission as unknown as Record<string, unknown>),
  );
}

export function clearMission(dir: string): void {
  const path = join(getTasksRoot(dir), "mission.json");
  if (existsSync(path)) taskStore.unlink(path);
}

// --- Goals ---

export function nextGoalId(dir: string): string {
  const goalsDir = join(getTasksRoot(dir), "goals");
  if (!existsSync(goalsDir)) return "01";
  const files = readdirSync(goalsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "01";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(2, "0");
}

export function loadGoals(dir: string): Goal[] {
  const goalsDir = join(getTasksRoot(dir), "goals");
  if (!existsSync(goalsDir)) return [];
  return readdirSync(goalsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => taskStore.safeRead<Goal>(join(goalsDir, f), "goal"))
    .filter((g): g is Goal => g !== null);
}

export function loadGoal(dir: string, id: string): Goal | null {
  const file = findFileById(join(getTasksRoot(dir), "goals"), id);
  if (!file) return null;
  return taskStore.safeRead<Goal>(file, "goal");
}

export function saveGoal(dir: string, goal: Goal): void {
  ensureTasksDir(dir);
  const normalized = normalizeGoal(goal as unknown as Record<string, unknown>);
  const goalsDir = join(getTasksRoot(dir), "goals");
  const existing = findFileById(goalsDir, normalized.id);
  const filename = `${normalized.id}-${slugify(normalized.title, 50)}.json`;
  const newPath = join(goalsDir, filename);
  taskStore.writeAtomic(newPath, "goal", normalized);
  if (existing && existing !== newPath) taskStore.unlink(existing);
}

export function deleteGoal(dir: string, id: string): boolean {
  const file = findFileById(join(getTasksRoot(dir), "goals"), id);
  if (!file) return false;
  taskStore.unlink(file);
  return true;
}

// --- Tasks ---

export function nextTaskId(dir: string): string {
  const tasksDir = join(getTasksRoot(dir), "tasks");
  if (!existsSync(tasksDir)) return "001";
  const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "001";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(3, "0");
}

export function loadTasks(dir: string): Task[] {
  const tasksDir = join(getTasksRoot(dir), "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => taskStore.safeRead<Task>(join(tasksDir, f), "task"))
    .filter((t): t is Task => t !== null);
}

export function loadTask(dir: string, id: string): Task | null {
  const file = findFileById(join(getTasksRoot(dir), "tasks"), id);
  if (!file) return null;
  return taskStore.safeRead<Task>(file, "task");
}

export function saveTask(dir: string, task: Task): void {
  ensureTasksDir(dir);
  const normalized = normalizeTask(task as unknown as Record<string, unknown>);
  const tasksDir = join(getTasksRoot(dir), "tasks");
  const existing = findFileById(tasksDir, normalized.id);
  const filename = `${normalized.id}-${slugify(normalized.title, 50)}.json`;
  const newPath = join(tasksDir, filename);
  taskStore.writeAtomic(newPath, "task", normalized);
  if (existing && existing !== newPath) taskStore.unlink(existing);
}

export function deleteTask(dir: string, id: string): boolean {
  const file = findFileById(join(getTasksRoot(dir), "tasks"), id);
  if (!file) return false;
  taskStore.unlink(file);
  return true;
}

export function loadTasksForGoal(dir: string, goalId: string): Task[] {
  loadTasks(dir);
  return taskStore.getTasksByGoal(goalId);
}

export function loadTasksByStatus(dir: string, status: Task["status"]): Task[] {
  loadTasks(dir);
  return taskStore.getTasksByStatus(status);
}

export function loadTasksByAgentPane(dir: string, agentPane: string): Task[] {
  loadTasks(dir);
  return taskStore.getTasksByAgentPane(agentPane);
}

export function loadTasksByMilestone(dir: string, milestoneId: string): Task[] {
  loadTasks(dir);
  return taskStore.getTasksByMilestone(milestoneId);
}

export function detectCycle(dir: string, taskId: string, newDeps: string[]): string[] | null {
  const tasks = loadTasks(dir);
  const depMap = new Map<string, string[]>();
  for (const t of tasks) {
    depMap.set(t.id, [...t.depends_on]);
  }
  depMap.set(taskId, newDeps);

  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (path.includes(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    path.push(id);
    for (const dep of depMap.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop();
    return null;
  }

  return dfs(taskId);
}

function schemaForCacheablePath(filePath: string): SchemaName | null {
  const parts = filePath.split(/[\\/]/);
  if (basename(filePath) === "mission.json") return "mission";
  if (parts.includes("goals") && filePath.endsWith(".json")) return "goal";
  if (parts.includes("tasks") && filePath.endsWith(".json")) return "task";
  return null;
}

export function validateTasksTree(
  dir: string,
  options: { fix?: boolean } = {},
): TaskStoreIntegrityReport {
  const root = getTasksRoot(dir);
  const issues: TaskStoreIssue[] = [];
  const files = walkFiles(root);

  for (const file of files.filter((path) => path.endsWith(".json"))) {
    const schemaName = schemaForCacheablePath(file);
    if (!schemaName) continue;
    try {
      taskStore.validateFile(file, schemaName);
    } catch (err) {
      issues.push({
        type: "schema",
        file: relative(dir, file),
        message: (err as Error).message,
      });
    }
  }

  const goals = loadGoals(dir);
  const goalIds = new Set(goals.map((goal) => goal.id));
  const tasks = loadTasks(dir);
  const taskIds = new Set(tasks.map((task) => task.id));

  for (const task of tasks) {
    const file = findFileById(join(root, "tasks"), task.id) ?? undefined;
    if (task.goal && !goalIds.has(task.goal)) {
      const issue: TaskStoreIssue = {
        type: "orphan-goal",
        file: file ? relative(dir, file) : undefined,
        taskId: task.id,
        message: `Task ${task.id} references missing goal ${task.goal}`,
      };
      if (options.fix) {
        task.goal = null;
        task.updated = new Date().toISOString();
        saveTask(dir, task);
        issue.fixed = true;
      }
      issues.push(issue);
    }

    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        issues.push({
          type: "orphan-dependency",
          file: file ? relative(dir, file) : undefined,
          taskId: task.id,
          message: `Task ${task.id} depends on missing task ${dep}`,
        });
      }
    }

    if (task.status === "done" && !task.proof) {
      issues.push({
        type: "missing-proof",
        file: file ? relative(dir, file) : undefined,
        taskId: task.id,
        message: `Task ${task.id} is done but has no proof`,
      });
    }
  }

  const contractPath = join(root, "validation-contract.md");
  if (existsSync(contractPath)) {
    const assertionIds = parseAssertionIds(readFileSync(contractPath, "utf-8"));
    const claimed = new Set(tasks.flatMap((task) => task.fulfills));
    for (const assertionId of assertionIds) {
      if (!claimed.has(assertionId)) {
        issues.push({
          type: "unclaimed-assertion",
          file: relative(dir, contractPath),
          message: `Validation assertion ${assertionId} is claimed by no task`,
        });
      }
    }
  }

  const now = Date.now();
  for (const file of files.filter((path) => path.endsWith(".lock"))) {
    try {
      const ageMs = now - statSync(file).mtimeMs;
      if (ageMs > 5 * 60 * 1000) {
        issues.push({
          type: "stale-lock",
          file: relative(dir, file),
          message: `Stale lock file older than 5m: ${relative(dir, file)}`,
        });
      }
    } catch {
      // skip unreadable lock files
    }
  }

  const drift = taskStore.reconcile(dir);
  if (drift > 0) {
    issues.push({
      type: "drift",
      file: relative(dir, root),
      message: `Task-store cache drift detected: ${drift} issue(s)`,
    });
  }

  return { ok: issues.every((issue) => issue.fixed), issues };
}
