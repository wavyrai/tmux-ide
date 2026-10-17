import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionTabs, type TabTarget } from "./session-tabs.ts";
const target = (key: string): TabTarget => ({
  key,
  identity: `machine/server/generation/${key}`,
  label: "Duplicate",
  hostLabel: "Host",
  serverLabel: "Server",
});
function fixture() {
  const owner = createSessionTabs();
  let unavailable = false;
  const resolve = (key: string) => (unavailable ? null : target(key));
  const pub = (request: number) => owner.publication(request, true, resolve)!;
  return {
    owner,
    resolve,
    pub,
    offline: () => {
      unavailable = true;
    },
  };
}
const command = (request: number, fromRequest: number, revision: number, action: string) => ({
  type: "session-tab" as const,
  request,
  fromRequest,
  revision,
  action,
});
test("eight identities retain order, active eviction protection and exact TUI cycle arithmetic", () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) assert.equal(f.owner.accept(i, target(String(i))), true);
  assert.deepEqual(f.owner.keys(), ["2", "3", "4", "5", "6", "7", "8", "9"]);
  let p = f.pub(9);
  assert.equal(p.rows.length, 8);
  assert.equal(new Set(p.rows.map((r) => r.id)).size, 8);
  assert.equal(p.next, p.rows[0]!.activate);
  assert.equal(p.previous, p.rows[6]!.activate);
  f.owner.navigation(10);
  p = f.pub(10);
  assert.equal(p.active, null);
  assert.equal(p.previous, p.rows[6]!.activate);
  assert.equal(p.closeActive, null);
});
test("unavailable and replaced admission preserves active; inactive close settles without navigation", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  f.owner.accept(2, target("b"));
  const p = f.pub(2);
  assert.equal(
    f.owner.admit(command(3, 2, p.revision, p.rows[0]!.activate), 2, true, (key) => ({
      ...target(key),
      identity: "replacement",
    })),
    null,
  );
  assert.equal(f.pub(2).active, p.active);
  assert.deepEqual(f.owner.admit(command(4, 2, p.revision, p.rows[0]!.close), 2, true, f.resolve), {
    kind: "close",
    key: "a",
    home: false,
  });
  assert.equal(f.pub(2).active, p.active);
  assert.equal(f.owner.accept(2, target("b")), false);
});
test("catalog helper retirement continuation commits only exact successful live target", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  f.owner.accept(2, target("b"));
  let p = f.pub(2);
  const action = f.owner.admit(command(3, 2, p.revision, p.rows[0]!.activate), 2, true, f.resolve);
  assert.equal(action?.key, "a");
  f.owner.navigation(3);
  p = f.pub(3);
  assert.equal(p.active, null);
  assert.equal(p.pending, p.rows[0]!.id);
  const catalog = {};
  f.owner.catalogReady(3, "a", catalog, 5);
  f.owner.navigation(4, { fromRequest: 3, key: "a", catalog, presence: 5 });
  assert.equal(f.owner.accept(4, target("wrong")), false);
  assert.equal(f.owner.accept(4, target("a")), true);
  assert.equal(f.pub(4).active, p.rows[0]!.id);
});
test("close pending cancels admission and late frames cannot resurrect closed target", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  f.owner.accept(2, target("b"));
  let p = f.pub(2);
  f.owner.admit(command(3, 2, p.revision, p.rows[0]!.activate), 2, true, f.resolve);
  f.owner.navigation(3);
  p = f.pub(3);
  assert.equal(
    f.owner.admit(command(4, 3, p.revision, p.rows[0]!.close), 3, true, f.resolve)?.home,
    true,
  );
  f.owner.navigation(4);
  assert.equal(f.owner.accept(3, target("a")), false);
  assert.equal(f.owner.accept(4, target("a")), false);
  assert.deepEqual(f.owner.keys(), ["b"]);
  assert.equal(f.pub(4).active, null);
});
test("replay, background and wrong catalog presence refuse without activating replacement", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  let p = f.pub(1);
  const c = command(2, 1, p.revision, p.rows[0]!.activate);
  assert.equal(f.owner.admit(c, 1, false, f.resolve), null);
  assert.equal(f.owner.admit(c, 1, true, f.resolve), null);
  f.owner.admit({ ...c, request: 3 }, 1, true, f.resolve);
  const catalog = {};
  f.owner.catalogReady(3, "a", catalog, 5);
  f.owner.navigation(4, { fromRequest: 3, key: "a", catalog, presence: 6 });
  assert.equal(f.owner.accept(3, target("a")), false);
  f.owner.cancel();
  f.owner.dispose();
  assert.equal(f.owner.accept(5, target("a")), false);
});
test("unread uses complete observed incarnation transition; gaps reset and failed activation retains unread", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  f.owner.accept(2, target("b"));
  const observe = (activity: string, identity = "incarnation") =>
    f.owner.observe("a", [{ identity, activity, attention: false }]);
  observe("complete");
  assert.equal(f.pub(2).rows[0]!.unread, false);
  observe("running");
  observe("complete", "replacement");
  assert.equal(f.pub(2).rows[0]!.unread, false);
  observe("running");
  f.owner.observe("a", null);
  observe("complete");
  assert.equal(f.pub(2).rows[0]!.unread, false);
  observe("running");
  observe("complete");
  let p = f.pub(2);
  assert.equal(p.rows[0]!.unread, true);
  assert.equal(
    f.owner.admit(command(3, 2, p.revision, p.rows[0]!.activate), 2, true, () => null),
    null,
  );
  assert.equal(f.pub(2).rows[0]!.unread, true);
  f.owner.accept(4, target("a"));
  assert.equal(f.pub(4).rows[0]!.unread, false);
});

test("captured close remains valid across presentation-only observation and availability refresh", () => {
  const f = fixture();
  f.owner.accept(1, target("a"));
  f.owner.accept(2, target("b"));
  let p = f.pub(2);
  f.owner.admit(command(3, 2, p.revision, p.rows[0]!.close), 2, true, f.resolve);
  p = f.pub(2);
  const close = command(4, 2, p.revision, p.rows[0]!.close);
  f.owner.observe("b", [{ identity: "agent", activity: "running", attention: false }]);
  let refreshed = f.pub(2);
  assert.equal(refreshed.rows[0]!.activity, "running");
  f.offline();
  refreshed = f.pub(2);
  assert.equal(refreshed.rows[0]!.available, false);
  assert.equal(f.owner.admit(close, 2, true, f.resolve)?.home, true);
});

test("verified recovery replaces stale route without duplicate tab or stale activation", () => {
  const owner = createSessionTabs();
  owner.accept(1, target("a"));
  const before = owner.publication(1, true, target)!;
  owner.cancel();
  assert.equal(owner.recover(1, "a", target("fresh")), true);
  const after = owner.publication(1, true, (key) => (key === "fresh" ? target(key) : null))!;
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0]!.id, before.rows[0]!.id);
  assert.equal(after.rows[0]!.available, true);
  assert.equal(after.active, before.active);
  assert.equal(
    owner.admit(command(2, 1, before.revision, before.rows[0]!.activate), 1, true, target),
    null,
  );
  owner.navigation(2);
  assert.equal(owner.recover(1, "fresh", target("stale")), false);
  assert.deepEqual(owner.keys(), ["fresh"]);
});
