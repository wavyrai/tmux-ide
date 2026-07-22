/**
 * MockPtyAdapter — scripted PTY backend for tests (T087).
 *
 * Mirrors the `PtyAdapter` contract but spawns no real processes. Every
 * call to {@link MockPtyAdapter.spawn} or {@link MockPtyAdapter.spawnSync}
 * returns a fresh {@link MockPtyProcess} the test then drives manually via
 * {@link MockPtyProcess.pushOutput} / {@link MockPtyProcess.emitExit}.
 *
 * Drop-in for any layer that takes a `PtyAdapter`. The adapter also keeps
 * a `spawnLog` of every `PtySpawnInput` so tests can assert wiring without
 * inspecting node-pty internals.
 *
 * Why this lives under `__tests__/`: it is purely test infrastructure and
 * MUST NOT be bundled into the production daemon. Vitest's `include`
 * pulls it in implicitly when sibling tests import it.
 */

import {
  PtySpawnError,
  type PtyAdapter,
  type PtyExitEvent,
  type PtyProcess,
  type PtySpawnInput,
  type PtySpawnListeners,
} from "../PtyAdapter.ts";

export interface MockPtyOptions {
  /** Force `spawn` to reject with this error. Used by error-path tests. */
  failNext?: { code: PtySpawnError["code"]; message: string };
  /** When true, throw `sync_unsupported` from `spawnSync` to exercise async fallback. */
  syncUnsupported?: boolean;
  /** Synthetic starting pid for spawned processes; auto-increments. */
  startingPid?: number;
}

export class MockPtyProcess implements PtyProcess {
  readonly pid: number;
  /** Append-only log of every `write(...)` call so tests can assert input. */
  readonly writeLog: Array<string | Uint8Array> = [];
  /** Append-only log of every `resize(...)` call. */
  readonly resizeLog: Array<{ cols: number; rows: number }> = [];
  /** Records the last signal observed by `kill(...)`. */
  killed: NodeJS.Signals | number | null = null;

  private exited = false;
  private readonly dataListeners = new Set<(data: Buffer) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly _input: PtySpawnInput;

  constructor(pid: number, input: PtySpawnInput, listeners: PtySpawnListeners = {}) {
    this.pid = pid;
    this._input = input;
    if (listeners.onData) this.dataListeners.add(listeners.onData);
    if (listeners.onExit) this.exitListeners.add(listeners.onExit);
  }

  /** Original spawn input — handy for assertions. */
  get spawnInput(): PtySpawnInput {
    return this._input;
  }

  write(data: string | Uint8Array): void {
    if (this.exited) return;
    this.writeLog.push(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.resizeLog.push({ cols, rows });
  }

  paused = false;

  pause(): void {
    if (!this.exited) this.paused = true;
  }

  resume(): void {
    if (!this.exited) this.paused = false;
  }

  kill(signal?: NodeJS.Signals | number): void {
    if (this.exited) return;
    this.killed = signal ?? "SIGTERM";
    // Synthesize an exit so subscribers detach cleanly — matches the
    // node-pty fallback inside NodePtyAdapter.
    this.emitExit({ exitCode: 0, signal: typeof signal === "number" ? signal : null });
  }

  onData(callback: (data: Buffer) => void): () => void {
    this.dataListeners.add(callback);
    return () => {
      this.dataListeners.delete(callback);
    };
  }

  onExit(callback: (event: PtyExitEvent) => void): () => void {
    if (this.exited) return () => undefined;
    this.exitListeners.add(callback);
    return () => {
      this.exitListeners.delete(callback);
    };
  }

  // ------------------------------------------------------------------
  // Test-only drivers — never called by production code.
  // ------------------------------------------------------------------

  /** Push synthetic PTY output bytes to every `onData` subscriber. */
  pushOutput(data: string | Uint8Array | Buffer): void {
    if (this.exited) return;
    const buf =
      data instanceof Buffer
        ? data
        : typeof data === "string"
          ? Buffer.from(data, "utf8")
          : Buffer.from(data);
    for (const listener of this.dataListeners) listener(buf);
  }

  /** Fire the terminal exit event (idempotent — subsequent calls are no-ops). */
  emitExit(event: PtyExitEvent): void {
    if (this.exited) return;
    this.exited = true;
    const listeners = [...this.exitListeners];
    this.dataListeners.clear();
    this.exitListeners.clear();
    for (const listener of listeners) listener(event);
  }

  /** Number of currently attached data listeners — handy for leak assertions. */
  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  /** Number of currently attached exit listeners. */
  get exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

export class MockPtyAdapter implements PtyAdapter {
  readonly id = "mock";
  readonly spawnLog: PtySpawnInput[] = [];
  readonly spawned: MockPtyProcess[] = [];
  private nextPid: number;
  private _failNext: MockPtyOptions["failNext"];
  private readonly syncUnsupported: boolean;

  constructor(options: MockPtyOptions = {}) {
    this.nextPid = options.startingPid ?? 100_000;
    this._failNext = options.failNext;
    this.syncUnsupported = options.syncUnsupported ?? false;
  }

  /** Arm the next spawn to throw a typed error. */
  failNext(code: PtySpawnError["code"], message: string): void {
    this._failNext = { code, message };
  }

  async spawn(input: PtySpawnInput, listeners?: PtySpawnListeners): Promise<PtyProcess> {
    if (this._failNext) {
      const err = this._failNext;
      this._failNext = undefined;
      throw new PtySpawnError({ adapter: this.id, code: err.code, message: err.message });
    }
    this.spawnLog.push(input);
    const proc = new MockPtyProcess(this.nextPid++, input, listeners);
    this.spawned.push(proc);
    return proc;
  }

  spawnSync(input: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess {
    if (this.syncUnsupported) {
      throw new PtySpawnError({
        adapter: this.id,
        code: "sync_unsupported",
        message: "MockPtyAdapter is configured with syncUnsupported=true",
      });
    }
    if (this._failNext) {
      const err = this._failNext;
      this._failNext = undefined;
      throw new PtySpawnError({ adapter: this.id, code: err.code, message: err.message });
    }
    this.spawnLog.push(input);
    const proc = new MockPtyProcess(this.nextPid++, input, listeners);
    this.spawned.push(proc);
    return proc;
  }

  /** Read-only view of all spawns so tests can assert wiring. */
  get spawnCount(): number {
    return this.spawnLog.length;
  }

  /** The most recently spawned mock process, or `null` if there were none. */
  lastSpawned(): MockPtyProcess | null {
    return this.spawned.at(-1) ?? null;
  }
}
