import { randomUUID } from "node:crypto";
import {
  createPinnedWorkspaceTmuxRunner,
  createPinnedWorkspaceTmuxAsyncRunner,
  type WorkspacePaneTmuxAuthority,
} from "./workspace-pane-creation.ts";
import { shellEscape } from "./shell.ts";

export interface NativeTmuxServerIdentity {
  readonly pid: string;
  readonly startTime: string;
}

/** Guard each command on the server which actually accepted this connection. */
export function fenceNativeTmuxCommand(
  args: readonly string[],
  expected: NativeTmuxServerIdentity,
) {
  const { pid, startTime } = expected;
  if (!/^[1-9][0-9]*$/u.test(pid) || !/^[1-9][0-9]*$/u.test(startTime))
    throw new Error("Invalid native tmux server identity");
  if (args.length === 0 || args.some((arg) => arg.includes("\0")))
    throw new Error("Invalid tmux command");
  const globalFlags: string[] = [];
  let firstCommand = 0;
  while (args[firstCommand]?.startsWith("-")) {
    const flag = args[firstCommand]!;
    if (flag !== "-N" && flag !== "-u")
      throw new Error("Unsupported tmux global option in generation-fenced command");
    globalFlags.push(flag);
    firstCommand += 1;
  }
  if (firstCommand === args.length) throw new Error("Missing tmux command");
  const condition = `#{&&:#{==:#{pid},${pid}},#{==:#{start_time},${startTime}}}`;
  // Preserve arbitrary literal payloads; a standalone ; is the native argv
  // command separator already used by the existing runners.
  const command = args
    .slice(firstCommand)
    .map((arg) => (arg === ";" ? ";" : shellEscape(arg)))
    .join(" ");
  const refusal = `tmux-server-stale.${randomUUID()}`;
  return {
    argv: [...globalFlags, "if-shell", "-F", condition, command, `display-message -p '${refusal}'`],
    verify(output: string): string {
      if (output.trimEnd() === refusal)
        throw new Error("Tmux server generation changed before command execution");
      return output;
    },
  };
}

/** Socket validation alone leaves a validation-to-connect replacement race. */
export function createServerGenerationFencedTmuxRunner(
  authority: WorkspacePaneTmuxAuthority,
  expected?: NativeTmuxServerIdentity,
): (args: readonly string[]) => string {
  const run = createPinnedWorkspaceTmuxRunner(authority, { timeoutMs: 5_000 });
  const [pid, startTime] = expected
    ? [expected.pid, expected.startTime]
    : run(["display-message", "-p", "#{pid}\t#{start_time}"]).split("\t");
  if (!pid || !startTime) throw new Error("Invalid native tmux server identity");
  const identity = { pid, startTime };
  // Validate once before publishing an owner; each command rechecks natively.
  fenceNativeTmuxCommand(["display-message", "-p", ""], identity);
  return (args) => {
    const command = fenceNativeTmuxCommand(args, identity);
    return command.verify(run(command.argv));
  };
}

export function createServerGenerationFencedTmuxAsyncRunner(
  authority: WorkspacePaneTmuxAuthority,
  expected: NativeTmuxServerIdentity,
): (args: readonly string[], signal?: AbortSignal) => Promise<string> {
  const run = createPinnedWorkspaceTmuxAsyncRunner(authority);
  fenceNativeTmuxCommand(["display-message", "-p", ""], expected);
  return async (args, signal) => {
    const command = fenceNativeTmuxCommand(args, expected);
    return command.verify(await run(command.argv, signal));
  };
}
