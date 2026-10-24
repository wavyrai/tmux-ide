import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectHistory, type DirectHistoryResult } from "./direct-history.ts";
import { requestHistoryAnchor } from "../../../packages/daemon-client/src/tmux-server-client.ts";
const generation = "12d14eac-0000-4000-8000-000000000001";
const id = "12d14eac-0000-4000-8000-000000000002";
const token = "12d14eac-0000-4000-8000-000000000003";
const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private-owner-secret-sentinel",
  scope: { serverId: `tmux-server.${"a".repeat(32)}`, generation },
  workspaceName: "project",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "pane.one",
  visiblePaneIds: ["pane.one", "pane.two"],
};
const binding = { id, request: 7, config, origin: "tmux-ide://app", hostClientId: `gpui:${id}` };
const body = {
  version: 1,
  liveSessionId: config.liveSessionId,
  proof: {
    workspaceName: "project",
    semanticPaneId: "pane.one",
    generation,
    incarnation: "pane-incarnation",
    revision: 4,
    stateHash: "0000000000000004",
  },
  operation: { kind: "capture", historyIndex: 2 },
};
const response = {
  version: 1 as const,
  server: config.scope,
  result: { status: "captured" as const, token },
};
const command = (operationId = 1, input: unknown = body) => ({
  type: "native-history",
  version: 1,
  id,
  request: 7,
  operationId,
  body: JSON.stringify(input),
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("metadata broker sends exact scoped owner action and only bounded envelope to Rust", async () => {
  const events: DirectHistoryResult[] = [];
  let calls = 0;
  const broker = createDirectHistory(
    (e) => events.push(e),
    async (options, scope, input, signal) => {
      calls++;
      assert.equal(options.ownerToken, config.ownerToken);
      assert.equal(options.origin, binding.origin);
      assert.equal(options.hostClientId, binding.hostClientId);
      assert.equal(options.timeoutMs, 2000);
      assert.deepEqual(scope, config.scope);
      assert.deepEqual(input, body);
      assert.equal(signal?.aborted, false);
      return response;
    },
  );
  broker.bind(binding);
  assert.equal(await broker.handle(command()), true);
  assert.equal(calls, 1);
  assert.equal(events[0]?.status, "ok");
  if (events[0]?.status !== "ok") throw Error("result");
  assert.deepEqual(JSON.parse(events[0].body), response);
  assert(!JSON.stringify(events).includes(config.ownerToken));
  assert(!JSON.stringify(events).includes("rows"));
  assert.equal(await broker.handle(command()), false);
  assert.equal(calls, 1);
});
test("scope mismatch and invalid action rows never reach owner HTTP", async () => {
  const events: DirectHistoryResult[] = [];
  let calls = 0;
  const broker = createDirectHistory(
    (e) => events.push(e),
    async () => {
      calls++;
      return response;
    },
  );
  broker.bind(binding);
  assert.equal(await broker.handle({ ...command(), id: token }), false);
  assert.equal(await broker.handle({ ...command(), request: 8 }), false);
  await broker.handle(
    command(1, { ...body, proof: { ...body.proof, semanticPaneId: "unissued" } }),
  );
  await broker.handle(command(2, { ...body, proof: { ...body.proof, workspaceName: "wrong" } }));
  await broker.handle(command(3, { ...body, rows: [["secret"]] }));
  assert.equal(calls, 0);
  assert.equal(events.length, 3);
  assert(events.every((e) => e.status === "failed"));
});
test("retirement and replacement cancel pending work and discard late results", async () => {
  const events: DirectHistoryResult[] = [];
  const pending = deferred<typeof response>();
  let signal: AbortSignal | undefined;
  const broker = createDirectHistory(
    (e) => events.push(e),
    async (_o, _s, _i, s) => {
      signal = s;
      return pending.promise;
    },
  );
  broker.bind(binding);
  const running = broker.handle(command());
  broker.bind({ ...binding, id: token, request: 8 });
  assert.equal(signal?.aborted, true);
  pending.resolve(response);
  await running;
  assert.deepEqual(events, []);
  broker.retire();
  assert.equal(await broker.handle({ ...command(), id: token, request: 8 }), false);
});
test("superseded operation cannot overwrite newer result", async () => {
  const events: DirectHistoryResult[] = [];
  const old = deferred<typeof response>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const broker = createDirectHistory(
    (e) => events.push(e),
    async (_o, _s, _i, s) => {
      if (++calls === 1) {
        signal = s;
        return old.promise;
      }
      return response;
    },
  );
  broker.bind(binding);
  const running = broker.handle(command(1));
  await broker.handle(command(2));
  assert.equal(signal?.aborted, true);
  old.resolve(response);
  await running;
  assert.deepEqual(
    events.map((e) => e.operationId),
    [2],
  );
});
test("malformed response and thrown credential-bearing errors become safe failures", async () => {
  for (const read of [
    async () => {
      throw Error(config.ownerToken);
    },
    async () => undefined,
    async () => ({ ...response, rows: [["forbidden"]] }),
    async () => ({ ...response, server: { ...config.scope, generation: id } }),
  ]) {
    const events: DirectHistoryResult[] = [];
    const broker = createDirectHistory((e) => events.push(e), read as typeof requestHistoryAnchor);
    broker.bind(binding);
    await broker.handle(command());
    assert.deepEqual(events, [
      {
        type: "native-history-result",
        version: 1,
        id,
        request: 7,
        operationId: 1,
        status: "failed",
      },
    ]);
    assert(!JSON.stringify(events).includes(config.ownerToken));
  }
  const events: DirectHistoryResult[] = [];
  const broker = createDirectHistory(
    (e) => events.push(e),
    async () => null,
  );
  broker.bind(binding);
  await broker.handle(command());
  assert.equal(events[0]?.status, "unsupported");
});
test("existing HTTP helper authenticates exact endpoint and retirement reaches fetch abort", async () => {
  const events: DirectHistoryResult[] = [];
  const fetched = deferred<void>();
  let fetchSignal: AbortSignal | null | undefined;
  const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(url),
      `${config.baseUrl}api/v1/tmux-servers/${config.scope.serverId}/${generation}/history-anchor`,
    );
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${config.ownerToken}`);
    assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    fetchSignal = init?.signal;
    fetched.resolve();
    return await new Promise<Response>((_resolve, reject) =>
      fetchSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  }) as typeof fetch;
  const broker = createDirectHistory(
    (e) => events.push(e),
    (options, scope, input, signal) =>
      requestHistoryAnchor({ ...options, fetch: mockFetch }, scope, input, signal),
  );
  broker.bind(binding);
  const pending = broker.handle(command());
  await fetched.promise;
  broker.retire();
  await pending;
  assert.equal(fetchSignal?.aborted, true);
  assert.deepEqual(events, []);
});

test("resolve preserves identity-only proof and rejects a cross-pane resolved proof", async () => {
  const identity = {
    workspaceName: body.proof.workspaceName,
    semanticPaneId: body.proof.semanticPaneId,
    generation: body.proof.generation,
    incarnation: body.proof.incarnation,
  };
  const input = { ...body, proof: identity, operation: { kind: "resolve", token } };
  const events: DirectHistoryResult[] = [];
  let calls = 0;
  const broker = createDirectHistory(
    (e) => events.push(e),
    async (_options, _scope, request) => {
      assert.deepEqual(request, input);
      assert(!("revision" in request.proof));
      return {
        version: 1,
        server: config.scope,
        result: {
          status: "resolved",
          proof: { ...body.proof, semanticPaneId: ++calls === 1 ? "pane.one" : "pane.two" },
          historyIndex: 2,
        },
      };
    },
  );
  broker.bind(binding);
  await broker.handle(command(1, input));
  await broker.handle(command(2, input));
  assert.equal(events[0]?.status, "ok");
  assert.equal(events[1]?.status, "failed");
});

test("handoff scope binds history, advances request without reconnect, and cancels retired reads", async () => {
  const { createDirectTerminalHandoff } = await import("./direct-terminal-handoff.ts");
  type Event = DirectHistoryResult | import("./direct-terminal-handoff.ts").DirectTerminalEvent;
  const events: Event[] = [];
  const waiting = deferred<typeof response>();
  let pendingSignal: AbortSignal | undefined;
  let reads = 0;
  const send = (event: Event) => {
    events.push(event);
  };
  const history = createDirectHistory(send, async (_options, _scope, input, signal) => {
    if (++reads === 1) {
      pendingSignal = signal;
      return waiting.promise;
    }
    assert.equal(input.proof.semanticPaneId, "pane.two");
    return response;
  });
  const capability = {
    origin: binding.origin,
    hostClientId: binding.hostClientId,
    descriptor: { panes: config.visiblePaneIds },
  } as Awaited<ReturnType<typeof import("./direct-terminal.ts").issueDirectTerminal>>;
  let issues = 0;
  const handoff = createDirectTerminalHandoff(
    send,
    async () => {
      issues++;
      return capability;
    },
    (scope) => {
      if (scope) history.bind(scope);
      else history.retire();
    },
  );
  await handoff.open(config, 7);
  const open = events[0]!;
  assert.equal(open.type, "native-terminal-open");
  const old = history.handle({ ...command(), id: open.id });
  assert(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id: open.id,
      fromRequest: 7,
      request: 8,
      pane: "pane.two",
    }),
  );
  assert.equal(pendingSignal?.aborted, true);
  waiting.resolve(response);
  await old;
  assert.equal(events.length, 1);
  assert.equal(issues, 1);
  assert.equal(await history.handle({ ...command(2), id: open.id }), false);
  await history.handle({
    ...command(1, { ...body, proof: { ...body.proof, semanticPaneId: "pane.two" } }),
    id: open.id,
    request: 8,
  });
  assert.equal(events[1]?.type, "native-history-result");
  assert.equal(events[1]?.request, 8);
  handoff.retire();
  assert.equal(events[2]?.type, "native-terminal-close");
  assert.equal(events[2]?.request, 8);
  assert(!JSON.stringify(events).includes(config.ownerToken));
});

test("history scope uses issued pane set rather than a broader requested set", async () => {
  const { createDirectTerminalHandoff } = await import("./direct-terminal-handoff.ts");
  const events: DirectHistoryResult[] = [];
  let reads = 0;
  let issuedId = "";
  const history = createDirectHistory(
    (event) => events.push(event),
    async () => {
      reads++;
      return response;
    },
  );
  const capability = {
    origin: binding.origin,
    hostClientId: binding.hostClientId,
    descriptor: { panes: ["pane.one"] },
  } as Awaited<ReturnType<typeof import("./direct-terminal.ts").issueDirectTerminal>>;
  const handoff = createDirectTerminalHandoff(
    (event) => {
      issuedId = event.id;
    },
    async () => capability,
    (scope) => {
      if (scope) history.bind(scope);
      else history.retire();
    },
  );
  await handoff.open(config, 7);
  await history.handle({
    ...command(1, { ...body, proof: { ...body.proof, semanticPaneId: "pane.two" } }),
    id: issuedId,
  });
  assert.equal(reads, 0);
  assert.equal(events[0]?.status, "failed");
  handoff.retire();
});
