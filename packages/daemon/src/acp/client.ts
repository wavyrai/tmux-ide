import { accessSync, constants } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

import {
  AcpAgentExitedError,
  AcpAgentSpawnError,
  AcpProtocolError,
  AcpRpcError,
} from "./errors.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./methods.ts";
import { makeJsonRpcEndpoint } from "./protocol.ts";
import {
  RequestPermissionRequestZ,
  SessionNotificationZ,
  type AgentProvider,
  type CancelNotification,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "./schema.ts";

export interface AcpClient {
  initialize(): Promise<InitializeResponse>;
  newSession(req: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse>;
  prompt(req: PromptRequest): Promise<PromptResponse>;
  cancel(notif: CancelNotification): Promise<void>;
  onSessionUpdate(handler: (n: SessionNotification) => void): () => void;
  onPermissionRequest(
    handler: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): () => void;
  close(): Promise<void>;
  readonly closed: Promise<{ code: number | null; signal: string | null }>;
}

export interface SpawnAcpClientOptions {
  provider: AgentProvider;
  cwd?: string;
  env?: Record<string, string>;
  logger?: (event: { direction: "in" | "out"; payload: unknown }) => void;
}

function resolveFromPath(binary: string): string | null {
  const paths = process.env.PATH?.split(":") ?? [];
  for (const dir of paths) {
    const candidate = `${dir}/${binary}`;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

function assertExecutable(binary: string): string {
  if (binary.includes("/")) {
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch (err) {
      throw new AcpAgentSpawnError(`ACP agent binary is not executable: ${binary}`, { cause: err });
    }
  }
  const resolved = resolveFromPath(binary);
  if (!resolved) throw new AcpAgentSpawnError(`ACP agent binary not found on PATH: ${binary}`);
  return resolved;
}

function resolveProvider(provider: AgentProvider): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  if (provider.kind === "custom") {
    return { command: provider.command, args: provider.args, env: provider.env };
  }
  if (provider.kind === "claude-code") {
    if (provider.binary) {
      return { command: assertExecutable(provider.binary), args: [] };
    }
    const direct = resolveFromPath("claude-code-acp");
    if (direct) return { command: direct, args: [] };
    const npx = resolveFromPath("npx");
    if (npx) {
      return { command: npx, args: ["-y", "@zed-industries/claude-code-acp"] };
    }
    throw new AcpAgentSpawnError(
      "ACP agent binary not found: install @zed-industries/claude-code-acp globally, or ensure `npx` is on PATH.",
    );
  }
  throw new AcpAgentSpawnError(`ACP provider is not implemented: ${provider.kind}`);
}

function writeStderrLines(
  child: ChildProcessWithoutNullStreams,
  logger?: (event: { direction: "in" | "out"; payload: unknown }) => void,
): void {
  let buffer = "";
  child.stderr.on("data", (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) logger?.({ direction: "in", payload: { _stderr: true, line } });
    }
  });
  child.stderr.on("close", () => {
    if (buffer) logger?.({ direction: "in", payload: { _stderr: true, line: buffer } });
  });
}

export async function spawnAcpClient(opts: SpawnAcpClientOptions): Promise<AcpClient> {
  const resolved = resolveProvider(opts.provider);
  const mergedEnv: Record<string, string | undefined> = {
    ...process.env,
    ...opts.env,
    ...resolved.env,
  };
  // Strip nested-session guards so spawning Claude Code from inside another
  // Claude Code session still works. Empty string is not enough — Claude
  // Code's check considers any truthy value as "set".
  if (opts.provider.kind === "claude-code") {
    delete mergedEnv.CLAUDECODE;
    delete mergedEnv.CLAUDE_CODE;
    delete mergedEnv.CLAUDE_CODE_ENTRYPOINT;
  }
  const child = spawn(resolved.command, resolved.args, {
    cwd: opts.cwd,
    env: mergedEnv as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const spawnFailure = await Promise.race([
    once(child, "spawn").then(() => null),
    once(child, "error").then(([err]) => err as Error),
    once(child, "exit").then(
      ([code, signal]) =>
        new AcpAgentExitedError("ACP agent exited during spawn", {
          code: code as number | null,
          signal: signal as string | null,
        }),
    ),
  ]);

  if (spawnFailure) {
    throw spawnFailure instanceof AcpAgentExitedError
      ? spawnFailure
      : new AcpAgentSpawnError(`Failed to spawn ACP agent: ${spawnFailure.message}`, {
          cause: spawnFailure,
        });
  }

  writeStderrLines(child, opts.logger);

  const endpoint = makeJsonRpcEndpoint({
    input: child.stdout,
    output: child.stdin,
    logger: opts.logger,
  });

  const sessionUpdateHandlers = new Set<(n: SessionNotification) => void>();
  let permissionHandler:
    | ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>)
    | null = null;

  endpoint.onNotification((notification) => {
    if (notification.method !== CLIENT_METHODS.session_update) return;
    const parsed = SessionNotificationZ.parse(notification.params);
    for (const handler of sessionUpdateHandlers) handler(parsed);
  });

  endpoint.onIncomingRequest(async (request) => {
    if (request.method !== CLIENT_METHODS.session_request_permission) {
      throw new AcpRpcError({ code: -32601, message: `Method not found: ${request.method}` });
    }
    if (!permissionHandler) throw new AcpProtocolError("No permission request handler registered");
    return await permissionHandler(RequestPermissionRequestZ.parse(request.params));
  });

  const closed = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as string | null,
  }));
  void closed.then(({ code, signal }) => {
    void endpoint.close(new AcpAgentExitedError("ACP agent exited", { code, signal }));
  });

  return {
    async initialize(): Promise<InitializeResponse> {
      return (await endpoint.request(AGENT_METHODS.initialize, {
        protocolVersion: 1,
        clientInfo: { name: "tmux-ide", version: "0.0.1" },
      })) as InitializeResponse;
    },
    async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
      return (await endpoint.request(AGENT_METHODS.session_new, req)) as NewSessionResponse;
    },
    async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
      return (await endpoint.request(AGENT_METHODS.session_load, req)) as LoadSessionResponse;
    },
    async prompt(req: PromptRequest): Promise<PromptResponse> {
      return (await endpoint.request(AGENT_METHODS.session_prompt, req)) as PromptResponse;
    },
    async cancel(notif: CancelNotification): Promise<void> {
      endpoint.notify(AGENT_METHODS.session_cancel, notif);
    },
    onSessionUpdate(handler: (n: SessionNotification) => void): () => void {
      sessionUpdateHandlers.add(handler);
      return () => sessionUpdateHandlers.delete(handler);
    },
    onPermissionRequest(
      handler: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
    ): () => void {
      permissionHandler = handler;
      return () => {
        if (permissionHandler === handler) permissionHandler = null;
      };
    },
    async close(): Promise<void> {
      if (!child.killed) child.kill("SIGTERM");
      await endpoint.close(new AcpAgentExitedError("ACP client closed"));
    },
    closed,
  };
}
