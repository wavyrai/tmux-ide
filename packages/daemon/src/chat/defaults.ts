import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  CHAT_THREAD_EVENT_TYPES,
  type ChatThreadEvent,
  type ChatThreadEventType,
} from "@tmux-ide/contracts";
import { spawnAcpClient } from "../acp/index.ts";
import { broadcastChatEvent } from "../command-center/ws-events.ts";
import { openDatabase, type SqliteDb } from "../lib/sqlite-adapter.ts";
import { makeChatEventStore, type ChatEventStore } from "../persistence/chat-event-store.ts";
import {
  makeTurnProjection,
  type TurnProjection,
} from "../persistence/projections/turn-projection.ts";
import {
  makeTurnDiffProjection,
  type TurnDiffProjection,
} from "../persistence/projections/turn-diff-projection.ts";
import { makeInMemoryCursorStore } from "../persistence/types.ts";
import { makeThreadManager, type ThreadManager } from "./thread-manager.ts";
import { makeThreadStore, type ThreadStore } from "./thread-store.ts";
import { makePlanStore, type PlanStore } from "./plan-store.ts";
import { makePlanOrchestrator, type PlanOrchestrator } from "./plan-orchestrator.ts";
import { makeSessionStore, type SessionStore } from "./session-store.ts";
import { makeCheckpointStore, type CheckpointStore } from "./checkpoint-store.ts";
import type { ChatEvent } from "./types.ts";

let defaultStore: ThreadStore | null = null;
let defaultManager: ThreadManager | null = null;
let defaultPlanStore: PlanStore | null = null;
let defaultPlanOrchestrator: PlanOrchestrator | null = null;
let defaultSessionStore: SessionStore | null = null;
let defaultCheckpointStore: CheckpointStore | null = null;
let defaultEventDb: SqliteDb | null = null;
let defaultEventStore: ChatEventStore | null = null;
let defaultTurnProjection: TurnProjection | null = null;
let defaultTurnDiffProjection: TurnDiffProjection | null = null;
let bootIndexEmitted = false;
const activeTurns = new Map<string, string>();

const CHAT_THREAD_EVENT_TYPE_SET: ReadonlySet<ChatThreadEventType> = new Set(
  CHAT_THREAD_EVENT_TYPES,
);

/** Type guard: only canonical chat thread events go into the durable log. */
function isChatThreadEvent(event: ChatEvent): event is ChatThreadEvent {
  return CHAT_THREAD_EVENT_TYPE_SET.has(event.type as ChatThreadEventType);
}

/** Resolve the per-process actor for the event store envelope. */
function inferActorKind(event: ChatThreadEvent): "user" | "provider" | "system" {
  switch (event.type) {
    case "chat.activity.appended":
      // ThreadActivityTone is "error" | "info" | "tool" | "approval" — none
      // of these carry actor attribution. Default to "user"; agent/provider
      // attribution should ride on `sessionId` once the contract carries it
      // (see T078). The previous `tone === "agent"` comparison was dead.
      return "user";
    case "chat.turn.started":
    case "chat.turn.completed":
    case "chat.turn.aborted":
      return "provider";
    case "chat.session.added":
    case "chat.session.removed":
    case "chat.session.status-changed":
      return "system";
    case "chat.plan.upserted":
    case "chat.checkpoint.created":
    case "chat.thread.reverted":
      return "system";
  }
}

export function defaultChatRootDir(): string {
  return process.env.TMUX_IDE_CHATS_DIR ?? join(homedir(), ".tmux-ide", "chats");
}

/**
 * Lazily-opened sqlite database backing the chat event store + projections
 * (T090/T091/T095). Lives under the chat root so the rest of chat state
 * (thread JSON files) stays adjacent for inspection. The file is created
 * on first access; the directory is ensured here so a fresh install boots
 * cleanly without a separate setup step.
 */
function getDefaultEventDb(): SqliteDb {
  if (defaultEventDb) return defaultEventDb;
  const dir = defaultChatRootDir();
  mkdirSync(dir, { recursive: true });
  const path = process.env.TMUX_IDE_CHAT_EVENTS_DB ?? join(dir, "events.sqlite");
  defaultEventDb = openDatabase(path);
  return defaultEventDb;
}

/**
 * The durable chat event log. Replaces volatile turn/activity/session
 * state with replayable storage per goal-14 §2.1 Phase 1. Lazy so tests
 * that never touch chat skip the sqlite open.
 */
export function getDefaultChatEventStore(): ChatEventStore {
  defaultEventStore ??= makeChatEventStore(getDefaultEventDb());
  return defaultEventStore;
}

/**
 * Singleton turn projection. Bootstraps from the event store on first
 * access, then stays in sync via the store's `subscribe` channel. Read
 * methods are safe to call concurrently.
 */
export function getDefaultTurnProjection(): TurnProjection {
  if (defaultTurnProjection) return defaultTurnProjection;
  const store = getDefaultChatEventStore();
  const projection = makeTurnProjection({
    reader: store,
    cursorStore: makeInMemoryCursorStore(),
  });
  projection.start();
  defaultTurnProjection = projection;
  return projection;
}

/**
 * Singleton TurnDiff projection (T101). Same lifecycle as
 * getDefaultTurnProjection — bootstraps from the chat event store on
 * first access, then stays current via the store's `subscribe` channel.
 * Read methods are safe to call concurrently from request handlers.
 */
export function getDefaultTurnDiffProjection(): TurnDiffProjection {
  if (defaultTurnDiffProjection) return defaultTurnDiffProjection;
  const store = getDefaultChatEventStore();
  const projection = makeTurnDiffProjection({
    reader: store,
    cursorStore: makeInMemoryCursorStore(),
  });
  projection.start();
  defaultTurnDiffProjection = projection;
  return projection;
}

/**
 * Hook every chat event broadcast through the durable log. Non-chat-thread
 * events (chat.thread.update, chat.thread.usage, …) are broadcast-only and
 * not persisted — they are derived/projected data, not source-of-truth.
 *
 * Failures during persistence are caught + logged but never block the
 * broadcast. The event log is best-effort *additive* state today; once
 * T091/T094 projections become the source of truth (G14-T06), a failing
 * append will need to fail the request, but that is a later phase.
 */
function persistAndBroadcast(event: ChatEvent): void {
  if (isChatThreadEvent(event)) {
    try {
      getDefaultChatEventStore().append({
        event,
        actorKind: inferActorKind(event),
      });
    } catch (err) {
      console.error("[chat-event-store] persist failed:", err);
    }
  }
  broadcastChatEvent(event);
}

export function getDefaultThreadStore(): ThreadStore {
  defaultStore ??= makeThreadStore({ rootDir: defaultChatRootDir() });
  return defaultStore;
}

export function getDefaultThreadManager(): ThreadManager {
  defaultManager ??= makeThreadManager({
    store: getDefaultThreadStore(),
    spawnClient: (provider, opts) => spawnAcpClient({ provider, cwd: opts.cwd }),
    busEmit: (event: ChatEvent) => persistAndBroadcast(event),
    logger: (event) => {
      if (event.level === "error") console.error("[chat]", event.msg, event.data ?? "");
      else if (event.level === "warn") console.warn("[chat]", event.msg, event.data ?? "");
    },
  });
  return defaultManager;
}

export function getDefaultPlanStore(): PlanStore {
  defaultPlanStore ??= makePlanStore({
    emit: (event) => persistAndBroadcast(event),
  });
  return defaultPlanStore;
}

export function getDefaultSessionStore(): SessionStore {
  defaultSessionStore ??= makeSessionStore({
    emit: (event) => persistAndBroadcast(event),
  });
  return defaultSessionStore;
}

export function getDefaultCheckpointStore(): CheckpointStore {
  defaultCheckpointStore ??= makeCheckpointStore({
    emit: (event) => persistAndBroadcast(event),
  });
  return defaultCheckpointStore;
}

export function getDefaultPlanOrchestrator(): PlanOrchestrator {
  if (defaultPlanOrchestrator) return defaultPlanOrchestrator;
  const planStore = getDefaultPlanStore();
  const manager = getDefaultThreadManager();
  defaultPlanOrchestrator = makePlanOrchestrator({
    planStore,
    isTurnRunning: (threadId) => activeTurns.has(threadId),
    sendTurn: async ({ threadId, planMarkdown }) => {
      const turnId = randomUUID();
      activeTurns.set(threadId, turnId);
      try {
        await manager.send({
          threadId,
          content: [{ type: "text", text: planMarkdown }],
        });
      } finally {
        // The downstream pipeline owns the real turn lifecycle; we
        // release the marker once `send` returns so a subsequent approve
        // can proceed. Future T-tasks will hook this to the t3-style
        // turn-store completion events.
        activeTurns.delete(threadId);
      }
      return { turnId };
    },
  });
  return defaultPlanOrchestrator;
}

export function initializeDefaultChatRuntime(): void {
  const store = getDefaultThreadStore();
  getDefaultThreadManager();
  getDefaultPlanStore();
  getDefaultPlanOrchestrator();
  // Open + bootstrap the durable event pipeline. Lazy in the sense that
  // a process that never uses chat pays nothing; once chat is touched,
  // these singletons stay alive for the daemon's lifetime.
  getDefaultChatEventStore();
  getDefaultTurnProjection();
  if (bootIndexEmitted) return;
  bootIndexEmitted = true;
  void store.list().then((threads) => {
    persistAndBroadcast({ type: "chat.thread.index", threads });
  });
}

export async function shutdownDefaultChatRuntime(): Promise<void> {
  await defaultManager?.shutdown();
  defaultManager = null;
  defaultTurnProjection?.stop();
  defaultTurnProjection = null;
  defaultTurnDiffProjection?.stop();
  defaultTurnDiffProjection = null;
  try {
    defaultEventDb?.close();
  } catch {
    // Best-effort: a re-entrant shutdown can race with sqlite cleanup.
  }
  defaultEventDb = null;
  defaultEventStore = null;
}

export function _resetDefaultChatRuntimeForTests(): void {
  defaultStore = null;
  defaultManager = null;
  defaultPlanStore = null;
  defaultPlanOrchestrator = null;
  defaultSessionStore = null;
  defaultCheckpointStore = null;
  defaultTurnProjection?.stop();
  defaultTurnProjection = null;
  defaultTurnDiffProjection?.stop();
  defaultTurnDiffProjection = null;
  try {
    defaultEventDb?.close();
  } catch {
    /* ignore */
  }
  defaultEventDb = null;
  defaultEventStore = null;
  bootIndexEmitted = false;
  activeTurns.clear();
}
