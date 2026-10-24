import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDirectTerminalHandoff,
  nativePaneSelectedSchema,
  type DirectTerminalEvent,
} from "./direct-terminal-handoff.ts";
import type { issueDirectTerminal } from "./direct-terminal.ts";

type Config = Parameters<typeof issueDirectTerminal>[0];
type Capability = Awaited<ReturnType<typeof issueDirectTerminal>>;
const config = { liveSessionId: "live-session.test" } as Config;
const capability = {
  selectedPane: "pane.test",
  descriptor: { panes: ["pane.test", "pane.other"] },
} as Capability;

test("retired and replaced issuance cannot open a stale native connection", async () => {
  const events: DirectTerminalEvent[] = [];
  const pending: { resolve: (v: Capability) => void; signal: AbortSignal }[] = [];
  const issue: typeof issueDirectTerminal = async (_config, _mode, signal) =>
    new Promise((resolve) => pending.push({ resolve, signal }));
  const handoff = createDirectTerminalHandoff((event) => events.push(event), issue);
  const first = handoff.open(config, 1);
  const second = handoff.open(config, 2);
  assert(pending[0]!.signal.aborted);
  pending[0]!.resolve(capability);
  await first;
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "native-terminal-close");
  pending[1]!.resolve(capability);
  await second;
  assert.equal(events[1]!.type, "native-terminal-open");
  assert.equal(events[1]!.request, 2);
  handoff.retire();
  handoff.retire();
  assert.equal(events.length, 3);
  assert.equal(events[2]!.id, events[1]!.id);
});
test("failed ordered write retires the capability and exposes no source details", async () => {
  const events: DirectTerminalEvent[] = [];
  const handoff = createDirectTerminalHandoff(
    (event) => {
      events.push(event);
      if (event.type === "native-terminal-open") throw new Error("secret-reflection");
    },
    async () => capability,
  );
  await assert.rejects(handoff.open(config, 1), /^Error: Native terminal capability unavailable$/);
  assert.deepEqual(
    events.map((e) => e.type),
    ["native-terminal-open", "native-terminal-close"],
  );
});
test("invalid request never issues and cancellation suppresses late failure", async () => {
  let reject: (error: Error) => void = () => {};
  let calls = 0;
  const handoff = createDirectTerminalHandoff(
    () => {},
    async () => {
      calls++;
      return new Promise((_resolve, r) => {
        reject = r;
      });
    },
  );
  await assert.rejects(handoff.open(config, NaN));
  assert.equal(calls, 0);
  const open = handoff.open(config, 1);
  handoff.retire();
  reject(new Error("secret"));
  await open;
});

test("native selection advances only metadata and close uses the new request", async () => {
  const events: DirectTerminalEvent[] = [];
  let issues = 0;
  const handoff = createDirectTerminalHandoff(
    (event) => events.push(event),
    async () => {
      issues++;
      return capability;
    },
  );
  await handoff.open(config, 4);
  const id = events[0]!.id;
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id,
      fromRequest: 4,
      request: 5,
      pane: "pane.other",
    }),
    true,
  );
  assert.equal(events.length, 1);
  assert.equal(issues, 1);
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id,
      fromRequest: 5,
      request: 7,
      pane: "pane.test",
    }),
    true,
  );
  handoff.retire();
  assert.deepEqual(events[1], { type: "native-terminal-close", version: 1, id, request: 7 });
});
test("native selection rejects stale scope, unissued pane and malformed fields atomically", async () => {
  const events: DirectTerminalEvent[] = [];
  const handoff = createDirectTerminalHandoff(
    (event) => events.push(event),
    async () => capability,
  );
  await handoff.open(config, 4);
  const id = events[0]!.id;
  const command = {
    type: "native-pane-selected",
    id,
    fromRequest: 4,
    request: 5,
    pane: "pane.other",
  };
  for (const patch of [
    { id: "00000000-0000-4000-8000-000000000000" },
    { fromRequest: 3 },
    { request: 4 },
    { request: Number.MAX_SAFE_INTEGER + 1 },
    { pane: "pane.unissued" },
    { pane: "__proto__" },
    { pane: "terminal.discovered.fake" },
    { extra: true },
    { id: "bad" },
  ])
    assert.equal(handoff.advanceSelection({ ...command, ...patch }), false);
  assert.equal(handoff.advanceSelection(command), true);
  assert.equal(handoff.advanceSelection(command), false);
  handoff.retire();
  assert.equal(events.at(-1)!.request, 5);
  assert.equal(handoff.advanceSelection({ ...command, fromRequest: 5, request: 6 }), false);
});
test("selection cannot advance pending or replaced issuance", async () => {
  const events: DirectTerminalEvent[] = [];
  let resolve!: (capability: Capability) => void;
  let issues = 0;
  const handoff = createDirectTerminalHandoff(
    (event) => events.push(event),
    async () => {
      if (++issues === 1) return capability;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  await handoff.open(config, 1);
  const oldId = events[0]!.id;
  const opening = handoff.open(config, 3);
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id: oldId,
      fromRequest: 1,
      request: 4,
      pane: "pane.other",
    }),
    false,
  );
  resolve(capability);
  await opening;
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id: oldId,
      fromRequest: 1,
      request: 4,
      pane: "pane.other",
    }),
    false,
  );
  handoff.retire();
  assert.equal(events.at(-1)!.request, 3);
});
test("native selected schema has exact finite request and semantic pane bounds", () => {
  const valid = {
    type: "native-pane-selected",
    id: "00000000-0000-4000-8000-000000000000",
    fromRequest: 0,
    request: 1,
    pane: "pane.test",
  };
  assert(nativePaneSelectedSchema.safeParse(valid).success);
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert(!nativePaneSelectedSchema.safeParse({ ...valid, request: value }).success);
    assert(!nativePaneSelectedSchema.safeParse({ ...valid, fromRequest: value }).success);
  }
});

test("catalog handoff requests read-only capability and carries its explicit mode", async () => {
  const events: DirectTerminalEvent[] = [];
  const handoff = createDirectTerminalHandoff(
    (event) => events.push(event),
    async (_config, mode) => {
      assert.equal(mode, "read-only");
      return capability;
    },
  );
  await handoff.open(config, 5, true);
  assert.equal(events[0].type, "native-terminal-open");
  if (events[0].type === "native-terminal-open")
    assert.equal(events[0].capability.catalogOnly, true);
});

test("refused same-pane navigation advances scope before a later successful selection", async () => {
  const events: DirectTerminalEvent[] = [];
  const scopes: { request: number; pane: string }[] = [];
  let issues = 0;
  const handoff = createDirectTerminalHandoff(
    (event) => events.push(event),
    async () => {
      issues++;
      return capability;
    },
    (scope) => {
      if (scope) scopes.push({ request: scope.request, pane: scope.config.semanticPaneId });
    },
  );
  await handoff.open({ ...config, semanticPaneId: "pane.test" }, 3);
  const id = events[0]!.id;
  // Rust refused the attempted pane.other navigation and reports the unchanged pane.
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id,
      fromRequest: 3,
      request: 4,
      pane: "pane.test",
    }),
    true,
  );
  assert.deepEqual(scopes, [
    { request: 3, pane: "pane.test" },
    { request: 4, pane: "pane.test" },
  ]);
  // The old request is fenced even though the pane identity did not change.
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id,
      fromRequest: 3,
      request: 5,
      pane: "pane.other",
    }),
    false,
  );
  assert.equal(scopes.length, 2);
  assert.equal(
    handoff.advanceSelection({
      type: "native-pane-selected",
      id,
      fromRequest: 4,
      request: 5,
      pane: "pane.other",
    }),
    true,
  );
  assert.deepEqual(scopes.at(-1), { request: 5, pane: "pane.other" });
  assert.equal(issues, 1);
  assert.equal(events.length, 1);
  handoff.retire();
  assert.deepEqual(events[1], { type: "native-terminal-close", version: 1, id, request: 5 });
});
