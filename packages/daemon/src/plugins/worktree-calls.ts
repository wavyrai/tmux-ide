/**
 * `ide.worktree.list|create|open|remove`: git worktrees and their sessions,
 * for plugins granted the `worktree` capability.
 *
 * The daemon runs its own `tmux-ide worktree … --json` (the same code and
 * gates as the CLI), outside the plugin sandbox, with arguments it checked:
 * a branch or ref that git would accept and cannot pass for an option, and
 * a session that exists, by exact name, on the daemon's tmux server. The
 * plugin never gets a program it could aim elsewhere. Sessions it opens are
 * plain: the worktree's own tmux-ide layout (commands from that branch)
 * never runs. `remove` never passes `--force`, so a worktree with changes
 * is refused; plugins mark actions that remove as dangerous so a person
 * confirms them.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";

export const WORKTREE_OPERATIONS = ["list", "create", "open", "remove"] as const;
export type WorktreeOperation = (typeof WORKTREE_OPERATIONS)[number];

/** A branch or ref: git-valid, and never something argv parsing reads as an option. */
const REF = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u, "must be letters, digits and . _ / - only")
  .refine(
    (ref) =>
      !ref.includes("..") &&
      !ref.includes("//") &&
      !ref.endsWith("/") &&
      !ref.endsWith(".") &&
      !ref.endsWith(".lock") &&
      !ref.split("/").some((part) => part.startsWith(".")),
    "is not a valid git branch name",
  );

/**
 * A tmux session name tmux reads literally: letters, digits, space and
 * `_ - @ + ,` only. Nothing tmux takes as a pattern (`* ? [`), a format
 * (`#{`), target syntax (`: . = ~ $ %`) or an option (a leading `-`).
 */
const SESSION = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\p{L}\p{N}_@+][\p{L}\p{N} _@+,-]*$/u, "is not a plain tmux session name");

const RequestSchemaZ = z
  .object({
    session: SESSION,
    branch: REF.optional(),
    from: REF.optional(),
  })
  .strict();

export interface WorktreeCallDependencies {
  /** Run tmux against the daemon's server and return stdout. */
  readonly tmux: (args: readonly string[]) => Promise<string>;
  /** Whether the calling plugin may still act; checked right before the CLI runs. */
  readonly stillActive?: () => boolean;
  /** Run the tmux-ide CLI with `args` and `env`; resolves with its exit and output. */
  readonly runCli: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

export class WorktreeCallError extends Error {}

function fail(message: string): never {
  throw new WorktreeCallError(message);
}

/** Check a request and run the worktree operation; resolves with tmux-ide's JSON answer. */
export async function worktreeCall(
  operation: unknown,
  raw: unknown,
  deps: WorktreeCallDependencies,
): Promise<unknown> {
  if (!WORKTREE_OPERATIONS.includes(operation as WorktreeOperation))
    fail("E_INVALID: ide.worktree supports list, create, open and remove");
  const op = operation as WorktreeOperation;
  const parsed = RequestSchemaZ.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(
      `E_INVALID: ide.worktree.${op} ${issue?.path.join(".") || "request"} ${issue?.message ?? "is invalid"}`,
    );
  }
  const { session, branch, from } = parsed.data;
  if (op !== "list" && !branch) fail(`E_INVALID: ide.worktree.${op} needs a branch`);
  if (from && op !== "create") fail(`E_INVALID: only ide.worktree.create takes from`);

  // The session must exist on the daemon's tmux server, by exact name
  // (`=name`; display-message alone answers even for an unknown session).
  // The CLI then talks to that same server (TMUX names its socket), finds
  // the repository from that session's directory, and fails rather than
  // fall back to its own directory.
  let where: string;
  try {
    await deps.tmux(["has-session", "-t", `=${session}`]);
    // "|" cannot be in a session name (see SESSION), so the first one splits.
    // (Not a tab: tmux prints control characters as "_" under LANG=C.)
    const line = (
      await deps.tmux([
        "display-message",
        "-p",
        "-t",
        `=${session}:`,
        "#{session_name}|#{socket_path},#{pid}",
      ])
    ).trim();
    const split = line.indexOf("|");
    const name = split < 0 ? line : line.slice(0, split);
    const socket = split < 0 ? "" : line.slice(split + 1);
    if (name !== session || !socket || !/^\/.+,\d+$/u.test(socket)) throw new Error("mismatch");
    where = socket;
  } catch {
    fail(`E_NOT_FOUND: no tmux session '${session}'`);
  }
  if (deps.stillActive && !deps.stillActive())
    fail("E_UNAVAILABLE: the plugin was stopped before this finished");

  const args = ["worktree", op];
  if (branch) args.push(branch);
  if (from) args.push("--from", from);
  // --plain: a plugin never starts the worktree's own layout, whose commands
  // come from that branch (which `from` may name).
  if (op === "create" || op === "open") args.push("--plain");
  // `=name:`: the exact session (a bare `=name` names no pane for tmux).
  args.push("--session", `=${session}:`, "--require-session", "--json");
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX: `${where},0` };
  delete env.TMUX_PANE;
  const result = await deps.runCli(args, env);
  if (result.code !== 0) {
    const message = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");
    fail(`E_FAILED: ${message || `tmux-ide worktree ${op} failed`}`.slice(0, 2000));
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    fail("E_FAILED: tmux-ide worktree sent an unexpected answer");
  }
}

const OUTPUT_CAP = 1024 * 1024;

/** Run `command` (the tmux-ide CLI argv prefix) with `args`, for up to `timeoutMs`. */
export function cliRunner(
  command: readonly string[],
  timeoutMs = 60_000,
): WorktreeCallDependencies["runCli"] {
  return (args, env) =>
    new Promise((resolve, reject) => {
      const [file, ...prefix] = command;
      const child = spawn(file!, [...prefix, ...args], {
        cwd: homedir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf8");
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(new WorktreeCallError(`E_UNAVAILABLE: could not run tmux-ide: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}
