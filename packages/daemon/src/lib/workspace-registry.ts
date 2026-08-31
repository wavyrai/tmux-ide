/**
 * Workspace registry — runtime list of projects the daemon is serving.
 *
 * Replaces the legacy single-session TMUX_IDE_SESSION env coupling so a
 * single daemon can host N concurrent projects (goal 12, T065).
 *
 * Persisted at ~/.tmux-ide/workspaces.json via atomic temp+rename. On
 * `load()` the registry reconciles itself against `tmux list-sessions`
 * output and drops entries whose session no longer exists.
 *
 * Distinct from project-registry.ts — that one is a long-lived
 * "bookmark list" of projects the user knows about (probed metadata).
 * This one tracks live workspaces and is reconciled with tmux on boot.
 */

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WorkspaceSchemaZ, type Workspace } from "@tmux-ide/contracts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

const RegistryFileSchemaZ = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceSchemaZ),
});

type RegistryFile = z.infer<typeof RegistryFileSchemaZ>;

export type WorkspaceRegistrySessionInventory =
  | { readonly status: "authoritative"; readonly sessions: readonly string[] }
  | { readonly status: "unavailable"; readonly detail: string }
  | { readonly status: "ambiguous"; readonly detail: string };

export type ListSessionsFn = () => readonly string[] | WorkspaceRegistrySessionInventory;

export type WorkspaceRegistryLoadResult =
  | {
      readonly status: "authoritative";
      readonly sessions: readonly string[];
      readonly removed: readonly string[];
    }
  | { readonly status: "preserved"; readonly reason: "unavailable" | "ambiguous" };

export const WORKSPACE_REGISTRY_TMUX_TIMEOUT_MS = 2_000;

type WorkspaceRegistryExecFileSync = (
  file: string,
  args: readonly string[],
  options: {
    readonly encoding: "utf-8";
    readonly stdio: readonly ["ignore", "pipe", "pipe"];
    readonly timeout: number;
  },
) => string;

export interface WorkspaceRegistryOptions {
  /** Override registry dir for tests. Defaults to ~/.tmux-ide. */
  dir?: string;
  /** Inject a tmux list-sessions implementation (defaults to bridge). */
  listSessions?: ListSessionsFn;
}

function isSessionInventory(
  value: readonly string[] | WorkspaceRegistrySessionInventory,
): value is WorkspaceRegistrySessionInventory {
  return !Array.isArray(value);
}

export interface AddWorkspaceInput {
  name: string;
  sessionName?: string;
  projectDir: string;
  ideConfigPath?: string | null;
  configKind?: "workspace" | "legacy" | "none";
  configPath?: string | null;
  hasWorkspaceConfig?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: () => Date;
  /** Live-only workspace; never serialized to workspaces.json. */
  persistence?: "durable" | "volatile";
}

export class WorkspaceAlreadyExistsError extends Error {
  readonly code = "ALREADY_EXISTS";
  constructor(name: string) {
    super(`Workspace "${name}" already exists`);
    this.name = "WorkspaceAlreadyExistsError";
  }
}

export class WorkspaceNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(name: string) {
    super(`Workspace "${name}" not found`);
    this.name = "WorkspaceNotFoundError";
  }
}

/**
 * Thin wrapper around the shared module emitter so consumers can subscribe
 * with typed events without depending on EventEmitter directly.
 */
export type WorkspaceEvent =
  | { type: "workspace.added"; workspace: Workspace }
  | { type: "workspace.removed"; name: string };

export class WorkspaceRegistry {
  private readonly dir: string;
  private readonly listSessions: ListSessionsFn;
  private readonly emitter = new EventEmitter();
  private workspaces: Workspace[] = [];
  private readonly volatileNames = new Set<string>();
  private loaded = false;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.dir = options.dir ?? resolveRuntimeNamespace().registryDir;
    this.listSessions = options.listSessions ?? defaultListSessions;
    this.emitter.setMaxListeners(0);
  }

  /**
   * Load workspaces from disk and reconcile against live tmux sessions.
   * Drops entries whose tmux session is gone (silently — they were
   * persisted by a prior daemon invocation that may have crashed).
   *
   * Safe to call repeatedly; subsequent calls re-reconcile.
   */
  async load(
    listSessions: ListSessionsFn = this.listSessions,
  ): Promise<WorkspaceRegistryLoadResult> {
    const fromDisk = this.readDisk();
    let inventory: WorkspaceRegistrySessionInventory;
    try {
      const observed = listSessions();
      inventory = isSessionInventory(observed)
        ? observed
        : { status: "authoritative", sessions: observed };
    } catch (error) {
      inventory = workspaceRegistryInventoryFailure(error);
    }
    if (inventory.status !== "authoritative") {
      // Absence of an authoritative inventory is not proof that a session
      // died. Preserve the durable rows byte-for-byte until the same tmux
      // authority can answer successfully.
      this.workspaces = fromDisk;
      this.loaded = true;
      return { status: "preserved", reason: inventory.status };
    }
    const live = new Set(inventory.sessions);
    const reconciled = fromDisk.filter((w) => live.has(w.sessionName));
    const removed = fromDisk
      .filter((workspace) => !live.has(workspace.sessionName))
      .map((workspace) => workspace.name);
    this.workspaces = reconciled;
    this.loaded = true;
    if (reconciled.length !== fromDisk.length) {
      this.writeDisk();
    }
    return { status: "authoritative", sessions: [...inventory.sessions], removed };
  }

  list(): Workspace[] {
    return [...this.workspaces];
  }

  get(name: string): Workspace | null {
    return this.workspaces.find((w) => w.name === name) ?? null;
  }

  has(name: string): boolean {
    return this.workspaces.some((w) => w.name === name);
  }

  add(input: AddWorkspaceInput): Workspace {
    if (this.has(input.name)) {
      throw new WorkspaceAlreadyExistsError(input.name);
    }
    const now = (input.now ?? (() => new Date()))();
    const workspace: Workspace = {
      name: input.name,
      sessionName: input.sessionName ?? input.name,
      projectDir: input.projectDir,
      ideConfigPath: input.ideConfigPath ?? null,
      configKind: input.configKind,
      configPath: input.configPath,
      hasWorkspaceConfig: input.hasWorkspaceConfig,
      addedAt: now.toISOString(),
    };
    const previous = this.workspaces;
    this.workspaces = [...previous, workspace];
    if (input.persistence === "volatile") this.volatileNames.add(workspace.name);
    try {
      this.writeDisk();
    } catch (error) {
      this.workspaces = previous;
      this.volatileNames.delete(workspace.name);
      throw error;
    }
    this.emitter.emit("workspace.added", workspace);
    return workspace;
  }

  /**
   * Follow a tmux session rename.
   *
   * The workspace NAME is the desktop catalog's identity and never moves —
   * every renderer reference, route parameter and persisted layout document is
   * keyed on it. Only the tmux session name changes. Without this, a rename
   * would orphan the entry: `load()` reconciles against `tmux list-sessions`
   * and drops any workspace whose session name is not live, so the workspace
   * would silently vanish on the next daemon start.
   */
  renameSession(name: string, sessionName: string): Workspace {
    const existing = this.get(name);
    if (!existing) throw new WorkspaceNotFoundError(name);
    if (existing.sessionName === sessionName) return existing;
    const renamed: Workspace = { ...existing, sessionName };
    const previous = this.workspaces;
    this.workspaces = previous.map((w) => (w.name === name ? renamed : w));
    try {
      this.writeDisk();
    } catch (error) {
      this.workspaces = previous;
      throw error;
    }
    return renamed;
  }

  remove(name: string): void {
    if (!this.has(name)) {
      throw new WorkspaceNotFoundError(name);
    }
    this.workspaces = this.workspaces.filter((w) => w.name !== name);
    this.volatileNames.delete(name);
    this.writeDisk();
    this.emitter.emit("workspace.removed", name);
  }

  /** Subscribe to workspace.added | workspace.removed events. */
  on<E extends WorkspaceEvent["type"]>(
    event: E,
    handler: (
      payload: Extract<WorkspaceEvent, { type: E }> extends { workspace: Workspace }
        ? Workspace
        : string,
    ) => void,
  ): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void);
  }

  // ----------------- io -----------------

  private filePath(): string {
    return join(this.dir, "workspaces.json");
  }

  private readDisk(): Workspace[] {
    const path = this.filePath();
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return [];
    }
    const result = RegistryFileSchemaZ.safeParse(parsed);
    if (!result.success) return [];
    return result.data.workspaces;
  }

  private writeDisk(): void {
    const path = this.filePath();
    mkdirSync(dirname(path), { recursive: true });
    const file: RegistryFile = {
      version: 1,
      workspaces: this.workspaces.filter(({ name }) => !this.volatileNames.has(name)),
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n");
    renameSync(tmp, path);
  }

  /** @internal Test-only: assert the registry is loaded. */
  _isLoaded(): boolean {
    return this.loaded;
  }
}

// ---------------------------------------------------------------------------
// Default singleton — the daemon process holds one registry; HTTP handlers
// import it via getDefaultWorkspaceRegistry().
// ---------------------------------------------------------------------------

let _default: WorkspaceRegistry | null = null;
let _defaultNamespaceKey: string | null = null;

export function getDefaultWorkspaceRegistry(): WorkspaceRegistry {
  const namespaceKey = resolveRuntimeNamespace().registryDir;
  if (!_default || _defaultNamespaceKey !== namespaceKey) {
    _default = new WorkspaceRegistry({ dir: namespaceKey });
    _defaultNamespaceKey = namespaceKey;
  }
  return _default;
}

/** @internal Test hook: replace the singleton. */
export function _setDefaultWorkspaceRegistryForTests(registry: WorkspaceRegistry | null): void {
  _default = registry;
  _defaultNamespaceKey = registry ? resolveRuntimeNamespace().registryDir : null;
}

function errorDetail(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const stderr = "stderr" in error ? error.stderr : null;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf8");
  return error instanceof Error ? error.message : String(error);
}

function workspaceRegistryInventoryFailure(error: unknown): WorkspaceRegistrySessionInventory {
  const chain: unknown[] = [];
  let cursor: unknown = error;
  while (chain.length < 5 && cursor !== null && cursor !== undefined) {
    chain.push(cursor);
    cursor =
      typeof cursor === "object" && cursor !== null && "cause" in cursor ? cursor.cause : undefined;
  }
  const codes = new Set(
    chain.flatMap((candidate) =>
      typeof candidate === "object" && candidate !== null && "code" in candidate
        ? [String(candidate.code)]
        : [],
    ),
  );
  const detail = errorDetail(error);
  const normalized = chain.map(errorDetail).join("\n").toLowerCase();
  if (
    codes.has("ETIMEDOUT") ||
    codes.has("ENOENT") ||
    codes.has("TMUX_UNAVAILABLE") ||
    normalized.includes("failed to connect to server") ||
    normalized.includes("no server running") ||
    normalized.includes("error connecting to") ||
    normalized.includes("connection refused")
  ) {
    return { status: "unavailable", detail };
  }
  return { status: "ambiguous", detail };
}

/** Read an inventory through a daemon-generation-pinned tmux runner. */
export function readWorkspaceRegistrySessionInventory(
  runTmux: (args: readonly string[]) => string,
): WorkspaceRegistrySessionInventory {
  try {
    const raw = runTmux(["list-sessions", "-F", "#{session_name}"]);
    return {
      status: "authoritative",
      sessions: raw.split("\n").filter(Boolean),
    };
  } catch (error) {
    return workspaceRegistryInventoryFailure(error);
  }
}

export function listTmuxSessionsForWorkspaceRegistry(
  run: WorkspaceRegistryExecFileSync,
): WorkspaceRegistrySessionInventory {
  try {
    const raw = run("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WORKSPACE_REGISTRY_TMUX_TIMEOUT_MS,
    });
    return {
      status: "authoritative",
      sessions: raw.split("\n").filter(Boolean),
    };
  } catch (error) {
    return workspaceRegistryInventoryFailure(error);
  }
}

function defaultListSessions(): WorkspaceRegistrySessionInventory {
  // Lazy import keeps tmux-bridge optional for test environments that
  // don't have tmux available; tests inject a stub instead.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  return listTmuxSessionsForWorkspaceRegistry(execFileSync as WorkspaceRegistryExecFileSync);
}
