import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeThreadStore, type ThreadStore } from "../../../chat/thread-store.ts";
import type { ChatEvent, ContentBlock } from "../../../chat/types.ts";
import {
  InvalidPermissionOptionError,
  PermissionRequestNotFoundError,
  ThreadNotFoundError,
  type ThreadManager,
} from "../../../chat/thread-manager.ts";
import { ActionContractsZ } from "../contract.ts";
import { ActionError } from "../errors.ts";
import {
  chatPermissionRespondHandler,
  chatProvidersListHandler,
  chatSessionCancelHandler,
  chatSessionSendHandler,
  chatThreadCreateHandler,
  chatThreadDeleteHandler,
  chatThreadGetHandler,
  chatThreadListHandler,
  chatThreadRenameHandler,
  chatThreadSetProviderHandler,
  chatThreadUsageHandler,
  resetChatProvidersListCache,
} from "./chat-actions.ts";
import { wrapInternalError } from "../errors.ts";

let rootDir = "";
let store: ThreadStore;
let events: ChatEvent[];
let sent: Array<{ threadId: string; content: ContentBlock[] }>;
let cancelled: string[];
let permissionResponses: Array<{ threadId: string; requestId: string; optionId: string }>;

const manager: ThreadManager = {
  async send(input) {
    sent.push(input);
    return { promptId: "prompt-1" };
  },
  async cancel(input) {
    cancelled.push(input.threadId);
  },
  async respondPermission(input) {
    permissionResponses.push(input);
    return { responded: true };
  },
  async disposeLive() {},
  async shutdown() {},
};

beforeEach(() => {
  resetChatProvidersListCache();
  rootDir = mkdtempSync(join(tmpdir(), "tmux-ide-chat-actions-"));
  store = makeThreadStore({
    rootDir,
    randomId: (() => {
      let id = 0;
      return () => {
        id += 1;
        return `id-${id}`;
      };
    })(),
  });
  events = [];
  sent = [];
  cancelled = [];
  permissionResponses = [];
});

afterEach(() => {
  resetChatProvidersListCache();
  rmSync(rootDir, { recursive: true, force: true });
});

function deps() {
  return {
    store,
    manager,
    busEmit: (event: ChatEvent) => events.push(event),
  };
}

function expectActionError(err: unknown, code: string): void {
  expect(err).toBeInstanceOf(ActionError);
  expect((err as ActionError).code).toBe(code);
}

describe("chat action handlers", () => {
  it("lists chat providers with the expected contract shape and short cache", async () => {
    let execCalls = 0;
    const discover = {
      pathLookup: async (binary: string) =>
        ({ "claude-code-acp": "/bin/claude-code-acp", codex: "/bin/codex" })[binary] ?? null,
      exec: async (cmd: string) => {
        execCalls += 1;
        return { stdout: `${cmd} 1.0.0\n`, stderr: "", code: 0 };
      },
    };

    const first = await chatProvidersListHandler({}, { discover, now: () => 1_000 });
    const second = await chatProvidersListHandler({}, { discover, now: () => 1_500 });

    expect(first).toEqual(second);
    expect(execCalls).toBe(2);
    expect(ActionContractsZ["chat.providers.list"].result.safeParse(first).success).toBe(true);
    expect(first.providers.map((provider) => provider.kind)).toEqual(["claude-code", "codex"]);
  });

  it("leaves unexpected provider discovery failures for dispatcher internal mapping", async () => {
    const err = new Error("probe failed");

    try {
      await chatProvidersListHandler(
        {},
        {
          discover: {
            pathLookup: async () => {
              throw err;
            },
          },
        },
      );
      throw new Error("expected provider list to fail");
    } catch (caught) {
      expect(caught).toBe(err);
      expect(wrapInternalError(caught).code).toBe("internal");
    }
  });

  it("lists and creates chat threads", async () => {
    expect(await chatThreadListHandler({}, deps())).toEqual({ threads: [] });

    const result = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Chat", projectDir: "/tmp/project" },
      deps(),
    );

    expect(result.thread).toMatchObject({
      id: "id-1",
      title: "Chat",
      providerKind: "claude-code",
      projectDir: "/tmp/project",
    });
    expect(await chatThreadListHandler({}, deps())).toEqual({ threads: [result.thread] });
    expect(events.at(-1)).toMatchObject({ type: "chat.thread.index", threads: [result.thread] });
  });

  it("rejects invalid create input and schema-invalid send content", async () => {
    try {
      await chatThreadCreateHandler(
        { provider: { kind: "claude-code" }, projectDir: "relative/path" },
        deps(),
      );
      throw new Error("expected create to fail");
    } catch (err) {
      expectActionError(err, "bad_request");
    }

    expect(
      ActionContractsZ["chat.session.send"].input.safeParse({
        threadId: "thread-1",
        content: [{ type: "unknown" }],
      }).success,
    ).toBe(false);
  });

  it("gets, renames, and deletes existing threads", async () => {
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Original" },
      deps(),
    );

    const got = await chatThreadGetHandler({ id: created.thread.id }, deps());
    expect(got.thread.title).toBe("Original");

    const renamed = await chatThreadRenameHandler(
      { id: created.thread.id, title: "Renamed" },
      deps(),
    );
    expect(renamed.thread.title).toBe("Renamed");

    const deleted = await chatThreadDeleteHandler({ id: created.thread.id }, deps());
    expect(deleted).toEqual({ deleted: true });
    expect(await chatThreadListHandler({}, deps())).toEqual({ threads: [] });
    expect(events.filter((event) => event.type === "chat.thread.index")).toHaveLength(3);
  });

  it("returns the persisted chat thread usage snapshot", async () => {
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Usage" },
      deps(),
    );
    await store.recordUsage(created.thread.id, {
      inputTokens: 12,
      outputTokens: 3,
      totalCostUsd: 0.0042,
    });

    const result = await chatThreadUsageHandler({ id: created.thread.id }, deps());

    expect(result).toEqual({
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalCostUsd: 0.0042,
      },
    });
    expect(ActionContractsZ["chat.thread.usage"].result.safeParse(result).success).toBe(true);
  });

  it("swaps the thread provider in place and emits the updated index", async () => {
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Switcher" },
      deps(),
    );
    let disposed = 0;
    const trackingManager: ThreadManager = {
      ...manager,
      async disposeLive() {
        disposed += 1;
      },
    };

    const swapped = await chatThreadSetProviderHandler(
      { id: created.thread.id, provider: { kind: "codex" } },
      { ...deps(), manager: trackingManager },
    );

    expect(swapped.thread.providerKind).toBe("codex");
    expect(disposed).toBe(1);
    const state = await chatThreadGetHandler({ id: created.thread.id }, deps());
    expect(state.thread.provider).toEqual({ kind: "codex" });
    expect(state.thread.acpSessionId).toBeUndefined();
    expect(events.filter((event) => event.type === "chat.thread.index")).toHaveLength(2);
  });

  it("rejects setProvider on a missing thread", async () => {
    try {
      await chatThreadSetProviderHandler({ id: "missing", provider: { kind: "codex" } }, deps());
      throw new Error("expected setProvider to fail");
    } catch (err) {
      expectActionError(err, "thread_not_found");
    }
  });

  it("maps missing thread reads and blank rename to action errors", async () => {
    try {
      await chatThreadGetHandler({ id: "missing" }, deps());
      throw new Error("expected get to fail");
    } catch (err) {
      expectActionError(err, "thread_not_found");
    }

    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Original" },
      deps(),
    );
    try {
      await chatThreadRenameHandler({ id: created.thread.id, title: "   " }, deps());
      throw new Error("expected rename to fail");
    } catch (err) {
      expectActionError(err, "bad_request");
    }
  });

  it("sends and cancels chat sessions through the manager", async () => {
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "Chat" },
      deps(),
    );

    const sendResult = await chatSessionSendHandler(
      { threadId: created.thread.id, content: [{ type: "text", text: "hello" }] },
      deps(),
    );
    const cancelResult = await chatSessionCancelHandler({ threadId: created.thread.id }, deps());

    expect(sendResult).toEqual({ accepted: true, promptId: "prompt-1" });
    expect(cancelResult).toEqual({ cancelled: true });
    expect(sent).toEqual([
      { threadId: created.thread.id, content: [{ type: "text", text: "hello" }] },
    ]);
    expect(cancelled).toEqual([created.thread.id]);
  });

  it("responds to chat permissions through the manager", async () => {
    const result = await chatPermissionRespondHandler(
      { threadId: "thread-1", requestId: "request-1", optionId: "allow_once" },
      deps(),
    );

    expect(result).toEqual({ responded: true });
    expect(permissionResponses).toEqual([
      { threadId: "thread-1", requestId: "request-1", optionId: "allow_once" },
    ]);
  });

  it("maps permission response manager errors to action errors", async () => {
    const input = { threadId: "thread-1", requestId: "request-1", optionId: "allow_once" };

    for (const [err, code] of [
      [new ThreadNotFoundError(input.threadId), "thread_not_found"],
      [
        new PermissionRequestNotFoundError(input.threadId, input.requestId),
        "permission_request_not_found",
      ],
      [new InvalidPermissionOptionError(input.requestId, input.optionId), "bad_request"],
    ] as const) {
      const failingManager: ThreadManager = {
        ...manager,
        async respondPermission() {
          throw err;
        },
      };

      try {
        await chatPermissionRespondHandler(input, { ...deps(), manager: failingManager });
        throw new Error("expected permission response to fail");
      } catch (caught) {
        expectActionError(caught, code);
      }
    }
  });

  it("rejects schema-invalid permission response input", async () => {
    expect(
      ActionContractsZ["chat.permission.respond"].input.safeParse({
        threadId: "thread-1",
        requestId: "",
        optionId: "allow_once",
      }).success,
    ).toBe(false);
  });

  it("rejects send and cancel for missing threads", async () => {
    for (const run of [
      () =>
        chatSessionSendHandler(
          { threadId: "missing", content: [{ type: "text", text: "x" }] },
          deps(),
        ),
      () => chatSessionCancelHandler({ threadId: "missing" }, deps()),
    ]) {
      try {
        await run();
        throw new Error("expected handler to fail");
      } catch (err) {
        expectActionError(err, "thread_not_found");
      }
    }
  });
});
