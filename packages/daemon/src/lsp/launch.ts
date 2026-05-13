import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LaunchResult {
  process: ChildProcessWithoutNullStreams;
  command: string;
}

function resolveTypescriptLanguageServer(workspaceRoot: string): string {
  const local = join(
    workspaceRoot,
    "node_modules",
    ".bin",
    "typescript-language-server",
  );
  if (existsSync(local)) return local;
  return "typescript-language-server";
}

export function launchTypescriptLanguageServer(
  workspaceRoot: string,
): LaunchResult {
  const command = resolveTypescriptLanguageServer(workspaceRoot);
  const proc = spawn(command, ["--stdio"], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams;

  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("typescript-language-server stdio pipes unavailable");
  }
  return { process: proc, command };
}
