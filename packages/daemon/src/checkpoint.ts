import { resolve } from "node:path";
import { makeCheckpointEngine, CheckpointEngineError } from "./chat/checkpoint-engine.ts";

export interface CheckpointCommandOptions {
  sub: string | undefined;
  args: string[];
  json: boolean;
  workspaceDir?: string;
}

export interface CheckpointCommandResult {
  exitCode: number;
}

function fail(message: string, code: string, json: boolean): never {
  // Print directly and exit so the command works regardless of which CLI
  // entry point invoked us — bin/cli.ts and packages/daemon/src/cli.ts each
  // have their own IdeError class today, and the mission to merge them is
  // still in flight.
  if (json) {
    process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(1);
}

export async function checkpointCommand(opts: CheckpointCommandOptions): Promise<void> {
  const sub = opts.sub;
  if (!sub) {
    fail("Missing subcommand. Usage: tmux-ide checkpoint <list|revert> ...", "USAGE", opts.json);
  }
  const workspaceDir = resolve(opts.workspaceDir ?? ".");
  const engine = makeCheckpointEngine();

  switch (sub) {
    case "list": {
      const threadId = opts.args[0];
      if (!threadId) {
        fail("Missing thread id. Usage: tmux-ide checkpoint list <thread-id>", "USAGE", opts.json);
      }
      try {
        const rows = await engine.listForThread({ threadId, workspaceDir });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, threadId, checkpoints: rows }, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log(`No checkpoints found for thread "${threadId}".`);
          return;
        }
        for (const row of rows) {
          console.log(`${row.checkpointRef.slice(0, 12)}  ${row.refName}  turn=${row.turnId}`);
        }
      } catch (err) {
        reportFailure(err, "Failed to list checkpoints", opts.json);
      }
      return;
    }
    case "revert": {
      const ref = opts.args[0];
      if (!ref) {
        fail(
          "Missing checkpoint ref. Usage: tmux-ide checkpoint revert <ref-or-sha>",
          "USAGE",
          opts.json,
        );
      }
      try {
        await engine.revert({ checkpointRef: ref, workspaceDir });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, reverted: ref }, null, 2));
          return;
        }
        console.log(`Reverted workspace to ${ref}.`);
      } catch (err) {
        reportFailure(err, "Failed to revert checkpoint", opts.json);
      }
      return;
    }
    default:
      fail(
        `Unknown checkpoint subcommand: ${sub}. Expected "list" or "revert".`,
        "USAGE",
        opts.json,
      );
  }
}

function reportFailure(err: unknown, fallback: string, json: boolean): never {
  if (err instanceof CheckpointEngineError) {
    fail(err.message, err.code.toUpperCase(), json);
  }
  const message = err instanceof Error ? err.message : String(err);
  fail(`${fallback}: ${message}`, "CHECKPOINT_ERROR", json);
}
