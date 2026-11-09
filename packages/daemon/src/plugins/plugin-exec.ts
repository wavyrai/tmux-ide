/**
 * `ide.exec`: a plugin runs a program, on the daemon's side of the wire.
 *
 * - Only programs the plugin's manifest lists under `capabilities.exec`, and
 *   that the owner consented to. A bare program name, looked up on the
 *   daemon's own PATH (absolute entries only), never on one the plugin sets.
 * - No shell unless the plugin asks for `shell = true`, which needs the
 *   manifest's `capabilities.shell` (shown at consent as "any command").
 * - A minimal environment, never the daemon's; a plugin may add only
 *   locale, terminal and colour variables and its own `PLUGIN_*` ones, so it
 *   cannot change PATH or inject a library (DYLD_*, LD_*) or interpreter
 *   option (NODE_OPTIONS, PYTHONPATH, GIT_*, …).
 * - With `context = "%N"` the program runs as if typed in that tmux pane
 *   (its cwd, TMUX and TMUX_PANE); that needs the `panes.send` capability.
 * - Inside the OS sandbox (exec-sandbox.ts), with a timeout that kills the
 *   whole process group, capped at the callback's wall clock, and a cap on
 *   captured output. The daemon also kills a plugin's programs when the
 *   plugin fails, unloads, is disabled or loses consent.
 * - Output is redacted before it goes back to Lua.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { redactText } from "../lib/log-sanitize.ts";
import { findOnPath, sandboxedArgv, type SandboxPlan, type SandboxPaths } from "./exec-sandbox.ts";
import { ensureRealDirectory } from "./safe-files.ts";

export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
export const EXEC_OUTPUT_CAP_BYTES = 1024 * 1024;

const PROGRAM_NAME = /^[\w.+-]{1,64}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/**
 * The variables a plugin may set for a program it runs. Everything else
 * could change what runs (PATH, DYLD_INSERT_LIBRARIES, LD_PRELOAD,
 * NODE_OPTIONS, PYTHONPATH, GIT_SSH_COMMAND, BASH_ENV, …) and is refused.
 */
const ALLOWED_ENV =
  /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|COLUMNS|LINES|PLUGIN_[A-Z0-9_]+)$/u;

export const ExecRequestSchemaZ = z
  .object({
    cmd: z
      .string()
      .min(1)
      .max(64 * 1024),
    args: z
      .array(z.string().max(64 * 1024))
      .max(256)
      .default([]),
    cwd: z.string().min(1).max(4096).optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string().max(64 * 1024)).optional(),
    stdin: z
      .string()
      .max(1024 * 1024)
      .optional(),
    timeout_ms: z.number().int().min(1).max(EXEC_MAX_TIMEOUT_MS).optional(),
    /** A tmux pane id like `%12`: run as if typed there. */
    context: z
      .string()
      .regex(
        /^%\d{1,9}$/u,
        "must be a tmux pane id like %3; ctx.pane is set only when the caller knows one",
      )
      .optional(),
    shell: z.boolean().optional(),
  })
  .strict();
export type ExecRequest = z.infer<typeof ExecRequestSchemaZ>;

export interface ExecResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
  readonly truncated: boolean;
}

export interface ExecPolicy {
  /** Program names the plugin may run, or "any" (init.lua and `lua run`). */
  readonly programs: readonly string[] | "any";
  readonly shell: boolean;
  /** May run a program as if typed in a pane (`context`): `panes.send`. */
  readonly panes: boolean;
}

export interface PaneContext {
  /** Value for $TMUX: `<socket>,<server pid>,<session index>`. */
  readonly tmux: string;
  readonly pane: string;
  readonly cwd: string;
}

export interface ExecDependencies {
  readonly policy: ExecPolicy;
  readonly sandbox: SandboxPaths;
  /** The environment programs start from (already minimal). */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly resolvePane: (pane: string) => Promise<PaneContext | null>;
  readonly secrets: () => ReadonlySet<string>;
  readonly plan?: (command: readonly string[], paths: SandboxPaths) => SandboxPlan;
  readonly spawn?: typeof nodeSpawn;
  /** The longest a program may run: the callback's wall clock. */
  readonly maxTimeoutMs?: number;
  /**
   * Asked right before the program starts, after every await: false when
   * the plugin was disabled, unloaded or revoked meanwhile.
   */
  readonly stillAllowed?: () => boolean;
  /** Told about each started program; returns the call that forgets it. */
  readonly track?: (child: ChildProcess) => () => void;
}

export class ExecError extends Error {}

function fail(message: string): never {
  throw new ExecError(message);
}

/** Validate the request and work out the argv, cwd and environment. */
export async function prepareExec(raw: unknown, deps: ExecDependencies) {
  const parsed = ExecRequestSchemaZ.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      `E_INVALID: ide.exec ${issue?.path.join(".") || "request"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const request = parsed.data;
  const env: NodeJS.ProcessEnv = { ...deps.baseEnv };
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!ALLOWED_ENV.test(key))
      fail(
        `E_DENIED: ide.exec may not set ${key}; plugins may set LANG, LC_*, TZ, TERM, colour variables, COLUMNS, LINES and PLUGIN_*`,
      );
    env[key] = value;
  }

  let command: string[];
  if (request.shell) {
    if (!deps.policy.shell)
      fail("E_DENIED: this plugin may not run shell commands (manifest capability 'shell')");
    command = ["/bin/sh", "-c", request.cmd, "sh", ...request.args];
  } else {
    if (!PROGRAM_NAME.test(request.cmd))
      fail("E_INVALID: ide.exec cmd must be a program name like 'git', not a path or command line");
    if (deps.policy.programs !== "any" && !deps.policy.programs.includes(request.cmd))
      fail(`E_DENIED: this plugin may not run '${request.cmd}' (manifest capability 'exec')`);
    // The daemon's PATH, never one from the request.
    const resolved = findOnPath(request.cmd, deps.baseEnv.PATH ?? "");
    if (!resolved) fail(`E_NOT_FOUND: '${request.cmd}' is not on PATH`);
    command = [resolved, ...request.args];
  }

  let cwd = env.HOME ?? "/";
  if (request.context) {
    if (!deps.policy.panes)
      fail(
        "E_DENIED: running a program in a pane (context) needs the manifest capability 'panes.send'",
      );
    const pane = await deps.resolvePane(request.context);
    if (!pane) fail(`E_NOT_FOUND: no tmux pane ${request.context}`);
    env.TMUX = pane.tmux;
    env.TMUX_PANE = pane.pane;
    cwd = pane.cwd;
  }
  if (request.cwd !== undefined) {
    if (!isAbsolute(request.cwd)) fail("E_INVALID: ide.exec cwd must be an absolute path");
    cwd = request.cwd;
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    fail(`E_NOT_FOUND: ide.exec cwd ${cwd} is not a directory`);

  try {
    ensureRealDirectory(deps.sandbox.writable);
  } catch (error) {
    fail(`E_UNAVAILABLE: the plugin's data directory is unusable: ${(error as Error).message}`);
  }
  const plan = (deps.plan ?? sandboxedArgv)(command, deps.sandbox);
  if (!plan.ok) fail(`E_UNAVAILABLE: ${plan.reason}`);
  return {
    argv: plan.argv,
    cwd,
    env,
    stdin: request.stdin,
    timeoutMs: Math.min(
      request.timeout_ms ?? EXEC_DEFAULT_TIMEOUT_MS,
      deps.maxTimeoutMs ?? EXEC_MAX_TIMEOUT_MS,
    ),
  };
}

class Capture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;
  add(chunk: Buffer): void {
    const room = EXEC_OUTPUT_CAP_BYTES - this.#bytes;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (kept.length < chunk.length) this.truncated = true;
    this.#chunks.push(kept);
    this.#bytes += kept.length;
  }
  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

/** Kill `child` and everything it started (it leads its own process group). */
export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export async function runPluginExec(raw: unknown, deps: ExecDependencies): Promise<ExecResult> {
  const prepared = await prepareExec(raw, deps);
  if (deps.stillAllowed && !deps.stillAllowed())
    throw new ExecError("E_UNAVAILABLE: the plugin was stopped before its program started");
  const spawn = deps.spawn ?? nodeSpawn;
  const [file, ...args] = prepared.argv;
  return new Promise<ExecResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file!, args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Its own process group, so a timeout kills everything it started.
        detached: true,
      });
    } catch (error) {
      reject(
        new ExecError(`E_UNAVAILABLE: could not start the program: ${(error as Error).message}`),
      );
      return;
    }
    const forget = deps.track?.(child) ?? (() => {});
    const stdout = new Capture();
    const stderr = new Capture();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, prepared.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.stdin?.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      forget();
      reject(new ExecError(`E_UNAVAILABLE: could not start the program: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      forget();
      const secrets = deps.secrets();
      resolve({
        code,
        signal,
        stdout: redactText(stdout.text(), secrets),
        stderr: redactText(stderr.text(), secrets),
        timed_out: timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
    child.stdin?.end(prepared.stdin ?? "");
  });
}

/** Programs plugins started and that still run, by plugin. */
export class PluginPrograms {
  readonly #byPlugin = new Map<string, Map<ChildProcess, string | undefined>>();

  /**
   * Remember `child` as `plugin`'s, started for request `origin` (or by a
   * timer or load when there is none); returns the call that forgets it.
   */
  track(plugin: string, child: ChildProcess, origin?: string): () => void {
    let running = this.#byPlugin.get(plugin);
    if (!running) this.#byPlugin.set(plugin, (running = new Map()));
    running.set(child, origin);
    return () => {
      running.delete(child);
      if (running.size === 0 && this.#byPlugin.get(plugin) === running)
        this.#byPlugin.delete(plugin);
    };
  }

  /**
   * Kill `plugin`'s programs, or every plugin's; with `origin`, only the ones
   * started for that request. Returns how many.
   */
  kill(plugin?: string, origin?: string): number {
    const groups =
      plugin === undefined ? [...this.#byPlugin.values()] : [this.#byPlugin.get(plugin)];
    let killed = 0;
    for (const running of groups) {
      for (const [child, started] of running ?? []) {
        if (origin !== undefined && started !== origin) continue;
        killGroup(child);
        killed += 1;
      }
    }
    return killed;
  }

  running(plugin: string): number {
    return this.#byPlugin.get(plugin)?.size ?? 0;
  }
}
