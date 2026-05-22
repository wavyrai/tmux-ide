import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";

import {
  CodexAgentExitedError,
  CodexAgentSpawnError,
  CodexProtocolError,
  CodexRpcError,
} from "./errors.ts";
import { AGENT_METHODS, CLIENT_METHODS } from "./methods.ts";
import { makeJsonRpcEndpoint } from "./protocol.ts";
import {
  ApplyPatchApprovalRequestZ,
  ApplyPatchApprovalResponseZ,
  ChatgptAuthTokensRefreshRequestZ,
  ChatgptAuthTokensRefreshResponseZ,
  CodexAgentEventZ,
  defaultInitializeRequest,
  type ApplyPatchApprovalRequest,
  type ApplyPatchApprovalResponse,
  type ChatgptAuthTokensRefreshRequest,
  type ChatgptAuthTokensRefreshResponse,
  type CodexAgentEvent,
  type CodexInitializeResponse,
  type InterruptRequest,
  type NewConversationRequest,
  type NewConversationResponse,
  type SendUserMessageRequest,
  type SendUserMessageResponse,
} from "./schema.ts";

export interface CodexClient {
  initialize(): Promise<CodexInitializeResponse>;
  newConversation(req: NewConversationRequest): Promise<NewConversationResponse>;
  sendUserMessage(req: SendUserMessageRequest): Promise<SendUserMessageResponse>;
  interrupt(req: InterruptRequest): Promise<void>;
  onAgentEvent(handler: (event: CodexAgentEvent) => void): () => void;
  onApplyPatchApproval(
    handler: (req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>,
  ): () => void;
  onChatgptTokenRefresh(
    handler: (req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>,
  ): () => void;
  close(): Promise<void>;
  readonly closed: Promise<{ code: number | null; signal: string | null }>;
}

export interface SpawnCodexClientOptions {
  provider: { kind: "codex"; binary?: string };
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
      throw new CodexAgentSpawnError(`Codex binary is not executable: ${binary}`, { cause: err });
    }
  }
  const resolved = resolveFromPath(binary);
  if (!resolved) throw new CodexAgentSpawnError(`Codex binary not found on PATH: ${binary}`);
  return resolved;
}

function resolveProvider(provider: SpawnCodexClientOptions["provider"]): {
  command: string;
  args: string[];
} {
  if (provider.binary) return { command: assertExecutable(provider.binary), args: [] };
  // `codex app-server` starts the server over stdio. The `proxy` subcommand
  // is a CLIENT that connects to an existing server's Unix socket — using
  // it here would fail with "No such file or directory" since no server is
  // running.
  return { command: assertExecutable("codex"), args: ["app-server"] };
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

function isAgentEventMethod(method: string): boolean {
  return (
    method === CLIENT_METHODS.item_agent_message_delta ||
    method === CLIENT_METHODS.item_reasoning_summary_text_delta ||
    method === CLIENT_METHODS.item_reasoning_summary_part_added ||
    method === CLIENT_METHODS.item_reasoning_text_delta ||
    method === CLIENT_METHODS.turn_started ||
    method === CLIENT_METHODS.turn_completed ||
    method === CLIENT_METHODS.item_completed ||
    method === CLIENT_METHODS.error
  );
}

export async function spawnCodexClient(opts: SpawnCodexClientOptions): Promise<CodexClient> {
  const resolved = resolveProvider(opts.provider);
  const child = spawn(resolved.command, resolved.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const spawnFailure = await Promise.race([
    once(child, "spawn").then(() => null),
    once(child, "error").then(([err]) => err as Error),
    once(child, "exit").then(
      ([code, signal]) =>
        new CodexAgentExitedError("Codex agent exited during spawn", {
          code: code as number | null,
          signal: signal as string | null,
        }),
    ),
  ]);

  if (spawnFailure) {
    throw spawnFailure instanceof CodexAgentExitedError
      ? spawnFailure
      : new CodexAgentSpawnError(`Failed to spawn Codex agent: ${spawnFailure.message}`, {
          cause: spawnFailure,
        });
  }

  writeStderrLines(child, opts.logger);

  const endpoint = makeJsonRpcEndpoint({
    input: child.stdout,
    output: child.stdin,
    logger: opts.logger,
  });

  const agentEventHandlers = new Set<(event: CodexAgentEvent) => void>();
  let applyPatchApprovalHandler:
    | ((req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>)
    | null = null;
  let chatgptTokenRefreshHandler:
    | ((req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>)
    | null = null;

  endpoint.onNotification((notification) => {
    if (!isAgentEventMethod(notification.method)) return;
    const event = CodexAgentEventZ.parse({
      method: notification.method,
      params: notification.params,
    });
    for (const handler of agentEventHandlers) handler(event);
  });

  endpoint.onIncomingRequest(async (request) => {
    if (request.method === CLIENT_METHODS.apply_patch_approval) {
      if (!applyPatchApprovalHandler) {
        throw new CodexProtocolError("No apply-patch approval handler registered");
      }
      const parsed = ApplyPatchApprovalRequestZ.parse(request.params);
      return ApplyPatchApprovalResponseZ.parse(await applyPatchApprovalHandler(parsed));
    }

    if (request.method === CLIENT_METHODS.account_chatgpt_auth_tokens_refresh) {
      if (!chatgptTokenRefreshHandler) {
        throw new CodexRpcError({
          code: -32603,
          message: "ChatGPT token refresh is not available",
        });
      }
      const parsed = ChatgptAuthTokensRefreshRequestZ.parse(request.params);
      return ChatgptAuthTokensRefreshResponseZ.parse(await chatgptTokenRefreshHandler(parsed));
    }

    throw new CodexRpcError({ code: -32601, message: `Method not found: ${request.method}` });
  });

  const closed = once(child, "exit").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as string | null,
  }));
  void closed.then(({ code, signal }) => {
    void endpoint.close(new CodexAgentExitedError("Codex agent exited", { code, signal }));
  });

  return {
    async initialize(): Promise<CodexInitializeResponse> {
      return (await endpoint.request(
        AGENT_METHODS.initialize,
        defaultInitializeRequest(),
      )) as CodexInitializeResponse;
    },
    async newConversation(req: NewConversationRequest): Promise<NewConversationResponse> {
      return (await endpoint.request(AGENT_METHODS.thread_start, req)) as NewConversationResponse;
    },
    async sendUserMessage(req: SendUserMessageRequest): Promise<SendUserMessageResponse> {
      return (await endpoint.request(AGENT_METHODS.turn_start, req)) as SendUserMessageResponse;
    },
    async interrupt(req: InterruptRequest): Promise<void> {
      await endpoint.request(AGENT_METHODS.turn_interrupt, req);
    },
    onAgentEvent(handler: (event: CodexAgentEvent) => void): () => void {
      agentEventHandlers.add(handler);
      return () => agentEventHandlers.delete(handler);
    },
    onApplyPatchApproval(
      handler: (req: ApplyPatchApprovalRequest) => Promise<ApplyPatchApprovalResponse>,
    ): () => void {
      applyPatchApprovalHandler = handler;
      return () => {
        if (applyPatchApprovalHandler === handler) applyPatchApprovalHandler = null;
      };
    },
    onChatgptTokenRefresh(
      handler: (req: ChatgptAuthTokensRefreshRequest) => Promise<ChatgptAuthTokensRefreshResponse>,
    ): () => void {
      chatgptTokenRefreshHandler = handler;
      return () => {
        if (chatgptTokenRefreshHandler === handler) chatgptTokenRefreshHandler = null;
      };
    },
    async close(): Promise<void> {
      if (!child.killed) child.kill("SIGTERM");
      await endpoint.close(new CodexAgentExitedError("Codex client closed"));
      await closed;
    },
    closed,
  };
}
