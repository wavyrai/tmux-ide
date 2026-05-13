import { isAbsolute } from "node:path";
import { getDefaultThreadManager, getDefaultThreadStore } from "../../../chat/defaults.ts";
import {
  discoverProviders,
  type ProviderDiscoveryOptions,
  type ProviderInfo,
} from "../../../chat/provider-discovery.ts";
import {
  InvalidPermissionOptionError,
  PermissionRequestNotFoundError,
  ThreadNotFoundError,
  type ThreadManager,
} from "../../../chat/thread-manager.ts";
import type { ThreadStore } from "../../../chat/thread-store.ts";
import type {
  ChatEvent,
  ContentBlock,
  ThreadIndexEntry,
  ThreadState,
} from "../../../chat/types.ts";
import { broadcastChatEvent } from "../../ws-events.ts";
import type { ActionInput, ActionResult } from "../contract.ts";
import { ActionError } from "../errors.ts";

export interface ChatActionDeps {
  store?: ThreadStore;
  manager?: ThreadManager;
  busEmit?: (event: ChatEvent) => void;
  discover?: ProviderDiscoveryOptions;
  now?: () => number;
}

const PROVIDER_CACHE_TTL_MS = 5_000;

let providerCache: {
  expiresAt: number;
  providers: ProviderInfo[];
} | null = null;
let providerCachePending: Promise<ProviderInfo[]> | null = null;

export function resetChatProvidersListCache(): void {
  providerCache = null;
  providerCachePending = null;
}

function storeFrom(deps: ChatActionDeps): ThreadStore {
  return deps.store ?? getDefaultThreadStore();
}

function managerFrom(deps: ChatActionDeps): ThreadManager {
  return deps.manager ?? getDefaultThreadManager();
}

function busFrom(deps: ChatActionDeps): (event: ChatEvent) => void {
  return deps.busEmit ?? broadcastChatEvent;
}

function badRequest(message: string, details?: unknown): ActionError {
  return new ActionError({ code: "bad_request", message, details });
}

function threadNotFound(id: string): ActionError {
  return new ActionError({
    code: "thread_not_found",
    message: `Chat thread "${id}" not found`,
    details: { id },
  });
}

function permissionRequestNotFound(threadId: string, requestId: string): ActionError {
  return new ActionError({
    code: "permission_request_not_found",
    message: `Permission request "${requestId}" not found for thread "${threadId}"`,
    details: { threadId, requestId },
  });
}

function mapPermissionRespondError(
  err: unknown,
  input: ActionInput<"chat.permission.respond">,
): never {
  if (err instanceof ThreadNotFoundError) {
    throw threadNotFound(err.threadId);
  }
  if (err instanceof PermissionRequestNotFoundError) {
    throw permissionRequestNotFound(err.threadId, err.requestId);
  }
  if (err instanceof InvalidPermissionOptionError) {
    throw badRequest(err.message, {
      threadId: input.threadId,
      requestId: err.requestId,
      optionId: err.optionId,
    });
  }
  throw err;
}

async function requireThread(store: ThreadStore, id: string): Promise<ThreadState> {
  const thread = await store.get(id);
  if (!thread) throw threadNotFound(id);
  return thread;
}

async function entryFor(store: ThreadStore, id: string): Promise<ThreadIndexEntry> {
  const entry = (await store.list()).find((candidate) => candidate.id === id);
  if (!entry) throw threadNotFound(id);
  return entry;
}

async function emitIndex(store: ThreadStore, emit: (event: ChatEvent) => void): Promise<void> {
  emit({ type: "chat.thread.index", threads: await store.list() });
}

export async function chatThreadListHandler(
  _input: ActionInput<"chat.thread.list">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.list">> {
  return { threads: await storeFrom(deps).list() };
}

export async function chatProvidersListHandler(
  _input: ActionInput<"chat.providers.list">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.providers.list">> {
  const now = deps.now?.() ?? Date.now();
  if (providerCache && providerCache.expiresAt > now) {
    return { providers: providerCache.providers };
  }

  providerCachePending ??= discoverProviders(deps.discover);
  let providers: ProviderInfo[];
  try {
    providers = await providerCachePending;
  } finally {
    providerCachePending = null;
  }
  providerCache = { providers, expiresAt: now + PROVIDER_CACHE_TTL_MS };
  return { providers };
}

export async function chatThreadCreateHandler(
  input: ActionInput<"chat.thread.create">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.create">> {
  if (input.projectDir && !isAbsolute(input.projectDir)) {
    throw badRequest("projectDir must be an absolute path", { projectDir: input.projectDir });
  }
  const store = storeFrom(deps);
  const state = await store.create(input);
  const thread = await entryFor(store, state.id);
  await emitIndex(store, busFrom(deps));
  return { thread };
}

export async function chatThreadDeleteHandler(
  input: ActionInput<"chat.thread.delete">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.delete">> {
  const store = storeFrom(deps);
  await requireThread(store, input.id);
  await store.delete(input.id);
  await emitIndex(store, busFrom(deps));
  return { deleted: true };
}

export async function chatThreadRenameHandler(
  input: ActionInput<"chat.thread.rename">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.rename">> {
  const title = input.title.trim();
  if (!title) throw badRequest("title must not be blank");
  const store = storeFrom(deps);
  await requireThread(store, input.id);
  const thread = await store.rename(input.id, title);
  await emitIndex(store, busFrom(deps));
  return { thread };
}

export async function chatThreadSetProviderHandler(
  input: ActionInput<"chat.thread.setProvider">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.setProvider">> {
  const store = storeFrom(deps);
  await requireThread(store, input.id);
  const thread = await store.setProvider(input.id, input.provider);
  // Tear down any live session bound to the old provider so the next
  // send re-spawns under the new one. `disposeLive` is a no-op when the
  // thread isn't live (e.g. fresh thread that never sent a message).
  await managerFrom(deps).disposeLive(input.id).catch(() => undefined);
  await emitIndex(store, busFrom(deps));
  return { thread };
}

export async function chatThreadGetHandler(
  input: ActionInput<"chat.thread.get">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.get">> {
  return { thread: await requireThread(storeFrom(deps), input.id) };
}

export async function chatThreadUsageHandler(
  input: ActionInput<"chat.thread.usage">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.usage">> {
  const thread = await requireThread(storeFrom(deps), input.id);
  return { usage: thread.usage ?? null };
}

export async function chatSessionSendHandler(
  input: ActionInput<"chat.session.send">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.session.send">> {
  await requireThread(storeFrom(deps), input.threadId);
  const { promptId } = await managerFrom(deps).send({
    threadId: input.threadId,
    content: input.content as ContentBlock[],
  });
  return { accepted: true, promptId };
}

export async function chatSessionCancelHandler(
  input: ActionInput<"chat.session.cancel">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.session.cancel">> {
  await requireThread(storeFrom(deps), input.threadId);
  await managerFrom(deps).cancel(input);
  return { cancelled: true };
}

export async function chatPermissionRespondHandler(
  input: ActionInput<"chat.permission.respond">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.permission.respond">> {
  try {
    return await managerFrom(deps).respondPermission(input);
  } catch (err) {
    mapPermissionRespondError(err, input);
  }
}
