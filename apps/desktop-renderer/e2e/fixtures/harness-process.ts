/**
 * Child-process discipline for the app-level suite.
 *
 * Every process this suite starts is started `detached`, which puts it in its
 * own process group, and is stopped by signalling that whole group. The daemon
 * spawns children of its own (tmux control-mode clients, the attachment
 * runtime); a plain `child.kill()` reaps the immediate child and orphans those.
 * An orphaned daemon child outliving its harness has already cost a real
 * support incident, so the group kill is the only shutdown path here.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface HarnessChild {
  readonly child: ChildProcess;
  /** Everything the child has written to stdout and stderr so far. */
  output: () => string;
  /** Signal the whole process group, escalating to SIGKILL after a grace period. */
  stop: () => Promise<void>;
}

export interface SpawnHarnessChildOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Signal a process GROUP, tolerating a group that has already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone, which is the state we wanted.
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

export function spawnHarnessChild(options: SpawnHarnessChildOptions): HarnessChild {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  // Without this an early spawn failure (ENOENT) becomes an unhandled error
  // event that tears down the whole worker instead of failing one test.
  child.on("error", (error) => (output += `\n[spawn error] ${error.message}`));

  const stop = async (): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    signalGroup(pid, "SIGTERM");
    const escalated = new Promise<void>((done) =>
      setTimeout(() => {
        signalGroup(pid, "SIGKILL");
        done();
      }, 3_000),
    );
    await Promise.race([exited, escalated.then(() => exited)]);
  };

  return { child, output: () => output, stop };
}

export interface PollOptions<T> {
  readonly probe: () => Promise<T | null | false | undefined>;
  /** Named in the timeout message: "timed out waiting for <detail>". */
  readonly detail: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
}

/** Poll until `probe` yields something truthy, or fail with a named timeout. */
export async function pollUntil<T>(options: PollOptions<T>): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await options.probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((done) => setTimeout(done, options.intervalMs ?? 150));
  }
  const because = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`timed out after ${options.timeoutMs}ms waiting for ${options.detail}${because}`);
}
