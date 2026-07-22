/**
 * NodePtyAdapter — concrete `PtyAdapter` backed by the `node-pty` native
 * module (T087). The only place in the daemon that imports `node-pty`.
 *
 * One-time setup:
 *   - macOS / Linux: node-pty ships a `spawn-helper` binary. The
 *     `chmod +x` is occasionally lost during install (npm tarball
 *     metadata edge cases). Borrowing t3's
 *     `ensureNodePtySpawnHelperExecutable`, we walk the published candidate
 *     paths and chmod 0755 once per process. Failure is best-effort —
 *     spawning will surface a real error if it actually matters.
 */

import { chmodSync, existsSync, statSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import {
  PtySpawnError,
  type PtyAdapter,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  type PtySpawnListeners,
} from "./PtyAdapter.ts";

const ADAPTER_ID = "node-pty";
let helperEnsured = false;

function candidateSpawnHelperPaths(): string[] {
  const requireForNodePty = createRequire(import.meta.url);
  let pkgJsonPath: string;
  try {
    pkgJsonPath = requireForNodePty.resolve("node-pty/package.json");
  } catch {
    // node-pty package missing — `pty.spawn` will throw a richer error.
    return [];
  }
  const pkgDir = dirname(pkgJsonPath);
  return [
    join(pkgDir, "build", "Release", "spawn-helper"),
    join(pkgDir, "build", "Debug", "spawn-helper"),
    join(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
}

/**
 * Chmod node-pty's `spawn-helper` to 0755 the first time we touch it.
 * No-op on Windows (no helper binary). Idempotent across calls.
 * Exported for the unit test that asserts the chmod side effect.
 */
export function ensureNodePtySpawnHelperExecutable(
  options: { explicitPath?: string; force?: boolean } = {},
): void {
  if (process.platform === "win32") return;
  if (!options.force && !options.explicitPath && helperEnsured) return;

  const candidates = options.explicitPath ? [options.explicitPath] : candidateSpawnHelperPaths();

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      chmodSync(candidate, 0o755);
    } catch {
      // Best-effort: a hardened filesystem may forbid chmod even when the
      // bit is already set. Continue to the next candidate so we never
      // fail spawning just because the helper was already executable.
    }
  }

  if (!options.explicitPath) helperEnsured = true;
}

function assertValidCwd(cwd: string, statFn: (cwd: string) => Stats): void {
  let stats: Stats;
  try {
    stats = statFn(cwd);
  } catch (err) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd does not exist or cannot be stat'd: ${cwd}`,
      cause: err,
    });
  }
  if (!stats.isDirectory()) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd is not a directory: ${cwd}`,
    });
  }
}

/**
 * Wrap a live `node-pty` IPty with the `PtyProcess` interface. Disposes are
 * idempotent; `kill` emits a synthetic exit if node-pty doesn't fire one
 * (e.g. when the child has already gone away under us).
 */
class NodePtyProcess implements PtyProcess {
  private exited = false;
  private readonly child: pty.IPty;
  private readonly dataListeners = new Set<(data: Buffer) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  constructor(child: pty.IPty, listeners: PtySpawnListeners = {}) {
    this.child = child;
    if (listeners.onData) this.dataListeners.add(listeners.onData);
    if (listeners.onExit) this.exitListeners.add(listeners.onExit);
    // node-pty hands us strings by default; we want raw buffers for
    // byte-accurate WS bridging. The encoding:null on spawn opts gives us
    // buffers in the typings of node-pty@1.2.0-beta.12.
    this.child.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
      for (const listener of this.dataListeners) listener(buf);
    });
    this.child.onExit((evt) => {
      this.exited = true;
      const event: PtyExitEvent = {
        exitCode: evt.exitCode ?? 0,
        signal: typeof evt.signal === "number" ? evt.signal : null,
      };
      const listeners = [...this.exitListeners];
      this.dataListeners.clear();
      this.exitListeners.clear();
      for (const listener of listeners) listener(event);
    });
  }

  get pid(): number {
    return this.child.pid;
  }

  write(data: string | Uint8Array): void {
    if (this.exited) return;
    if (typeof data === "string") this.child.write(data);
    else this.child.write(Buffer.from(data));
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    if (!Number.isInteger(cols) || cols <= 0)
      throw new RangeError("cols must be a positive integer");
    if (!Number.isInteger(rows) || rows <= 0)
      throw new RangeError("rows must be a positive integer");
    try {
      this.child.resize(cols, rows);
    } catch {
      // node-pty throws if the underlying fd is gone — treat as no-op so
      // bridge resize handlers don't have to special-case.
    }
  }

  pause(): void {
    if (!this.exited) this.child.pause();
  }

  resume(): void {
    if (!this.exited) this.child.resume();
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    try {
      this.child.kill(typeof signal === "number" ? String(signal) : signal);
    } catch {
      // Already gone. Synthesize an exit so listeners detach cleanly.
      this.exited = true;
      const listeners = [...this.exitListeners];
      this.dataListeners.clear();
      this.exitListeners.clear();
      for (const listener of listeners) listener({ exitCode: 0, signal: null });
    }
  }

  onData(callback: (data: Buffer) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    if (this.exited) {
      // Adapters MUST guarantee at most one terminal onExit — late
      // subscribers get an inert disposer.
      return () => undefined;
    }
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }
}

export interface NodePtyAdapterOptions {
  /** Override node-pty's `spawn` for tests. */
  spawnPty?: typeof pty.spawn;
  /** Override `fs.statSync` for cwd validation in tests. */
  statCwd?: (cwd: string) => Stats;
  /** Skip the spawn-helper chmod (test isolation). */
  skipHelperEnsure?: boolean;
}

export class NodePtyAdapter implements PtyAdapter {
  readonly id = ADAPTER_ID;
  private readonly spawnPty: typeof pty.spawn;
  private readonly statCwd: (cwd: string) => Stats;
  private readonly skipHelperEnsure: boolean;

  constructor(options: NodePtyAdapterOptions = {}) {
    this.spawnPty = options.spawnPty ?? pty.spawn;
    this.statCwd = options.statCwd ?? statSync;
    this.skipHelperEnsure = options.skipHelperEnsure ?? false;
  }

  async spawn(input: PtySpawnInput, listeners?: PtySpawnListeners): Promise<PtyProcess> {
    if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
    return this.spawnSyncInternal(input, listeners);
  }

  spawnSync(input: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
    if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
    return this.spawnSyncInternal(input, listeners);
  }

  private spawnSyncInternal(input: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
    assertValidCwd(input.cwd, this.statCwd);
    if (!Number.isInteger(input.cols) || input.cols <= 0) {
      throw new PtySpawnError({
        adapter: ADAPTER_ID,
        code: "unknown",
        message: `cols must be a positive integer (got ${input.cols})`,
      });
    }
    if (!Number.isInteger(input.rows) || input.rows <= 0) {
      throw new PtySpawnError({
        adapter: ADAPTER_ID,
        code: "unknown",
        message: `rows must be a positive integer (got ${input.rows})`,
      });
    }
    // node-pty wants `Record<string, string>` for env — strip undefined values.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === "string") env[key] = value;
    }
    let child: pty.IPty;
    try {
      child = this.spawnPty(input.shell, [...(input.args ?? [])], {
        name: input.name ?? "xterm-256color",
        cols: input.cols,
        rows: input.rows,
        cwd: input.cwd,
        env,
        encoding: input.encoding === "utf8" ? "utf8" : null,
      });
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException | undefined)?.code;
      if (errno === "ENOENT") {
        throw new PtySpawnError({
          adapter: ADAPTER_ID,
          code: "shell_not_found",
          message: `shell not found in PATH: ${input.shell}`,
          cause: err,
        });
      }
      if (errno === "EACCES" || errno === "EPERM") {
        throw new PtySpawnError({
          adapter: ADAPTER_ID,
          code: "permission_denied",
          message: `permission denied spawning ${input.shell}`,
          cause: err,
        });
      }
      throw new PtySpawnError({
        adapter: ADAPTER_ID,
        code: "unknown",
        message: `node-pty spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
    return new NodePtyProcess(child, listeners);
  }
}

/** Convenience singleton — most call sites just want `defaultNodePtyAdapter`. */
export const defaultNodePtyAdapter: PtyAdapter = new NodePtyAdapter();
