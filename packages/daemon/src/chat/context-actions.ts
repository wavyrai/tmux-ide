import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActionInput, ActionResult } from "../command-center/actions/contract.ts";
import { ActionError } from "../command-center/actions/errors.ts";

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileFn = (
  file: string,
  args: string[],
  options: { encoding: "utf8"; maxBuffer: number },
) => Promise<ExecFileResult>;

export interface ChatContextActionDeps {
  execFile?: ExecFileFn;
  now?: () => Date;
}

const execFileAsync = promisify(execFile) as ExecFileFn;
const CAPTURE_MAX_BUFFER = 10 * 1024 * 1024;

function badRequest(message: string, details?: unknown): ActionError {
  return new ActionError({ code: "bad_request", message, details });
}

async function tmux(
  args: string[],
  deps: ChatContextActionDeps,
  input: ActionInput<"chat.context.captureTerminal">,
): Promise<string> {
  const exec = deps.execFile ?? execFileAsync;
  try {
    const result = await exec("tmux", args, {
      encoding: "utf8",
      maxBuffer: CAPTURE_MAX_BUFFER,
    });
    return result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw badRequest(`Unable to capture tmux pane "${input.paneId}"`, {
      sessionName: input.sessionName,
      paneId: input.paneId,
      reason: message,
    });
  }
}

export async function chatContextCaptureTerminalHandler(
  input: ActionInput<"chat.context.captureTerminal">,
  deps: ChatContextActionDeps = {},
): Promise<ActionResult<"chat.context.captureTerminal">> {
  const target = `${input.sessionName}:${input.paneId}`;
  const title = (
    await tmux(["display-message", "-p", "-t", target, "#{pane_title}"], deps, input)
  ).trim();
  const content = await tmux(
    ["capture-pane", "-t", target, "-p", "-e", "-S", "-5000"],
    deps,
    input,
  );

  return {
    pane: { id: input.paneId, title: title || input.paneId },
    content,
    capturedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
}
