/**
 * Run `tmux-ide init [--template <id>]` in a target directory and stream the
 * output line-by-line. Used by `POST /api/projects/init` so the dashboard can
 * scaffold new projects from the UI.
 *
 * The spawn helper is pluggable so tests can drive the runner without
 * actually shelling out.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The minimal contract of `child_process.spawn` we depend on. Tests pass in
 * a synthetic implementation that emits lines deterministically.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string },
) => ChildProcessWithoutNullStreams;

export interface InitRunnerOptions {
  template?: string;
  cwd: string;
  onChunk: (chunk: string) => void;
  /** Override for tests. */
  spawnFn?: SpawnFn;
  /** Defaults to 30s. */
  timeoutMs?: number;
  /** The binary to run. Defaults to `tmux-ide`; tests pin to a no-op. */
  command?: string;
}

export class ProjectInitTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`tmux-ide init timed out after ${timeoutMs}ms`);
    this.name = "ProjectInitTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ProjectInitFailedError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(exitCode: number | null, stderr: string) {
    super(`tmux-ide init exited with code ${exitCode ?? "(killed)"}: ${stderr || "no stderr"}`);
    this.name = "ProjectInitFailedError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Buffer stream chunks into newline-delimited lines, emit each line through
 * `onChunk`. Returns a `flush()` to drain any trailing partial line on close.
 */
function lineStreamer(onChunk: (chunk: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let pending = "";
  return {
    push(text: string): void {
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        onChunk(line);
        newline = pending.indexOf("\n");
      }
    },
    flush(): void {
      if (pending.length === 0) return;
      onChunk(pending.replace(/\r$/, ""));
      pending = "";
    },
  };
}

/**
 * Spawn `tmux-ide init` and resolve when it exits. Streams stdout+stderr
 * through `onChunk` line-by-line so callers can fan them out over WebSocket.
 *
 * Resolves with `{ ok: true }` on exit code 0, rejects with
 * `ProjectInitFailedError` (non-zero) or `ProjectInitTimeoutError` (>30s).
 */
export async function runInit(options: InitRunnerOptions): Promise<{ ok: true }> {
  const spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
  const command = options.command ?? "tmux-ide";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["init"];
  if (options.template) args.push("--template", options.template);

  const child = spawnFn(command, args, { cwd: options.cwd });
  const stderrStreamer = lineStreamer(options.onChunk);
  const stdoutStreamer = lineStreamer(options.onChunk);
  let stderrBuffer = "";

  child.stdout.setEncoding?.("utf-8");
  child.stderr.setEncoding?.("utf-8");

  child.stdout.on("data", (data: string | Buffer) => {
    stdoutStreamer.push(typeof data === "string" ? data : data.toString("utf-8"));
  });
  child.stderr.on("data", (data: string | Buffer) => {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    stderrBuffer += text;
    stderrStreamer.push(text);
  });

  return new Promise<{ ok: true }>((resolveResult, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStreamer.flush();
      stderrStreamer.flush();
      fn();
    };

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // child may already be gone
      }
      settle(() => reject(new ProjectInitTimeoutError(timeoutMs)));
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (err: Error) => {
      settle(() => reject(err));
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        settle(() => resolveResult({ ok: true }));
      } else {
        settle(() => reject(new ProjectInitFailedError(code, stderrBuffer.trim())));
      }
    });
  });
}
