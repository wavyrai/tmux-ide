import { hostname, networkInterfaces } from "node:os";
import { generateAuthToken } from "../../../lib/auth-token.ts";
import { readAppSettings, writeAppSettings, type AppSettings } from "../../../lib/app-settings.ts";
import type { ActionInput, ActionResult } from "../contract.ts";

export interface RemoteAccessRestartRequest {
  enabled: boolean;
  bindHostname: "0.0.0.0" | "127.0.0.1";
  token: string | null;
  port?: number;
}

export interface RemoteAccessRestartResult {
  port?: number;
  host?: string;
}

export interface AppSetRemoteAccessDeps {
  readSettings?: () => AppSettings;
  writeSettings?: (next: AppSettings) => void;
  generateToken?: () => string;
  restartDaemon?: (
    request: RemoteAccessRestartRequest,
  ) => Promise<RemoteAccessRestartResult> | RemoteAccessRestartResult;
  deferRestart?: (restart: () => void) => void;
  port?: number;
  host?: string;
}

let remoteAccessRestartBackend:
  | ((
      request: RemoteAccessRestartRequest,
    ) => Promise<RemoteAccessRestartResult> | RemoteAccessRestartResult)
  | null = null;

export function setRemoteAccessRestartBackend(
  backend:
    | ((
        request: RemoteAccessRestartRequest,
      ) => Promise<RemoteAccessRestartResult> | RemoteAccessRestartResult)
    | null,
): void {
  remoteAccessRestartBackend = backend;
}

function currentPort(deps: AppSetRemoteAccessDeps): number {
  const envPort = Number(process.env.TMUX_IDE_DAEMON_PORT);
  return deps.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 6060);
}

function primaryLanHost(): string {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return hostname();
}

function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function defaultDeferRestart(restart: () => void): void {
  setImmediate(restart);
}

export async function appSetRemoteAccessHandler(
  input: ActionInput<"app.setRemoteAccess">,
  deps: AppSetRemoteAccessDeps = {},
): Promise<ActionResult<"app.setRemoteAccess">> {
  const readSettings = deps.readSettings ?? readAppSettings;
  const writeSettings = deps.writeSettings ?? writeAppSettings;
  const nextEnabled = input.enabled;
  const current = readSettings();
  const token = nextEnabled
    ? (current.remoteAccess.token ?? (deps.generateToken ?? generateAuthToken)())
    : null;
  const next: AppSettings = {
    ...current,
    remoteAccess: { enabled: nextEnabled, token },
  };

  writeSettings(next);

  const port = currentPort(deps);
  const request: RemoteAccessRestartRequest = {
    enabled: nextEnabled,
    bindHostname: nextEnabled ? "0.0.0.0" : "127.0.0.1",
    token,
    port,
  };
  const restartDaemon = deps.restartDaemon ?? remoteAccessRestartBackend;
  if (restartDaemon) {
    (deps.deferRestart ?? defaultDeferRestart)(() => {
      void Promise.resolve(restartDaemon(request)).catch((err) => {
        console.error(
          `[actions] Failed to restart daemon for remote access: ${(err as Error).message ?? String(err)}`,
        );
      });
    });
  }

  if (!nextEnabled) {
    return { enabled: false, url: null, token: null, qrPayload: null };
  }

  const host = deps.host ?? primaryLanHost();
  const url = buildUrl(host, port);

  return {
    enabled: true,
    url,
    token,
    qrPayload: `${url}?token=${encodeURIComponent(token ?? "")}`,
  };
}
