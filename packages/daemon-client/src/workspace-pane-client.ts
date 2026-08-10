import {
  WorkspacePaneCreateArgumentsSchemaZ,
  WorkspacePaneSendArgumentsSchemaZ,
  type WorkspacePaneCreateArguments,
  type WorkspacePaneCreateMutationResult,
  type WorkspacePaneSendArguments,
  type WorkspacePaneSendResult,
} from "@tmux-ide/contracts";

import { dispatchOwnerAction } from "./owner-action-client.ts";

export interface CreateWorkspacePaneAsOwnerOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly intent: WorkspacePaneCreateArguments;
  /** Stable across transport retries; the daemon is the idempotency authority. */
  readonly operationId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Typed SDK entry point for the workspace pane capability shared by GUI hosts,
 * TUIs, CLIs, and test drivers. It intentionally accepts semantic intent only:
 * callers cannot smuggle tmux targets, argv, cwd, or environment authority.
 */
export async function createWorkspacePaneAsOwner(
  options: CreateWorkspacePaneAsOwnerOptions,
): Promise<WorkspacePaneCreateMutationResult | null> {
  return await dispatchOwnerAction({
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    name: "workspace.pane.create",
    input: WorkspacePaneCreateArgumentsSchemaZ.parse(options.intent),
    operationId: options.operationId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

export interface SendWorkspacePaneAsOwnerOptions {
  readonly baseUrl: string;
  readonly ownerToken: string;
  readonly intent: WorkspacePaneSendArguments;
  readonly operationId: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Privacy-safe semantic message delivery shared by GUI, TUI, CLI and SDK clients. */
export async function sendWorkspacePaneAsOwner(
  options: SendWorkspacePaneAsOwnerOptions,
): Promise<WorkspacePaneSendResult | null> {
  return await dispatchOwnerAction({
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    name: "workspace.pane.send",
    input: WorkspacePaneSendArgumentsSchemaZ.parse(options.intent),
    operationId: options.operationId,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
