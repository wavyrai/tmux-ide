import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDirectSplitLayout, type SplitLayoutResult } from "./direct-split-layout.ts";
const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private-owner",
  scope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() },
  workspaceName: "workspace",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "pane",
};
const binding = {
  id: randomUUID(),
  request: 1,
  config,
  origin: "tmux-ide://app",
  hostClientId: `gpui:${randomUUID()}`,
};
const window = {
  liveSessionId: config.liveSessionId,
  linkId: `window-link.${"c".repeat(32)}`,
  expectedSemanticWindowId: "window",
  linkRevision: 1,
};
const command = {
  type: "native-split-layout",
  version: 1,
  id: binding.id,
  request: 1,
  sequence: 1,
  window,
};
const resource = {
  version: 1,
  window,
  layoutId: randomUUID(),
  cols: 80,
  rows: 24,
  panes: [{ semanticPaneId: "pane", left: 0, top: 0, width: 80, height: 24 }],
  splits: [],
};
test("reads exact window and server, never creates a subscription or retries", async () => {
  const events: SplitLayoutResult[] = [];
  let calls = 0;
  const reader = createDirectSplitLayout((e) => events.push(e), (async (url, init) => {
    calls++;
    assert.ok(String(url).includes("/split-layout/workspace"));
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer private-owner");
    assert.deepEqual(JSON.parse(String(init?.body)), window);
    return Response.json({ version: 1, server: config.scope, resource });
  }) as typeof fetch);
  reader.bind(binding);
  assert.equal(await reader.handle(command), true);
  assert.equal(await reader.handle(command), false);
  assert.equal(calls, 1);
  assert.equal(events[0].status, "ok");
  assert.ok(!JSON.stringify(events).includes(config.ownerToken));
});
test("scope mismatch and read-only catalog never dispatch", async () => {
  let calls = 0;
  const reader = createDirectSplitLayout(() => {}, (async () => {
    calls++;
    throw Error("unexpected");
  }) as typeof fetch);
  reader.bind(binding);
  assert.equal(
    await reader.handle({
      ...command,
      window: { ...window, liveSessionId: `live-session.${"d".repeat(20)}` },
    }),
    false,
  );
  reader.bind({ ...binding, catalogOnly: true });
  assert.equal(await reader.handle(command), false);
  assert.equal(calls, 0);
});
test("navigation abort suppresses even successful late metadata", async () => {
  const events: SplitLayoutResult[] = [];
  let finish!: (value: Response) => void;
  let signal: AbortSignal | undefined;
  const reader = createDirectSplitLayout((e) => events.push(e), (async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch);
  reader.bind(binding);
  const pending = reader.handle(command);
  reader.retire();
  assert.ok(signal?.aborted);
  finish(Response.json({ version: 1, server: config.scope, resource }));
  await pending;
  assert.equal(events.length, 0);
});
