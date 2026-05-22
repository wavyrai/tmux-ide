import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { defaultNodePtyAdapter, NodePtyAdapter } from "../terminal/NodePtyAdapter.ts";
import type { PtyAdapter, PtyProcess, PtySpawnInput } from "../terminal/PtyAdapter.ts";

const DEFAULT_RING_BUFFER_BYTES = 256 * 1024;

/**
 * Test-only spawn signature that historic tests injected before T087
 * (see `options.pty?.spawn`). We keep it as a compat shim — anything more
 * intrusive (e.g. a full `pty.IPty` stub) should switch to
 * `options.ptyAdapter` (a `PtyAdapter` from `terminal/MockPtyAdapter.ts`).
 */
type LegacyPtySpawn = (
  shell: string,
  args: string[],
  opts: {
    name?: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
    encoding: null | "utf8";
  },
) => {
  pid: number;
  cols?: number;
  rows?: number;
  onData(cb: (data: unknown) => void): { dispose(): void };
  onExit(cb: (evt: { exitCode: number; signal?: number | null }) => void): { dispose(): void };
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals | string): void;
};

export interface PtyExit {
  code: number;
  signal: number | null;
}

export type TerminalCwdErrorReason = "notFound" | "notDirectory" | "statFailed";

/**
 * Typed error thrown when a requested terminal cwd cannot be used to
 * spawn a PTY. Carries the offending cwd and a discriminator so the
 * WebSocket layer can surface a structured error frame to the client.
 */
export class TerminalCwdError extends Error {
  readonly cwd: string;
  readonly reason: TerminalCwdErrorReason;

  constructor(args: { cwd: string; reason: TerminalCwdErrorReason; cause?: unknown }) {
    const message = TerminalCwdError.formatMessage(args.cwd, args.reason);
    super(message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "TerminalCwdError";
    this.cwd = args.cwd;
    this.reason = args.reason;
  }

  private static formatMessage(cwd: string, reason: TerminalCwdErrorReason): string {
    switch (reason) {
      case "notFound":
        return `cwd does not exist: ${cwd}`;
      case "notDirectory":
        return `cwd is not a directory: ${cwd}`;
      case "statFailed":
        return `cwd stat failed: ${cwd}`;
    }
  }
}

/**
 * Typed error thrown when caller-supplied PTY input is structurally
 * invalid (e.g. empty cwd for the project default terminal). Distinct
 * from {@link TerminalCwdError} which describes filesystem state.
 */
export class TerminalSpawnInputError extends Error {
  readonly field: string;

  constructor(args: { field: string; message: string }) {
    super(args.message);
    this.name = "TerminalSpawnInputError";
    this.field = args.field;
  }
}

export interface PtyBridgeOptions {
  id?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  name?: string;
  coalesceMs?: number;
  ringBufferBytes?: number;
  /**
   * Inject a `PtyAdapter` (T087). When omitted, the bridge uses the
   * `defaultNodePtyAdapter`. Tests should pass a `MockPtyAdapter` from
   * `terminal/__tests__/MockPtyAdapter.ts` so no native PTY is spawned.
   */
  ptyAdapter?: PtyAdapter;
  /**
   * Legacy injection point retained for back-compat with pre-T087 tests
   * that hand-roll a `pty.spawn` stub. The bridge wraps the supplied
   * function in an internal `NodePtyAdapter` so the rest of the code path
   * stays uniform. New tests should prefer `ptyAdapter`.
   */
  pty?: {
    spawn: LegacyPtySpawn;
  };
  /**
   * Override for cwd validation. Defaults to a real `fs.statSync` check.
   * Tests inject a stub to exercise the typed-error branches without
   * touching the filesystem.
   */
  statCwd?: (cwd: string) => fs.Stats;
}

export interface PtySpawnOptions {
  cwd?: string;
  cmd?: string[];
}

/**
 * Validate that the supplied cwd exists and is a directory. Throws a
 * {@link TerminalCwdError} with a typed reason on any failure so the
 * caller can surface a structured error frame instead of leaking
 * stringly-typed errno checks.
 */
export function assertValidCwd(
  cwd: string,
  statCwd: (cwd: string) => fs.Stats = fs.statSync,
): void {
  let stats: fs.Stats;
  try {
    stats = statCwd(cwd);
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (errno === "ENOENT") {
      throw new TerminalCwdError({ cwd, reason: "notFound", cause: err });
    }
    throw new TerminalCwdError({ cwd, reason: "statFailed", cause: err });
  }
  if (!stats.isDirectory()) {
    throw new TerminalCwdError({ cwd, reason: "notDirectory" });
  }
}

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function outputToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data), "utf8");
}

function assertPositiveDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class PtyBridge extends EventEmitter {
  private ptyProcess: PtyProcess | null = null;
  private dataDispose: (() => void) | null = null;
  private exitDispose: (() => void) | null = null;
  private exitPoll: ReturnType<typeof setInterval> | null = null;
  private outputTimer: ReturnType<typeof setTimeout> | null = null;
  private outputChunks: Buffer[] = [];
  private pausedOutputChunks: Buffer[] = [];
  private outputPaused = false;
  private replayChunks: Buffer[] = [];
  private replayBytes = 0;
  private lastCwd: string | null = null;
  private readonly options: PtyBridgeOptions;
  private readonly adapter: PtyAdapter;
  private readonly ringBufferBytes: number;
  private readonly statCwd: (cwd: string) => fs.Stats;

  constructor(options: PtyBridgeOptions = {}) {
    super();
    this.options = options;
    // Resolution order (per T087):
    //   1. explicit `ptyAdapter` (preferred — pass a MockPtyAdapter in tests)
    //   2. legacy `options.pty?.spawn` (wraps the hand-rolled stub in a
    //      NodePtyAdapter so pre-T087 tests still work)
    //   3. defaultNodePtyAdapter — the production singleton.
    if (options.ptyAdapter) {
      this.adapter = options.ptyAdapter;
    } else if (options.pty?.spawn) {
      this.adapter = new NodePtyAdapter({
        spawnPty: options.pty.spawn as unknown as NodePtyAdapter["spawnPty"],
        statCwd: options.statCwd,
        skipHelperEnsure: true,
      });
    } else {
      this.adapter = defaultNodePtyAdapter;
    }
    this.ringBufferBytes =
      options.ringBufferBytes ??
      readPositiveIntEnv("TMUX_IDE_PTY_RING_BUFFER_BYTES", DEFAULT_RING_BUFFER_BYTES);
    this.statCwd = options.statCwd ?? fs.statSync;
  }

  /**
   * Returns the cwd used by the most recent spawn (or restart). `null`
   * if the bridge has never been spawned. Used by ws-route to detect
   * stale-cwd reuse and trigger a respawn.
   */
  getCwd(): string | null {
    return this.lastCwd;
  }

  get pid(): number | null {
    return this.ptyProcess?.pid ?? null;
  }

  // `cols`/`rows` aren't on the canonical PtyProcess shape — we mirror the
  // most recent value the bridge handed to the adapter so external readers
  // (status views) can still see the size without rummaging in the child.
  private lastCols: number | null = null;
  private lastRows: number | null = null;
  get cols(): number | null {
    return this.lastCols;
  }
  get rows(): number | null {
    return this.lastRows;
  }

  get running(): boolean {
    return this.ptyProcess !== null;
  }

  getReplayBuffer(): Buffer {
    return Buffer.concat(this.replayChunks, this.replayBytes);
  }

  flushReplayBuffer(): void {
    this.replayChunks = [];
    this.replayBytes = 0;
  }

  spawn(cols: number, rows: number, spawnOptions: PtySpawnOptions = {}): void {
    if (this.running) {
      throw new Error("PTY already spawned");
    }

    assertPositiveDimension("cols", cols);
    assertPositiveDimension("rows", rows);

    // When the client doesn't specify cmd, fall back to the user's actual
    // login shell from $SHELL so .zshrc / .zprofile / etc. load. Defaulting
    // to "bash" silently downgrades zsh users to a non-zsh experience.
    const defaultShell = this.options.shell ?? process.env.SHELL ?? "bash";
    let executable = spawnOptions.cmd?.[0] ?? defaultShell;
    let args = spawnOptions.cmd ? spawnOptions.cmd.slice(1) : (this.options.args ?? ["-l"]);

    // `__login_shell__` sentinel: wrap the rest of cmd in `$SHELL -l -c
    // "exec <cmd...>"`. The user's login shell sources profile/rc files
    // (PATH, nvm, brew, …) before exec'ing the requested command, so the
    // spawned program inherits the fully-loaded env. Used by the dashboard
    // to give tmux-ide the user's real shell environment.
    if (executable === "__login_shell__" && args.length > 0) {
      const innerCmd = args.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
      executable = defaultShell;
      args = ["-l", "-c", `exec ${innerCmd}`];
    }
    const cwd = spawnOptions.cwd ?? this.options.cwd ?? process.env.HOME ?? "/";
    assertValidCwd(cwd, this.statCwd);
    const env = this.options.env ?? cleanEnv();

    const spawnInput: PtySpawnInput = {
      shell: executable,
      args,
      cwd,
      cols,
      rows,
      env: env as NodeJS.ProcessEnv,
      name: this.options.name ?? "xterm-256color",
      encoding: null,
    };

    let child: PtyProcess;
    try {
      child = this.adapter.spawnSync(spawnInput);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && executable === "tmux-ide") {
        throw new Error("tmux-ide not found in PATH", { cause: err });
      }
      throw err;
    }

    this.ptyProcess = child;
    this.lastCwd = cwd;
    this.lastCols = cols;
    this.lastRows = rows;
    this.exitDispose = child.onExit(({ exitCode, signal }) => {
      this.emitExit({ code: exitCode, signal: signal ?? null });
    });
    this.dataDispose = child.onData((data) => {
      this.enqueueOutput(outputToBuffer(data));
    });
    this.startExitPoll(child);
  }

  /**
   * Stop the currently-running PTY process synchronously. Drops listeners
   * and clears replay so a follow-up spawn starts from a clean slate.
   * Idempotent — no-op when no process is running.
   *
   * Used by {@link restartWith} to swap out a sticky bridge whose cwd no
   * longer matches the client request.
   */
  stopProcess(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.ptyProcess) return;
    const child = this.ptyProcess;
    // Drop listeners first so the impending kill does not re-emit `exit`
    // to the WS client (which would close the socket mid-restart).
    this.disposeListeners();
    this.ptyProcess = null;
    this.lastCwd = null;
    this.flushReplayBuffer();
    try {
      child.kill(signal);
    } catch {
      // Process may have already exited between the running check and
      // the kill syscall.
    }
  }

  /**
   * Stop the running process (if any) and spawn a new one with the
   * supplied options. Preserves bridge identity (id, registry slot) but
   * resets the replay buffer — the prior process is gone, there is no
   * meaningful output to replay. Used when a reconnect requests a new
   * cwd; modeled on t3code's `stopProcess + spawn` pattern.
   */
  restartWith(cols: number, rows: number, spawnOptions: PtySpawnOptions = {}): void {
    this.stopProcess("SIGTERM");
    this.spawn(cols, rows, spawnOptions);
  }

  pause(): void {
    this.outputPaused = true;
  }

  resume(): void {
    if (!this.outputPaused) return;
    this.flushCoalescedOutput();
    this.outputPaused = false;
    this.flushPausedOutput();
  }

  write(bytes: Buffer | Uint8Array | string): void {
    if (!this.ptyProcess) {
      throw new Error("PTY is not running");
    }
    this.ptyProcess.write(typeof bytes === "string" ? bytes : Buffer.from(bytes));
  }

  resize(cols: number, rows: number): void {
    assertPositiveDimension("cols", cols);
    assertPositiveDimension("rows", rows);

    if (!this.ptyProcess) {
      throw new Error("PTY is not running");
    }

    this.ptyProcess.resize(cols, rows);
    this.lastCols = cols;
    this.lastRows = rows;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.ptyProcess) return;
    try {
      this.ptyProcess.kill(signal);
    } catch {
      // The process may already have exited between the running check and kill.
    }
  }

  dispose(): void {
    this.disposeListeners();
    this.kill("SIGTERM");
    this.flushReplayBuffer();
  }

  private disposeListeners(): void {
    this.flushAllOutput();
    this.dataDispose?.();
    this.exitDispose?.();
    if (this.exitPoll) {
      clearInterval(this.exitPoll);
      this.exitPoll = null;
    }
    this.dataDispose = null;
    this.exitDispose = null;
  }

  private enqueueOutput(bytes: Buffer): void {
    if (bytes.byteLength === 0) return;

    const coalesceMs = this.options.coalesceMs ?? 8;
    if (coalesceMs <= 0) {
      this.deliverOutput(bytes);
      return;
    }

    this.outputChunks.push(bytes);
    if (this.outputTimer) return;

    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      this.flushCoalescedOutput();
    }, coalesceMs);
    this.outputTimer.unref?.();
  }

  private flushCoalescedOutput(): void {
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
    if (this.outputChunks.length === 0) return;

    const chunks = this.outputChunks;
    this.outputChunks = [];
    this.deliverOutput(Buffer.concat(chunks));
  }

  private deliverOutput(bytes: Buffer): void {
    this.appendReplay(bytes);
    if (this.outputPaused) {
      this.pausedOutputChunks.push(bytes);
      return;
    }
    this.emit("output", bytes);
  }

  private flushPausedOutput(): void {
    if (this.pausedOutputChunks.length === 0) return;

    const chunks = this.pausedOutputChunks;
    this.pausedOutputChunks = [];
    this.emit("output", Buffer.concat(chunks));
  }

  private flushAllOutput(): void {
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }

    if (this.outputChunks.length > 0) this.appendReplay(Buffer.concat(this.outputChunks));
    const chunks = [...this.pausedOutputChunks, ...this.outputChunks];
    this.pausedOutputChunks = [];
    this.outputChunks = [];
    if (chunks.length > 0) {
      const bytes = Buffer.concat(chunks);
      this.emit("output", bytes);
    }
  }

  private appendReplay(bytes: Buffer): void {
    if (this.ringBufferBytes <= 0 || bytes.byteLength === 0) return;

    if (bytes.byteLength >= this.ringBufferBytes) {
      const tail = bytes.subarray(bytes.byteLength - this.ringBufferBytes);
      this.replayChunks = [Buffer.from(tail)];
      this.replayBytes = tail.byteLength;
      return;
    }

    this.replayChunks.push(Buffer.from(bytes));
    this.replayBytes += bytes.byteLength;

    while (this.replayBytes > this.ringBufferBytes && this.replayChunks.length > 0) {
      const first = this.replayChunks[0]!;
      const overflow = this.replayBytes - this.ringBufferBytes;
      if (first.byteLength <= overflow) {
        this.replayChunks.shift();
        this.replayBytes -= first.byteLength;
      } else {
        this.replayChunks[0] = first.subarray(overflow);
        this.replayBytes -= overflow;
      }
    }
  }

  private startExitPoll(child: PtyProcess): void {
    this.exitPoll = setInterval(() => {
      if (this.ptyProcess !== child) {
        this.disposeListeners();
        return;
      }

      try {
        process.kill(child.pid, 0);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          this.emitExit({ code: 0, signal: null });
        }
      }
    }, 100);
    this.exitPoll.unref?.();
  }

  private emitExit(exit: PtyExit): void {
    if (!this.ptyProcess) return;
    this.flushAllOutput();
    this.disposeListeners();
    this.ptyProcess = null;
    this.lastCwd = null;
    this.flushReplayBuffer();
    this.emit("exit", exit);
  }
}
