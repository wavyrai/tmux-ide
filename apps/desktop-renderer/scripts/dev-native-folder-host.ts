/**
 * Native folder selection for the local browser development host.
 *
 * The trusted Vite process owns both the chooser and the daemon mutation. The
 * renderer receives only WorkspaceOpenHostResult, so an absolute filesystem
 * path never enters browser JavaScript or a browser-authored request.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  WorkspaceOpenPreparedResultSchemaZ,
  type WorkspaceOpenPreparedHostResult,
} from "@tmux-ide/contracts";

function executeFile(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(executable, [...args], { encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolveOutput(stdout.trim());
    });
  });
}

function pickerWasCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  const detail = `${String(candidate.stderr ?? "")} ${String(candidate.message ?? "")}`;
  return candidate.code === 1 && /cancel(?:ed|led)|-128/iu.test(detail);
}

async function selectNativeProjectDirectory(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      return await executeFile("osascript", [
        "-e",
        'POSIX path of (choose folder with prompt "Open project in tmux-ide")',
      ]);
    }
    if (process.platform === "win32") {
      return await executeFile("powershell.exe", [
        "-NoProfile",
        "-STA",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; " +
          "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; " +
          "$dialog.Description = 'Open project in tmux-ide'; " +
          "if ($dialog.ShowDialog() -eq 'OK') { [Console]::Write($dialog.SelectedPath) }",
      ]);
    }
    return await executeFile("zenity", [
      "--file-selection",
      "--directory",
      "--title=Open project in tmux-ide",
    ]);
  } catch (error) {
    if (pickerWasCancelled(error)) return null;
    throw error;
  }
}

export interface DevelopmentProjectHostOptions {
  readonly daemonOrigin: string;
  readonly ownerToken: string;
  readonly hostClientId: string;
}

export interface DevelopmentProjectHostDependencies {
  readonly selectDirectory: () => Promise<string | null>;
  readonly request: typeof fetch;
  readonly createOperationId: () => string;
}

const defaults: DevelopmentProjectHostDependencies = {
  selectDirectory: selectNativeProjectDirectory,
  request: fetch,
  createOperationId: randomUUID,
};

const requestFailed = (reason: string): WorkspaceOpenPreparedHostResult => ({
  status: "error",
  error: { code: "request-failed", reason },
});

export async function openSelectedDevelopmentProject(
  options: DevelopmentProjectHostOptions,
  dependencies: Partial<DevelopmentProjectHostDependencies> = {},
): Promise<WorkspaceOpenPreparedHostResult | null> {
  const deps = { ...defaults, ...dependencies };
  const projectDir = await deps.selectDirectory();
  if (!projectDir) return null;

  const operationId = deps.createOperationId();
  const daemonResponse = await deps.request(
    `${options.daemonOrigin}/api/v2/action/workspace.open.prepare`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.ownerToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Host-Client-Id": options.hostClientId,
        "X-Tmux-Ide-Operation-Id": operationId,
      },
      body: JSON.stringify({ source: { kind: "project", projectDir } }),
    },
  );
  const payload = (await daemonResponse.json().catch(() => null)) as {
    readonly ok?: unknown;
    readonly result?: unknown;
  } | null;
  if (!daemonResponse.ok || payload?.ok !== true) {
    return requestFailed("The selected project could not be opened.");
  }
  const result = WorkspaceOpenPreparedResultSchemaZ.safeParse(payload.result);
  if (!result.success || result.data.operationId !== operationId) {
    return requestFailed("The daemon returned an invalid workspace-open result.");
  }
  return { status: "ok", result: result.data };
}
