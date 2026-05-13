import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AgentProvider,
  ChatThreadUsageSummary,
  StopReason,
  ThreadIndexEntry,
  ThreadMessage,
  ThreadState,
} from "./types.ts";

export interface ThreadStore {
  list(): Promise<ThreadIndexEntry[]>;
  get(id: string): Promise<ThreadState | null>;
  create(input: {
    provider: AgentProvider;
    projectDir?: string;
    title?: string;
    /** Optional ProviderInstance backing this thread (T080). */
    providerInstanceId?: string;
  }): Promise<ThreadState>;
  rename(id: string, title: string): Promise<ThreadIndexEntry>;
  /**
   * Replace the thread's provider in place. Clears `acpSessionId` since
   * any live session is bound to the old provider — the next
   * `chat.session.send` re-spawns under the new provider. Returns the
   * updated index entry.
   */
  setProvider(id: string, provider: AgentProvider): Promise<ThreadIndexEntry>;
  delete(id: string): Promise<void>;
  appendMessage(id: string, msg: ThreadMessage): Promise<void>;
  appendMessages(id: string, messages: ThreadMessage[]): Promise<void>;
  recordAcpSessionId(id: string, acpSessionId: string): Promise<void>;
  recordUsage(id: string, usage: ChatThreadUsageSummary): Promise<void>;
  recordStopReason(id: string, reason: StopReason): Promise<void>;
}

interface IndexFile {
  version: 1;
  threads: ThreadIndexEntry[];
}

export interface MakeThreadStoreOptions {
  rootDir: string;
  now?: () => Date;
  randomId?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanTitle(title: string | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? trimmed.slice(0, 80) : "New chat";
}

function titleFromFirstPrompt(msg: ThreadMessage): string | null {
  if (msg._tag !== "UserPrompt") return null;
  const text = msg.content.find(
    (block): block is Extract<(typeof msg.content)[number], { type: "text" }> =>
      block.type === "text" && block.text.trim().length > 0,
  );
  return text ? cleanTitle(text.text) : null;
}

function threadPath(rootDir: string, id: string): string {
  return join(rootDir, "threads", `${id}.json`);
}

function indexPath(rootDir: string): string {
  return join(rootDir, "threads.json");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
  randomId: () => string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomId()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function makeThreadStore(opts: MakeThreadStoreOptions): ThreadStore {
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? randomUUID;
  const rootDir = opts.rootDir;
  const threadsDir = join(rootDir, "threads");
  let hydrated = false;
  let index: ThreadIndexEntry[] = [];
  const states = new Map<string, ThreadState>();
  let writeQueue: Promise<void> = Promise.resolve();

  async function hydrate(): Promise<void> {
    if (hydrated) return;
    await mkdir(threadsDir, { recursive: true });
    const rawIndex = await readJson<IndexFile>(indexPath(rootDir));
    index = rawIndex?.version === 1 && Array.isArray(rawIndex.threads) ? rawIndex.threads : [];
    states.clear();
    for (const entry of index) {
      const state = await readJson<ThreadState>(threadPath(rootDir, entry.id));
      if (state) states.set(entry.id, state);
    }
    index = index.filter((entry) => states.has(entry.id));
    hydrated = true;
  }

  async function persistIndex(): Promise<void> {
    await writeJsonAtomic(indexPath(rootDir), { version: 1, threads: index }, randomId);
  }

  async function persistState(state: ThreadState): Promise<void> {
    await writeJsonAtomic(threadPath(rootDir, state.id), state, randomId);
  }

  function enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(op, op);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function entryFromState(state: ThreadState, existing?: ThreadIndexEntry): ThreadIndexEntry {
    const entry: ThreadIndexEntry = {
      id: state.id,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      providerKind: state.provider.kind,
      messageCount: state.messages.length,
      ...(state.projectDir ? { projectDir: state.projectDir } : {}),
      ...(existing?.lastStopReason ? { lastStopReason: existing.lastStopReason } : {}),
    };
    return entry;
  }

  function findEntry(id: string): ThreadIndexEntry | undefined {
    return index.find((entry) => entry.id === id);
  }

  function appendMessages(id: string, messages: ThreadMessage[]): Promise<void> {
    return enqueue(async () => {
      if (messages.length === 0) return;
      const { state, entry } = await updateThread(id, (nextState, nextEntry) => {
        const updatedAt = now().toISOString();
        const firstPromptTitle =
          nextState.messages.length === 0 && nextState.title === "New chat"
            ? messages.reduce<string | null>(
                (found, message) => found ?? titleFromFirstPrompt(message),
                null,
              )
            : null;
        if (firstPromptTitle) {
          nextState.title = firstPromptTitle;
          nextEntry.title = firstPromptTitle;
        }
        nextState.messages.push(...messages.map(clone));
        nextState.updatedAt = updatedAt;
        nextEntry.updatedAt = updatedAt;
        nextEntry.messageCount = nextState.messages.length;
      });
      states.set(id, state);
      index = index.map((candidate) => (candidate.id === id ? entry : candidate));
    });
  }

  async function updateThread(
    id: string,
    update: (state: ThreadState, entry: ThreadIndexEntry) => void,
  ): Promise<{ state: ThreadState; entry: ThreadIndexEntry }> {
    await hydrate();
    const state = states.get(id);
    const entry = findEntry(id);
    if (!state || !entry) throw new Error(`Thread ${id} not found`);
    update(state, entry);
    await persistState(state);
    await persistIndex();
    return { state, entry };
  }

  return {
    async list() {
      await hydrate();
      return clone(index);
    },
    async get(id) {
      await hydrate();
      const state = states.get(id);
      return state ? clone(state) : null;
    },
    create(input) {
      return enqueue(async () => {
        await hydrate();
        const id = randomId();
        const createdAt = now().toISOString();
        const state: ThreadState = {
          id,
          title: cleanTitle(input.title),
          createdAt,
          updatedAt: createdAt,
          provider: clone(input.provider),
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          ...(input.projectDir ? { projectDir: input.projectDir } : {}),
          messages: [],
        };
        const entry = entryFromState(state);
        states.set(id, state);
        index = [entry, ...index];
        await persistState(state);
        await persistIndex();
        return clone(state);
      });
    },
    rename(id, title) {
      return enqueue(async () => {
        const { state, entry } = await updateThread(id, (nextState, nextEntry) => {
          const updatedAt = now().toISOString();
          nextState.title = cleanTitle(title);
          nextState.updatedAt = updatedAt;
          nextEntry.title = nextState.title;
          nextEntry.updatedAt = updatedAt;
        });
        states.set(id, state);
        return clone(entry);
      });
    },
    setProvider(id, provider) {
      return enqueue(async () => {
        const { state, entry } = await updateThread(id, (nextState, nextEntry) => {
          const updatedAt = now().toISOString();
          nextState.provider = clone(provider);
          nextState.acpSessionId = undefined;
          nextState.updatedAt = updatedAt;
          nextEntry.providerKind = provider.kind;
          nextEntry.updatedAt = updatedAt;
        });
        states.set(id, state);
        return clone(entry);
      });
    },
    delete(id) {
      return enqueue(async () => {
        await hydrate();
        states.delete(id);
        index = index.filter((entry) => entry.id !== id);
        await rm(threadPath(rootDir, id), { force: true });
        await persistIndex();
      });
    },
    appendMessage(id, msg) {
      return appendMessages(id, [msg]);
    },
    appendMessages,
    recordAcpSessionId(id, acpSessionId) {
      return enqueue(async () => {
        const { state } = await updateThread(id, (nextState) => {
          nextState.acpSessionId = acpSessionId;
        });
        states.set(id, state);
      });
    },
    recordUsage(id, usage) {
      return enqueue(async () => {
        const { state } = await updateThread(id, (nextState, nextEntry) => {
          const updatedAt = now().toISOString();
          nextState.usage = clone(usage);
          nextState.updatedAt = updatedAt;
          nextEntry.updatedAt = updatedAt;
        });
        states.set(id, state);
      });
    },
    recordStopReason(id, reason) {
      return enqueue(async () => {
        const { state } = await updateThread(id, (nextState, nextEntry) => {
          const updatedAt = now().toISOString();
          nextState.updatedAt = updatedAt;
          nextEntry.updatedAt = updatedAt;
          nextEntry.lastStopReason = reason;
        });
        states.set(id, state);
      });
    },
  };
}
