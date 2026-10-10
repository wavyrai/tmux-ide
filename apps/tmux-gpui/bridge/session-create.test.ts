import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionOwner, sessionCreateSchema } from "./session-create.ts";

test("initial zero request and canonical name validation", () => {
  assert.equal(
    sessionCreateSchema.parse({ type: "create-session", request: 0, name: "  Work  " }).name,
    "Work",
  );
  for (const name of ["", "-option", "bad\nname", "😀".repeat(51)])
    assert.equal(
      sessionCreateSchema.safeParse({ type: "create-session", request: 0, name }).success,
      false,
    );
});
test("one pending operation survives reset and stale completion never refreshes", async () => {
  const owner = createSessionOwner();
  let current = true,
    calls = 0,
    refreshes = 0;
  let finish!: () => void;
  const held = new Promise<void>((r) => {
    finish = r;
  });
  const input = {
    name: "test",
    current: () => current,
    create: async (id: string) => {
      assert.match(id, /^[0-9a-f-]{36}$/);
      calls++;
      await held;
    },
    refresh: async () => {
      refreshes++;
    },
    changed: () => {},
  };
  const first = owner.start(input);
  assert.equal(owner.publication().phase, "pending");
  owner.reset();
  assert.equal(owner.start(input), undefined);
  current = false;
  finish();
  await first;
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
  assert.equal(owner.publication().phase, "idle");
});
test("creation or refresh failure stays blocked until explicit reset without leaking errors", async () => {
  for (const stage of ["create", "refresh"]) {
    const owner = createSessionOwner();
    let calls = 0;
    const input = {
      name: "test",
      current: () => true,
      create: async () => {
        calls++;
        if (stage === "create") throw Error("SECRET");
      },
      refresh: async () => {
        throw Error("SECRET");
      },
      changed: () => {},
    };
    await owner.start(input);
    assert.equal(owner.publication().phase, "failed");
    assert.ok(!JSON.stringify(owner.publication()).includes("SECRET"));
    assert.equal(owner.start(input), undefined);
    assert.equal(calls, 1);
    owner.reset();
    assert.deepEqual(owner.publication(), { phase: "idle", error: null, revision: 1 });
  }
});

test("completion revision witnesses fast success even if pending is coalesced", async () => {
  const owner = createSessionOwner();
  const initial = owner.publication().revision;
  const input = {
    name: "test",
    current: () => true,
    create: async () => {},
    refresh: async () => {},
    changed: () => {},
  };
  await owner.start(input);
  assert.equal(owner.publication().phase, "idle");
  assert.equal(owner.publication().revision, initial + 1);
  await owner.start(input);
  assert.equal(owner.publication().revision, initial + 2);
});
