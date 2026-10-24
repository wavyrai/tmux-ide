import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDirectOwnerActions, type OwnerActionResult } from "./direct-owner-actions.ts";
const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private-owner-sentinel",
  scope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() },
  workspaceName: "workspace",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "source",
};
const binding = () => ({
  id: randomUUID(),
  request: 3,
  config,
  origin: "tmux-ide://app",
  hostClientId: `gpui:${randomUUID()}`,
});
const command = (b: ReturnType<typeof binding>) => ({
  type: "native-owner-action",
  version: 1,
  id: b.id,
  request: b.request,
  sequence: 1,
  operationId: randomUUID(),
  liveSessionId: config.liveSessionId,
  generation: config.scope.generation,
  pane: "source",
  action: "new-window",
});
function receipt(body: any) {
  return {
    operationId: body.operationId,
    daemonInstanceId: config.scope.generation,
    outcome: "created",
    resource: {
      resourceVersion: 1,
      workspaceName: "workspace",
      semanticPaneId: "created",
      displayTitle: body.intent.displayTitle ?? "Terminal",
      kind: body.intent.kind,
      harnessProfileId: body.intent.harnessProfileId ?? null,
      role: body.intent.role ?? null,
      missionId: null,
    },
  };
}
test("native owner uses exact scoped authenticated HTTP once and keeps secrets out of results", async () => {
  const events: OwnerActionResult[] = [];
  let calls = 0;
  const owner = createDirectOwnerActions((e) => events.push(e), (async (url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${config.ownerToken}`);
    assert.equal(init?.redirect, "error");
    assert.ok(String(url).includes(`/panes/create?liveSessionId=${config.liveSessionId}`));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.expectedDaemonInstanceId, config.scope.generation);
    assert.deepEqual(body.intent, {
      workspaceName: "workspace",
      kind: "terminal",
      placement: { kind: "window" },
    });
    return Response.json(receipt(body));
  }) as typeof fetch);
  const b = binding();
  owner.bind(b);
  const c = command(b);
  assert.equal(await owner.handle(c), true);
  assert.equal(await owner.handle(c), false);
  assert.equal(await owner.handle({ ...c, sequence: 2 }), false);
  assert.equal(calls, 1);
  assert.equal(events[0].status, "created");
  assert.ok(!JSON.stringify(events).includes(config.ownerToken));
});
test("new agent preserves typed harness creation fields", async () => {
  const owner = createDirectOwnerActions(() => {}, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.intent, {
      workspaceName: "workspace",
      kind: "agent",
      displayTitle: "Agent",
      harnessProfileId: "codex",
      role: "implementer",
      placement: { kind: "window" },
    });
    return Response.json(receipt(body));
  }) as typeof fetch);
  const b = binding();
  owner.bind(b);
  assert.equal(
    await owner.handle({ ...command(b), action: "new-agent", name: "Agent", harness: "codex" }),
    true,
  );
});
test("stale scope and unknown fields do not dispatch", async () => {
  let calls = 0;
  const owner = createDirectOwnerActions(() => {}, (async () => {
    calls++;
    throw Error("unexpected");
  }) as typeof fetch);
  const b = binding();
  owner.bind(b);
  for (const patch of [
    { request: 2 },
    { id: randomUUID() },
    { generation: randomUUID() },
    { liveSessionId: "other" },
    { pane: "other" },
    { ownerToken: "untrusted" },
  ])
    assert.equal(await owner.handle({ ...command(b), ...patch }), false);
  assert.equal(calls, 0);
});
test("one pending mutation, navigation abort, and late completion cannot publish", async () => {
  const events: OwnerActionResult[] = [];
  let finish!: (r: Response) => void;
  let body: any;
  let signal: AbortSignal | undefined;
  const owner = createDirectOwnerActions((e) => events.push(e), (async (_url, init) => {
    body = JSON.parse(String(init?.body));
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch);
  const b = binding();
  owner.bind(b);
  const pending = owner.handle(command(b));
  assert.ok(owner.busy());
  await owner.handle({ ...command(b), sequence: 2 });
  assert.equal(events[0].status, "busy");
  owner.retire();
  assert.ok(signal?.aborted);
  finish(Response.json(receipt(body)));
  await pending;
  assert.equal(events.length, 1);
});
test("wrong receipt or remote failure publishes only a redacted failed status", async () => {
  for (const fail of [false, true]) {
    const events: OwnerActionResult[] = [];
    const owner = createDirectOwnerActions((e) => events.push(e), (async (_url, init) => {
      if (fail) throw Error(config.ownerToken);
      return Response.json({
        ...receipt(JSON.parse(String(init?.body))),
        daemonInstanceId: randomUUID(),
      });
    }) as typeof fetch);
    const b = binding();
    owner.bind(b);
    await owner.handle(command(b));
    assert.equal(events[0].status, "failed");
    assert.ok(!JSON.stringify(events).includes(config.ownerToken));
  }
});

test("read-only catalog binding never authorizes an owner mutation", async () => {
  let calls = 0;
  const owner = createDirectOwnerActions(() => {}, (async () => {
    calls++;
    throw Error("unexpected");
  }) as typeof fetch);
  const b = binding();
  owner.bind({ ...b, catalogOnly: true });
  assert.equal(await owner.handle(command(b)), false);
  assert.equal(calls, 0);
});
