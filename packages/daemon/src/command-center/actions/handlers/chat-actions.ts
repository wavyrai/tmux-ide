import { isAbsolute } from "node:path";
import {
  getDefaultCheckpointStore,
  getDefaultSessionStore,
  getDefaultThreadManager,
  getDefaultThreadStore,
} from "../../../chat/defaults.ts";
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
import type { SessionStore } from "../../../chat/session-store.ts";
import type { CheckpointStore } from "../../../chat/checkpoint-store.ts";
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
  sessionStore?: SessionStore;
  checkpointStore?: CheckpointStore;
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

function sessionStoreFrom(deps: ChatActionDeps): SessionStore {
  return deps.sessionStore ?? getDefaultSessionStore();
}

function checkpointStoreFrom(deps: ChatActionDeps): CheckpointStore {
  return deps.checkpointStore ?? getDefaultCheckpointStore();
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
  input: ActionInput<"chat.thread.list">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.thread.list">> {
  const all = await storeFrom(deps).list();
  if (input.projectDir === undefined) return { threads: all };
  // Project-scoped view — only return threads tagged with the same
  // workspace dir. Threads without a `projectDir` are global and
  // currently never returned in this filtered view; if we want them
  // back later, add an `includeGlobal: true` option to the contract.
  const threads = all.filter((t) => t.projectDir === input.projectDir);
  return { threads };
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
  // Cascade-clear sessions + checkpoints before deleting the thread so
  // nothing leaks into the next thread reusing this id. Ports the
  // behavior of the legacy DELETE /api/threads/:id REST shim.
  sessionStoreFrom(deps).clear(input.id);
  checkpointStoreFrom(deps).clear(input.id);
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
  await managerFrom(deps)
    .disposeLive(input.id)
    .catch(() => undefined);
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

/**
 * Rewind the thread to just BEFORE `userMessageId` and re-dispatch
 * with the supplied `content`. Implementation:
 *
 *   1. Validate the thread exists.
 *   2. Cancel any in-flight session for this thread — the old
 *      branch is about to be discarded, so leaving a live agent
 *      dangling would race the truncation.
 *   3. Truncate the thread at the user message id; `ThreadStore`
 *      throws a precise error when the id is missing or belongs to
 *      a non-user message, which we map to `bad_request`.
 *   4. Hand the new content to `ThreadManager.send` exactly as
 *      `chat.session.send` does, returning the dispatcher's
 *      `promptId` alongside the truncation count.
 *
 * The handler stays out of the wire-event business — `ThreadManager`
 * already broadcasts the standard `chat.thread.update` stream when
 * the new turn starts, so the dashboard re-renders without a special
 * "thread rewound" event.
 */
export async function chatSessionEditFromTurnHandler(
  input: ActionInput<"chat.session.editFromTurn">,
  deps: ChatActionDeps = {},
): Promise<ActionResult<"chat.session.editFromTurn">> {
  const store = storeFrom(deps);
  const manager = managerFrom(deps);
  await requireThread(store, input.threadId);

  // Best-effort cancel of any live session for this thread. The
  // manager surfaces NotFound when nothing is in flight — that's the
  // common case and we ignore it.
  try {
    await manager.cancel({ threadId: input.threadId });
  } catch (err) {
    if (!(err instanceof ThreadNotFoundError)) throw err;
  }

  let truncatedCount: number;
  try {
    const result = await store.truncateFromUserMessage(input.threadId, input.userMessageId);
    truncatedCount = result.truncatedCount;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes("not found")) {
        throw badRequest(err.message, {
          threadId: input.threadId,
          userMessageId: input.userMessageId,
        });
      }
      if (err.message.includes("is not a user prompt")) {
        throw badRequest(err.message, {
          threadId: input.threadId,
          userMessageId: input.userMessageId,
        });
      }
    }
    throw err;
  }

  const { promptId } = await manager.send({
    threadId: input.threadId,
    content: input.content as ContentBlock[],
  });

  return { accepted: true, promptId, truncatedCount };
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
