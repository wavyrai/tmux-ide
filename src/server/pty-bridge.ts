import { EventEmitter } from "node:events";
import {
  execFileSync,
  spawn as spawnProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  tmux?: Partial<TmuxPaneBridgeDeps>;
}

type TmuxExecFileSync = (cmd: string, args: string[], options?: object) => Buffer | string;
type TmuxSpawn = (cmd: string, args: string[], options?: object) => ChildProcessWithoutNullStreams;

export interface TmuxPaneBridgeDeps {
  execFileSync: TmuxExecFileSync;
  spawn: TmuxSpawn;
  mkdtempSync: typeof mkdtempSync;
  writeFileSync: typeof writeFileSync;
  rmSync: typeof rmSync;
  tmpdir: typeof tmpdir;
}

interface TmuxPaneTarget {
  session: string;
  paneId: string;
}

interface TmuxPipeState extends TmuxPaneTarget {
  tail: ChildProcessWithoutNullStreams;
  dir: string;
  file: string;
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

function parseTmuxPaneTarget(id: string | undefined): TmuxPaneTarget | null {
  const match = id?.match(/^([^:]+):(%\d+)$/);
  if (!match) return null;
  return { session: match[1]!, paneId: match[2]! };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class PtyBridge extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private dataDisposable: pty.IDisposable | null = null;
  private exitDisposable: pty.IDisposable | null = null;
  private exitPoll: ReturnType<typeof setInterval> | null = null;
  private tmuxPipe: TmuxPipeState | null = null;
  private tmuxExitPoll: ReturnType<typeof setInterval> | null = null;
  private tmuxCols: number | null = null;
  private tmuxRows: number | null = null;
  private readonly options: PtyBridgeOptions;
  private readonly tmuxDeps: TmuxPaneBridgeDeps;

  constructor(options: PtyBridgeOptions = {}) {
    super();
    this.options = options;
    this.tmuxDeps = {
      execFileSync: options.tmux?.execFileSync ?? execFileSync,
      spawn: options.tmux?.spawn ?? spawnProcess,
      mkdtempSync: options.tmux?.mkdtempSync ?? mkdtempSync,
      writeFileSync: options.tmux?.writeFileSync ?? writeFileSync,
      rmSync: options.tmux?.rmSync ?? rmSync,
      tmpdir: options.tmux?.tmpdir ?? tmpdir,
    };
  }

  get pid(): number | null {
    return this.ptyProcess?.pid ?? this.tmuxPipe?.tail.pid ?? null;
  }

  get cols(): number | null {
    return this.ptyProcess?.cols ?? this.tmuxCols;
  }

  get rows(): number | null {
    return this.ptyProcess?.rows ?? this.tmuxRows;
  }

  get running(): boolean {
    return this.ptyProcess !== null || this.tmuxPipe !== null;
  }

  spawn(cols: number, rows: number): void {
    if (this.running) {
      throw new Error("PTY already spawned");
    }

    assertPositiveDimension("cols", cols);
    assertPositiveDimension("rows", rows);

    const tmuxTarget = parseTmuxPaneTarget(this.options.id);
    if (tmuxTarget && this.tmuxSessionExists(tmuxTarget.session)) {
      this.spawnTmuxPane(tmuxTarget, cols, rows);
      return;
    }

    const shell = this.options.shell ?? process.env.SHELL ?? "/bin/bash";
    const args = this.options.args ?? ["-l"];
    const cwd = this.options.cwd ?? process.env.HOME ?? "/";
    const env = this.options.env ?? cleanEnv();

    const child = pty.spawn(shell, args, {
      name: this.options.name ?? "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: null,
    });

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
    if (this.tmuxPipe) {
      this.writeTmux(bytes);
      return;
    }

    if (!this.ptyProcess) {
      throw new Error("PTY is not running");
    }
    this.ptyProcess.write(typeof bytes === "string" ? bytes : Buffer.from(bytes));
  }

  resize(cols: number, rows: number): void {
    assertPositiveDimension("cols", cols);
    assertPositiveDimension("rows", rows);

    if (this.tmuxPipe) {
      this.resizeTmux(cols, rows);
      return;
    }

    if (!this.ptyProcess) {
      throw new Error("PTY is not running");
    }

    this.ptyProcess.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.tmuxPipe) {
      this.stopTmuxPipe();
      return;
    }

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

  private tmux(cmd: string, args: string[], options: object = {}): Buffer | string {
    return this.tmuxDeps.execFileSync(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  }

  private tmuxSessionExists(session: string): boolean {
    try {
      this.tmux("tmux", ["has-session", "-t", session], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private validateTmuxPane(target: TmuxPaneTarget): void {
    const output = this.tmux(
      "tmux",
      ["display-message", "-p", "-t", target.paneId, "#{session_name}\t#{pane_id}"],
      { encoding: "utf8" },
    )
      .toString()
      .trim();
    const [sessionName, paneId] = output.split("\t");
    if (sessionName !== target.session || paneId !== target.paneId) {
      throw new Error(`Pane ${target.paneId} not found in session ${target.session}`);
    }
  }

  private paneStillExists(): boolean {
    if (!this.tmuxPipe) return false;
    try {
      this.validateTmuxPane(this.tmuxPipe);
      return true;
    } catch {
      return false;
    }
  }

  private spawnTmuxPane(target: TmuxPaneTarget, cols: number, rows: number): void {
    this.validateTmuxPane(target);

    const dir = this.tmuxDeps.mkdtempSync(join(this.tmuxDeps.tmpdir(), "tmux-ide-pty-"));
    const file = join(dir, "pane.log");
    this.tmuxDeps.writeFileSync(file, "");

    const tail = this.tmuxDeps.spawn("tail", ["-n", "+1", "-F", file], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.tmuxPipe = { ...target, tail, dir, file };
    this.tmuxCols = cols;
    this.tmuxRows = rows;

    tail.stdout.on("data", (data: unknown) => {
      this.emit("output", outputToBuffer(data));
    });
    tail.stderr.on("data", () => {
      // tail diagnostics are not terminal output; the next pane poll handles disappearance.
    });
    tail.on("exit", () => {
      if (!this.tmuxPipe || this.tmuxPipe.tail !== tail) return;
      this.emitTmuxExit({ code: 0, signal: null });
    });

    this.tmux("tmux", ["pipe-pane", "-o", "-t", target.paneId, `cat >> ${shellQuote(file)}`]);
    this.captureTmuxPane(target.paneId);
    this.resizeTmux(cols, rows);
    this.startTmuxExitPoll();
  }

  private captureTmuxPane(paneId: string): void {
    try {
      const snapshot = this.tmux("tmux", ["capture-pane", "-p", "-e", "-t", paneId, "-S", "-200"], {
        encoding: "utf8",
      }).toString();
      if (snapshot.trim()) {
        this.emit("output", Buffer.from(`${snapshot}\r\n`, "utf8"));
      }
    } catch {
      // A failed initial capture should not prevent live pipe-pane streaming.
    }
  }

  private writeTmux(bytes: Buffer | Uint8Array | string): void {
    if (!this.tmuxPipe) throw new Error("PTY is not running");
    if (!this.paneStillExists()) {
      this.emitTmuxExit({ code: 0, signal: null });
      throw new Error(`Pane ${this.tmuxPipe?.paneId ?? "unknown"} ended`);
    }

    const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
    const parts = text.split(/(\r\n|\r|\n)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === "\r" || part === "\n" || part === "\r\n") {
        this.tmux("tmux", ["send-keys", "-t", this.tmuxPipe.paneId, "Enter"]);
      } else {
        this.tmux("tmux", ["send-keys", "-t", this.tmuxPipe.paneId, "-l", "--", part]);
      }
    }
  }

  private resizeTmux(cols: number, rows: number): void {
    if (!this.tmuxPipe) throw new Error("PTY is not running");
    if (!this.paneStillExists()) {
      this.emitTmuxExit({ code: 0, signal: null });
      throw new Error(`Pane ${this.tmuxPipe?.paneId ?? "unknown"} ended`);
    }
    this.tmuxCols = cols;
    this.tmuxRows = rows;
    try {
      this.tmux("tmux", [
        "resize-pane",
        "-t",
        this.tmuxPipe.paneId,
        "-x",
        String(cols),
        "-y",
        String(rows),
      ]);
    } catch {
      // tmux can reject exact pane sizes depending on the current window layout.
      // The browser terminal still remains attached; keep resize best-effort.
    }
  }

  private startTmuxExitPoll(): void {
    this.tmuxExitPoll = setInterval(() => {
      if (!this.tmuxPipe) {
        this.stopTmuxPoll();
        return;
      }
      if (!this.paneStillExists()) {
        this.emitTmuxExit({ code: 0, signal: null });
      }
    }, 1000);
    this.tmuxExitPoll.unref?.();
  }

  private stopTmuxPoll(): void {
    if (this.tmuxExitPoll) {
      clearInterval(this.tmuxExitPoll);
      this.tmuxExitPoll = null;
    }
  }

  private stopTmuxPipe(): void {
    const pipe = this.tmuxPipe;
    if (!pipe) return;

    this.stopTmuxPoll();
    try {
      this.tmux("tmux", ["pipe-pane", "-t", pipe.paneId]);
    } catch {
      // The pane may already be gone; cleanup below is still valid.
    }
    try {
      pipe.tail.kill("SIGTERM");
    } catch {
      // tail may have already exited.
    }
    try {
      this.tmuxDeps.rmSync(pipe.dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }

    this.tmuxPipe = null;
    this.tmuxCols = null;
    this.tmuxRows = null;
  }

  private emitTmuxExit(exit: PtyExit): void {
    if (!this.tmuxPipe) return;
    this.stopTmuxPipe();
    this.emit("exit", exit);
  }
}
