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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { WorkspaceSchemaZ, type Workspace } from "@tmux-ide/contracts";

const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";

const RegistryFileSchemaZ = z.object({
  version: z.literal(1),
  workspaces: z.array(WorkspaceSchemaZ),
});

type RegistryFile = z.infer<typeof RegistryFileSchemaZ>;

export type ListSessionsFn = () => readonly string[];

export interface WorkspaceRegistryOptions {
  /** Override registry dir for tests. Defaults to ~/.tmux-ide. */
  dir?: string;
  /** Inject a tmux list-sessions implementation (defaults to bridge). */
  listSessions?: ListSessionsFn;
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
  private loaded = false;

  constructor(options: WorkspaceRegistryOptions = {}) {
    this.dir = options.dir ?? process.env[REGISTRY_DIR_ENV] ?? join(homedir(), ".tmux-ide");
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
  async load(): Promise<void> {
    const fromDisk = this.readDisk();
    let live: Set<string>;
    try {
      live = new Set(this.listSessions());
    } catch {
      // tmux is unavailable — keep all entries; reconcile when we can.
      live = new Set(fromDisk.map((w) => w.sessionName));
    }
    const reconciled = fromDisk.filter((w) => live.has(w.sessionName));
    this.workspaces = reconciled;
    this.loaded = true;
    if (reconciled.length !== fromDisk.length) {
      this.writeDisk();
    }
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
    try {
      this.writeDisk();
    } catch (error) {
      this.workspaces = previous;
      throw error;
    }
    this.emitter.emit("workspace.added", workspace);
    return workspace;
  }

  remove(name: string): void {
    if (!this.has(name)) {
      throw new WorkspaceNotFoundError(name);
    }
    this.workspaces = this.workspaces.filter((w) => w.name !== name);
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
    const file: RegistryFile = { version: 1, workspaces: this.workspaces };
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

export function getDefaultWorkspaceRegistry(): WorkspaceRegistry {
  if (!_default) _default = new WorkspaceRegistry();
  return _default;
}

/** @internal Test hook: replace the singleton. */
export function _setDefaultWorkspaceRegistryForTests(registry: WorkspaceRegistry | null): void {
  _default = registry;
}

function defaultListSessions(): string[] {
  // Lazy import keeps tmux-bridge optional for test environments that
  // don't have tmux available; tests inject a stub instead.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    const raw = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as string;
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
