import { expect, it } from "vitest";
import {
  decodeNativeAtomicSnapshot,
  nativeAtomicSnapshotPlan,
  NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES,
} from "./native-atomic-snapshot.ts";
const target = {
  serverEpoch: "00000000-0000-4000-8000-000000000001",
  paneId: "%0",
  paneBirthId: "1",
};
const modes = "1 0 2 1 0 1 0 0 0 0 0 0 0 1 0 2000 0 0 0 0 0 0 on";
function records() {
  return [
    { ...target, snapshotVersion: 1, cursor: modes, resumed: true },
    {
      version: 2,
      cols: 2,
      rows: 1,
      history: 0,
      hscrolled: 0,
      limit: 2000,
      cursor: [1, 0],
      currentAttributes: [0, 8, 8, 8],
    },
    { row: 0, flags: 0, used: 1, cells: [[0, 1, "41", 0, 8, 8, 8, 0, 0]] },
  ];
}
function reply(value: unknown[] = records()) {
  return { ok: true, lines: [...value.map((row) => JSON.stringify(row)), "%continue %0"] };
}
it("builds one full-history guarded child and preserves exact valid native backing", () => {
  const plan = nativeAtomicSnapshotPlan(target);
  expect(plan.commands).toEqual([
    [
      "capture-pane",
      "-p",
      "-R",
      "-Q",
      "-U",
      String(NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES - "%continue %0\n".length),
      "-S",
      "-",
      "-t",
      "%0",
    ],
  ]);
  expect(plan.resultIndex).toBe(0);
  const decoded = decodeNativeAtomicSnapshot(reply(), target);
  expect(decoded).toMatchObject({
    status: "ok",
    cursorLine: modes,
    target,
    capture: { version: 2, cursor: [1, 0] },
  });
  if (decoded.status === "ok") expect(decoded.capture.grid[0]!.cells[0]!.text).toBe("A");
});
it("counts the metadata and every terminating newline in the byte budget", () => {
  const value = reply();
  const length = value.lines.reduce((sum, line) => sum + line.length + 1, 0);
  expect(decodeNativeAtomicSnapshot(value, target, length).status).toBe("ok");
  expect(decodeNativeAtomicSnapshot(value, target, length - 1)).toEqual({ status: "unknown" });
});
it.each([
  { serverEpoch: "00000000-0000-4000-8000-000000000002" },
  { paneId: "%1" },
  { paneBirthId: "2" },
  { paneBirthId: "0" },
  { paneBirthId: "18446744073709551616" },
  { snapshotVersion: 2 },
  { resumed: false },
  { extra: true },
  { cursor: modes + " 0" },
  { cursor: modes.replace("1 0 2", "1  0 2") },
  { cursor: modes.replace("1 0 2", "1 0 3") },
  { cursor: modes.replace("0 2000", "1 2000") },
  { cursor: modes.replace("0 2000", "0 1999") },
  { cursor: modes.replace("0 1 0 0", "2 1 0 0") },
  { cursor: modes.replace(/on$/, "maybe") },
  { cursor: modes.replace(/0 0 on$/, "0 1 on") },
])("retains unknown on incompatible metadata %j", (patch) => {
  const value = records();
  value[0] = { ...value[0], ...patch };
  expect(decodeNativeAtomicSnapshot(reply(value), target)).toEqual({ status: "unknown" });
});
it("rejects incomplete, old-version and malformed grid without claiming unsupported", () => {
  for (const patch of [{ version: 1 }, { currentAttributes: null }, { history: 1 }]) {
    const value = records();
    value[1] = { ...value[1], ...patch };
    expect(decodeNativeAtomicSnapshot(reply(value), target)).toEqual({ status: "unknown" });
  }
  expect(decodeNativeAtomicSnapshot({ ok: false, lines: [] }, target)).toEqual({
    status: "unknown",
  });
  expect(decodeNativeAtomicSnapshot({ ok: true, lines: ["bad", "bad", "bad"] }, target)).toEqual({
    status: "unknown",
  });
  expect(decodeNativeAtomicSnapshot(reply([...records(), { unexpected: true }]), target)).toEqual({
    status: "unknown",
  });
});
it("preserves explicit unknown optional modes and legal offscreen cursor", () => {
  const value = records();
  const fields = modes.split(" ");
  fields[0] = "7";
  fields[4] = "unknown";
  fields[22] = "unknown";
  value[0] = { ...value[0], cursor: fields.join(" ") };
  value[1] = { ...value[1], cursor: [7, 0] };
  expect(decodeNativeAtomicSnapshot(reply(value), target).status).toBe("ok");
});
it.each([0, -1, Infinity, 1.5, NATIVE_ATOMIC_SNAPSHOT_MAX_BYTES + 1])(
  "refuses invalid budgets %s before dispatch",
  (limit) => {
    expect(() => nativeAtomicSnapshotPlan(target, limit)).toThrow();
    expect(decodeNativeAtomicSnapshot(reply(), target, limit).status).toBe("unknown");
  },
);

it.each(["0", "1", "on", "off", "unknown"])("accepts explicit scroll-on-clear form %s", (mode) => {
  const value = records();
  value[0] = { ...value[0], cursor: modes.replace(/on$/, mode) };
  expect(decodeNativeAtomicSnapshot(reply(value), target).status).toBe("ok");
});

it("requires a single exact terminal inline continue after the full snapshot", () => {
  const good = reply();
  for (const lines of [
    good.lines.slice(0, -1),
    [...good.lines.slice(0, -1), "%continue %1"],
    [...good.lines, "%continue %0"],
    ["%continue %0", ...good.lines.slice(0, -1)],
  ])
    expect(decodeNativeAtomicSnapshot({ ok: true, lines }, target).status).toBe("unknown");
});
it("reads only the newest history rows a bounded first open asks for (#873)", () => {
  const plan = nativeAtomicSnapshotPlan(target, undefined, 2_144);
  expect(plan.commands[0]!.slice(-4)).toEqual(["-S", "-2144", "-t", "%0"]);
  expect(nativeAtomicSnapshotPlan(target, undefined, 0).commands[0]!.slice(-4)).toEqual([
    "-S",
    "-0",
    "-t",
    "%0",
  ]);
  for (const rows of [-1, 1.5, 1_000_001, Number.NaN])
    expect(() => nativeAtomicSnapshotPlan(target, undefined, rows)).toThrow(TypeError);
});
it("decodes a tail capture when the cursor's history size counts the rows left out (#873)", () => {
  // tmux holds 3 history rows; the capture read the newest one (row 2).
  const tail = (historySize: number) => {
    const fields = modes.split(" ");
    fields[14] = String(historySize);
    const value = records();
    value[0] = { ...target, snapshotVersion: 1, cursor: fields.join(" "), resumed: true };
    value[1] = { ...(value[1] as object), history: 3 };
    value[2] = { row: 2, flags: 0, used: 1, cells: [[0, 1, "41", 0, 8, 8, 8, 0, 0]] };
    value.push({ row: 3, flags: 0, used: 1, cells: [[0, 1, "42", 0, 8, 8, 8, 0, 0]] });
    return reply(value);
  };
  const decoded = decodeNativeAtomicSnapshot(tail(3), target);
  expect(decoded).toMatchObject({ status: "ok", capture: { history: 1, omittedHistory: 2 } });
  // A history size that does not count the left-out rows is not this capture.
  expect(decodeNativeAtomicSnapshot(tail(1), target)).toEqual({ status: "unknown" });
});
