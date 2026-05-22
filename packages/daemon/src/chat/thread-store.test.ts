import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeThreadStore } from "./thread-store.ts";
import type { AgentProvider, ThreadMessage } from "./types.ts";

const provider: AgentProvider = { kind: "claude-code" };

let rootDir = "";
let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `id-${idCounter}`;
}

function userMessage(id: string, text: string): ThreadMessage {
  return {
    _tag: "UserPrompt",
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "tmux-ide-chat-store-"));
  idCounter = 0;
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("makeThreadStore", () => {
  it("creates, lists, and reads threads from disk-backed state", async () => {
    const store = makeThreadStore({
      rootDir,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomId: nextId,
    });

    const created = await store.create({ provider, projectDir: "/tmp/project" });

    expect(created).toMatchObject({
      id: "id-1",
      title: "New chat",
      provider,
      projectDir: "/tmp/project",
      messages: [],
    });
    expect(await store.list()).toEqual([
      {
        id: "id-1",
        title: "New chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        providerKind: "claude-code",
        projectDir: "/tmp/project",
        messageCount: 0,
      },
    ]);

    const reloaded = makeThreadStore({ rootDir, randomId: nextId });
    expect(await reloaded.get("id-1")).toEqual(created);
  });

  it("renames, records ACP metadata, and deletes a thread", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider, title: "Original" });

    await store.recordAcpSessionId(created.id, "session-1");
    await store.recordStopReason(created.id, "end_turn");
    const renamed = await store.rename(created.id, "Renamed");

    expect(renamed.title).toBe("Renamed");
    expect(renamed.lastStopReason).toBe("end_turn");
    expect((await store.get(created.id))?.acpSessionId).toBe("session-1");

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(existsSync(join(rootDir, "threads", `${created.id}.json`))).toBe(false);
  });

  it("records usage and reloads it from disk", async () => {
    const store = makeThreadStore({
      rootDir,
      randomId: nextId,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const created = await store.create({ provider });

    await store.recordUsage(created.id, {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 10,
      totalCostUsd: 0.0421,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 135,
    });

    const reloaded = makeThreadStore({ rootDir, randomId: nextId });
    expect((await reloaded.get(created.id))?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 10,
      totalCostUsd: 0.0421,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 135,
    });
  });

  it("updates first prompt title, message count, and persisted index on append", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider });

    await store.appendMessage(
      created.id,
      userMessage(
        "prompt-1",
        "This first message becomes the thread title and is clipped after eighty characters",
      ),
    );

    const [entry] = await store.list();
    expect(entry?.title).toBe(
      "This first message becomes the thread title and is clipped after eighty characte",
    );
    expect(entry?.messageCount).toBe(1);
    expect((await store.get(created.id))?.messages).toHaveLength(1);

    const index = JSON.parse(readFileSync(join(rootDir, "threads.json"), "utf-8")) as {
      threads: Array<{ messageCount: number }>;
    };
    expect(index.threads[0]?.messageCount).toBe(1);
  });

  it("bulk appends messages with one thread rewrite and one index rewrite", async () => {
    let tick = 0;
    const store = makeThreadStore({
      rootDir,
      randomId: nextId,
      now: () => new Date(`2026-01-01T00:00:0${tick++}.000Z`),
    });
    const created = await store.create({ provider });
    const idCountBeforeAppend = idCounter;

    await store.appendMessages(created.id, [
      userMessage("prompt-1", "Bulk appended prompt title"),
      {
        _tag: "AgentUpdate",
        id: "agent-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
          messageId: "msg-1",
        },
      },
      {
        _tag: "AgentUpdate",
        id: "agent-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " world" },
          messageId: "msg-1",
        },
      },
    ]);

    const thread = await store.get(created.id);
    const [entry] = await store.list();
    expect(idCounter - idCountBeforeAppend).toBe(2);
    expect(thread?.messages).toHaveLength(3);
    expect(thread?.updatedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(entry?.title).toBe("Bulk appended prompt title");
    expect(entry?.messageCount).toBe(3);
    expect(entry?.updatedAt).toBe(thread?.updatedAt);

    const index = JSON.parse(readFileSync(join(rootDir, "threads.json"), "utf-8")) as {
      threads: Array<{ messageCount: number; updatedAt: string }>;
    };
    expect(index.threads[0]?.messageCount).toBe(3);
    expect(index.threads[0]?.updatedAt).toBe(thread?.updatedAt);
  });

  it("serializes concurrent writes through one store queue", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider });

    await Promise.all(
      Array.from({ length: 25 }, (_, idx) =>
        store.appendMessage(created.id, userMessage(`prompt-${idx}`, `message ${idx}`)),
      ),
    );

    const thread = await store.get(created.id);
    const [entry] = await store.list();
    expect(thread?.messages).toHaveLength(25);
    expect(entry?.messageCount).toBe(25);
    expect(
      JSON.parse(readFileSync(join(rootDir, "threads", `${created.id}.json`), "utf-8")),
    ).toBeTruthy();
  });

  it("ignores stray temp files and hydrates the last complete write", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider, title: "Durable" });
    await store.appendMessage(created.id, userMessage("prompt-1", "hello"));

    writeFileSync(join(rootDir, "threads.json.tmp.crash"), "{not json");
    writeFileSync(join(rootDir, "threads", `${created.id}.json.tmp.crash`), "{not json");

    const reloaded = makeThreadStore({ rootDir, randomId: nextId });
    expect((await reloaded.list())[0]?.title).toBe("Durable");
    expect((await reloaded.get(created.id))?.messages).toHaveLength(1);
  });

  it("truncateFromUserMessage drops every message at or after the user id", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider, title: "Edit" });
    await store.appendMessages(created.id, [
      userMessage("u-1", "first"),
      userMessage("u-2", "second"),
      userMessage("u-3", "third"),
    ]);

    const result = await store.truncateFromUserMessage(created.id, "u-2");

    expect(result.truncatedCount).toBe(2);
    const thread = await store.get(created.id);
    expect(thread?.messages.map((m) => m.id)).toEqual(["u-1"]);
    const [entry] = await store.list();
    expect(entry?.messageCount).toBe(1);
  });

  it("truncateFromUserMessage updates updatedAt and persists to disk", async () => {
    const calls: Date[] = [
      new Date("2026-05-14T10:00:00.000Z"),
      new Date("2026-05-14T10:00:05.000Z"),
      new Date("2026-05-14T10:01:00.000Z"),
    ];
    const store = makeThreadStore({
      rootDir,
      randomId: nextId,
      now: () => calls.shift() ?? new Date("2026-05-14T10:02:00.000Z"),
    });
    const created = await store.create({ provider, title: "Edit" });
    await store.appendMessage(created.id, userMessage("u-1", "first"));
    const before = (await store.get(created.id))!;

    await store.truncateFromUserMessage(created.id, "u-1");
    const after = (await store.get(created.id))!;
    expect(after.messages).toHaveLength(0);
    expect(after.updatedAt > before.updatedAt).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(rootDir, "threads", `${created.id}.json`), "utf-8"),
    );
    expect(onDisk.messages).toEqual([]);
  });

  it("throws when the user message id is not in the thread", async () => {
    const store = makeThreadStore({ rootDir, randomId: nextId });
    const created = await store.create({ provider, title: "Edit" });
    await store.appendMessage(created.id, userMessage("u-1", "first"));
    await expect(store.truncateFromUserMessage(created.id, "u-zzz")).rejects.toThrow(
      /User message u-zzz not found/,
    );
  });
});
