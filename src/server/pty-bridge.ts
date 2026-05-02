import { EventEmitter } from "node:events";
import * as pty from "node-pty";

export interface PtyExit {
  code: number;
  signal: number | null;
}

export interface PtyBridgeOptions {
  id?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  name?: string;
  pty?: {
    spawn: typeof pty.spawn;
  };
}

export interface PtySpawnOptions {
  cwd?: string;
  cmd?: string[];
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

export class PtyBridge extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private dataDisposable: pty.IDisposable | null = null;
  private exitDisposable: pty.IDisposable | null = null;
  private exitPoll: ReturnType<typeof setInterval> | null = null;
  private readonly options: PtyBridgeOptions;
  private readonly ptySpawn: typeof pty.spawn;

  constructor(options: PtyBridgeOptions = {}) {
    super();
    this.options = options;
    this.ptySpawn = options.pty?.spawn ?? pty.spawn;
  }

  get pid(): number | null {
    return this.ptyProcess?.pid ?? null;
  }

  get cols(): number | null {
    return this.ptyProcess?.cols ?? null;
  }

  get rows(): number | null {
    return this.ptyProcess?.rows ?? null;
  }

  get running(): boolean {
    return this.ptyProcess !== null;
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
    const executable = spawnOptions.cmd?.[0] ?? defaultShell;
    const args = spawnOptions.cmd ? spawnOptions.cmd.slice(1) : (this.options.args ?? ["-l"]);
    const cwd = spawnOptions.cwd ?? this.options.cwd ?? process.env.HOME ?? "/";
    const env = this.options.env ?? cleanEnv();

    let child: pty.IPty;
    try {
      child = this.ptySpawn(executable, args, {
        name: this.options.name ?? "xterm-256color",
        cols,
        rows,
        cwd,
        env,
        encoding: null,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && executable === "tmux-ide") {
        throw new Error("tmux-ide not found in PATH", { cause: err });
      }
      throw err;
    }

    this.ptyProcess = child;
    this.exitDisposable = child.onExit(({ exitCode, signal }) => {
      this.emitExit({ code: exitCode, signal: signal ?? null });
    });
    this.dataDisposable = child.onData((data: unknown) => {
      this.emit("output", outputToBuffer(data));
    });
    this.startExitPoll(child);
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
  }

  private disposeListeners(): void {
    this.dataDisposable?.dispose();
    this.exitDisposable?.dispose();
    if (this.exitPoll) {
      clearInterval(this.exitPoll);
      this.exitPoll = null;
    }
    this.dataDisposable = null;
    this.exitDisposable = null;
  }

  private startExitPoll(child: pty.IPty): void {
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
    this.disposeListeners();
    this.ptyProcess = null;
    this.emit("exit", exit);
  }
}
