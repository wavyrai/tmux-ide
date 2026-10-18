import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createMouseOwner } from "./mouse.ts";
const base = blankTerminalReplicaSnapshot(80, 24);
const snapshot = {
  ...base,
  modes: { ...base.modes, mouseProtocol: "vt200" as const, mouseEncoding: "sgr" as const },
};
const event = (action: string, gesture = 1) => ({
  kind: "mouse",
  data: {
    action,
    gesture,
    row: 2,
    col: 4,
    button: 0,
    shift: false,
    alt: false,
    control: false,
    protocol: "vt200",
    encoding: "sgr",
    cols: 80,
    rows: 24,
  },
});
test("mouse requires an admitted down, consumes up, and refuses replay", () => {
  const owner = createMouseOwner();
  assert.equal(owner.route(snapshot, "attachment", event("up")), null);
  assert.deepEqual(owner.route(snapshot, "attachment", event("down")), {
    kind: "text",
    data: "\x1b[<0;5;3M",
  });
  assert.deepEqual(owner.route(snapshot, "attachment", event("up")), {
    kind: "text",
    data: "\x1b[<0;5;3m",
  });
  assert.equal(owner.route(snapshot, "attachment", event("up")), null);
  assert.equal(owner.route(snapshot, "attachment", event("down")), null);
});
test("cancel, mode, dimensions and attachment changes retire held gestures", () => {
  for (const change of ["cancel", "mode", "size", "attachment"]) {
    const owner = createMouseOwner();
    owner.route(snapshot, "a", event("down"));
    if (change === "cancel")
      owner.route(snapshot, "a", { kind: "mouse", data: { action: "cancel", gesture: 1 } });
    else
      owner.observe(
        change === "mode"
          ? { ...snapshot, modes: { ...snapshot.modes, mouseProtocol: "none" } }
          : change === "size"
            ? { ...snapshot, cols: 81 }
            : snapshot,
        change === "attachment" ? "b" : "a",
      );
    assert.equal(owner.route(snapshot, "a", event("up")), null);
  }
});
test("disabled, shifted, out of bounds and stale mode expectations never send", () => {
  for (const input of [
    { ...event("down"), data: { ...event("down").data, shift: true } },
    { ...event("down"), data: { ...event("down").data, col: 80 } },
    { ...event("down"), data: { ...event("down").data, protocol: "any" } },
  ])
    assert.equal(createMouseOwner().route(snapshot, "a", input), null);
  assert.equal(createMouseOwner().route(base, "a", event("down")), null);
});
test("encoding refusal never creates a held gesture and cancellation tombstones IDs", () => {
  const owner = createMouseOwner();
  const wide = {
    ...snapshot,
    cols: 2048,
    modes: { ...snapshot.modes, mouseEncoding: "utf8" as const },
  };
  const e = (action: string, gesture: number, col: number) => ({
    kind: "mouse",
    data: { ...event(action, gesture).data, encoding: "utf8", cols: 2048, col },
  });
  assert.equal(owner.route(wide, "a", e("down", 1, 2047)), null);
  assert.equal(owner.route(wide, "a", e("up", 1, 1)), null);
  assert.ok(owner.route(wide, "a", e("down", 2, 1)));
  owner.route(wide, "a", { kind: "mouse", data: { action: "cancel", gesture: 3 } });
  assert.equal(owner.route(wide, "a", e("down", 3, 1)), null);
});
test("X10 retires release without bytes; ordinary content changes preserve gestures", () => {
  const owner = createMouseOwner();
  const x10 = { ...snapshot, modes: { ...snapshot.modes, mouseProtocol: "x10" as const } };
  const e = (action: string, gesture: number) => ({
    kind: "mouse",
    data: { ...event(action, gesture).data, protocol: "x10" },
  });
  assert.ok(owner.route(x10, "a", e("down", 1)));
  owner.observe({ ...x10, cursor: { ...x10.cursor, x: 4 } }, "a");
  assert.equal(owner.route(x10, "a", e("up", 1)), null);
  assert.ok(owner.route(x10, "a", e("down", 2)));
});
test("drag and hover follow canonical protocol, buttons and monotonic hover IDs", () => {
  const owner = createMouseOwner();
  const any = { ...snapshot, modes: { ...snapshot.modes, mouseProtocol: "any" as const } };
  const e = (action: string, gesture: number, button: number | null = 0) => ({
    kind: "mouse",
    data: { ...event(action, gesture).data, protocol: "any", button },
  });
  assert.deepEqual(owner.route(any, "a", e("move", 1, null)), {
    kind: "text",
    data: "\x1b[<35;5;3M",
  });
  assert.equal(owner.route(any, "a", e("move", 1, null)), null);
  assert.ok(owner.route(any, "a", e("down", 2, 2)));
  assert.equal(owner.route(any, "a", e("up", 2, 1)), null);
  assert.deepEqual(owner.route(any, "a", e("drag", 2, 2)), { kind: "text", data: "\x1b[<34;5;3M" });
  assert.deepEqual(owner.route(any, "a", e("up", 2, 2)), { kind: "text", data: "\x1b[<2;5;3m" });
  assert.equal(owner.route(any, "a", e("move", 2, null)), null);
});
