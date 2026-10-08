import { describe, expect, it, vi } from "vitest";
import {
  TerminalReplicaCellSchemaZ,
  TerminalSemanticDeliveryPayloadSchemaZ,
  type TerminalSemanticDeliveryPayload,
} from "@tmux-ide/contracts";
import {
  encodeCompactSemanticTerminalUpdate as encode,
  decodeCompactSemanticTerminalUpdate as decode,
} from "./terminal-delivery.ts";
import {
  TERMINAL_REPLICA_EMPTY_CELL,
  freezeOwnedTerminalReplicaRow,
  createOwnedTerminalReplicaRowBuilder,
} from "./terminal-replica-owned-row.ts";

// These controls deliberately violate nested wire types and install accessors.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaultInput = any;

import { blankTerminalReplicaSnapshot } from "./terminal-replica.ts";

const row = () => ({
  cells: Array.from({ length: 12 }, () => ({
    grapheme: "X",
    width: 1 as const,
    foreground: { kind: "default" as const },
    background: { kind: "default" as const },
    attributes: 0,
  })),
  wrapped: false,
});
const payload = () => ({
  frame: "patch" as const,
  baseRevision: 1,
  revision: 2,
  patch: {
    rows: [{ index: 0, row: freezeOwnedTerminalReplicaRow(row()) }],
    history: [freezeOwnedTerminalReplicaRow(row())],
    historyDelta: { trim: 0, append: [freezeOwnedTerminalReplicaRow(row())] },
  },
});
const issues = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { issues: unknown }).issues;
  }
};
describe("owned patch row validation reuse", () => {
  it("strictly admits each owned row once across rows/history/delta and preserves exact bytes", () => {
    for (const shape of ["history", "historyDelta"] as const) {
      const p: FaultInput = payload();
      delete p.patch[shape];
      const reference = encode(structuredClone(p));
      const spy = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
      try {
        expect(encode(p)).toEqual(reference);
        expect(spy).toHaveBeenCalledTimes(24);
        spy.mockClear();
        expect(encode(p)).toEqual(reference);
        expect(spy).toHaveBeenCalledTimes(0);
        expect(decode(reference)).toEqual(TerminalSemanticDeliveryPayloadSchemaZ.parse(p));
      } finally {
        spy.mockRestore();
      }
    }
  });
  it("shares successful seed validation but never treats frozen foreign rows as owned", () => {
    const owned = freezeOwnedTerminalReplicaRow(row());
    const snapshot = { ...blankTerminalReplicaSnapshot(12, 1), grid: [owned] };
    encode({ frame: "seed", revision: 1, snapshot });
    const patch = {
      frame: "patch" as const,
      baseRevision: 1,
      revision: 2,
      patch: { rows: [{ index: 0, row: owned }] },
    };
    const frozen = Object.freeze(structuredClone(owned));
    const spy = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
    try {
      encode(patch);
      expect(spy).toHaveBeenCalledTimes(0);
      for (let i = 0; i < 2; i++) {
        spy.mockClear();
        encode({ ...patch, patch: { rows: [{ index: 0, row: frozen }] } });
        expect(spy).toHaveBeenCalledTimes(12);
      }
    } finally {
      spy.mockRestore();
    }
  });
  it("rejects owned row header extras and malformed wrapped values without changing strict issues", () => {
    const builder = createOwnedTerminalReplicaRowBuilder();
    for (const cell of row().cells) builder.append(cell);
    const extra = builder.finish({ ...row(), extra: 1 } as ReturnType<typeof row>, false);
    const wrapped = freezeOwnedTerminalReplicaRow({ ...row(), wrapped: 4 as unknown as boolean });
    for (const bad of [extra, wrapped]) {
      const p: FaultInput = payload();
      p.patch.history = [bad];
      p.revision = 1;
      const expected = issues(() => TerminalSemanticDeliveryPayloadSchemaZ.parse(p));
      expect(expected).not.toBeNull();
      expect(issues(() => encode(p))).toEqual(expected);
      expect(issues(() => encode(p))).toEqual(expected);
    }
  });
  it("strictly validates only nontrusted cells on fresh mostly-blank owned rows", () => {
    // Warm only the immutable pair, not either distinct row used below.
    const make = () => ({
      frame: "patch" as const,
      baseRevision: 1,
      revision: 2,
      patch: {
        rows: [
          {
            index: 0,
            row: freezeOwnedTerminalReplicaRow({
              wrapped: false,
              cells: [
                row().cells[0]!,
                ...Array.from({ length: 11 }, () => TERMINAL_REPLICA_EMPTY_CELL),
              ],
            }),
          },
        ],
      },
    });
    encode(make());
    const p = make(),
      expected = encode(structuredClone(p));
    const spy = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
    try {
      expect(encode(p)).toEqual(expected);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect(encode(p)).toEqual(expected);
      expect(spy).toHaveBeenCalledTimes(0);
      spy.mockClear();
      expect(encode(structuredClone(p))).toEqual(expected);
      expect(spy).toHaveBeenCalledTimes(12);
    } finally {
      spy.mockRestore();
    }
  });
  it("preserves original issue ordering for mixed owned/foreign invalid rows and metadata", () => {
    for (const mutate of [
      (p: FaultInput) => {
        p.patch.rows.push({ index: 1, row: row() });
        p.patch.rows[1].row.cells[0].foreground = { kind: "indexed", index: -1 };
        p.revision = 1;
      },
      (p: FaultInput) => {
        p.extra = 1;
        p.patch.extra = 1;
        p.patch.rows[0].index = -1;
        p.revision = 1;
      },
      (p: FaultInput) => {
        p.patch.rows.push({ index: 1, row: { ...row(), extra: 1 } });
        p.patch.dimensions = { cols: 0, rows: -1, extra: 1 };
      },
      (p: FaultInput) => {
        const r: FaultInput = row();
        r.cells[0].width = 3;
        r.cells[0].extra = 1;
        p.patch.history = [freezeOwnedTerminalReplicaRow(r)];
      },
      (p: FaultInput) => {
        p.patch.historyDelta = { trim: -1, append: [{ cells: null, wrapped: 4 }], extra: 1 };
        p.patch.cursor = { x: -1 };
      },
    ]) {
      const p: FaultInput = payload();
      mutate(p);
      const expected = issues(() => TerminalSemanticDeliveryPayloadSchemaZ.parse(p));
      expect(expected).not.toBeNull();
      expect(issues(() => encode(p))).toEqual(expected);
      expect(issues(() => encode(p))).toEqual(expected);
    }
  });
  it("does not reread foreign accessors and observes mutation on every mixed patch", () => {
    const make = () => {
      const p: FaultInput = payload();
      const c: FaultInput = row();
      let reads = 0;
      let value = "Q";
      Object.defineProperty(c.cells[0], "grapheme", {
        enumerable: true,
        get() {
          reads++;
          return value;
        },
      });
      p.patch.rows.push({ index: 1, row: c });
      return { p, reads: () => reads, set: (v: string) => (value = v) };
    };
    const strict = make(),
      actual = make();
    TerminalSemanticDeliveryPayloadSchemaZ.parse(strict.p);
    const first = encode(actual.p);
    expect(actual.reads()).toBe(strict.reads());
    actual.set("R");
    const second = encode(actual.p);
    expect(second).not.toEqual(first);
    expect(actual.reads()).toBe(2 * strict.reads());
    const a = make(),
      b = make();
    a.p.patch.rows[1].row.cells[0].width = 3;
    b.p.patch.rows[1].row.cells[0].width = 3;
    expect(issues(() => encode(a.p))).toEqual(
      issues(() => TerminalSemanticDeliveryPayloadSchemaZ.parse(b.p)),
    );
    expect(a.reads()).toBe(b.reads());
  });
  it("keeps invalid owned rows uncached and preserves thrown getter values", () => {
    const p: FaultInput = payload();
    const invalid: FaultInput = row();
    invalid.cells[0].attributes = -1;
    p.patch.history = [freezeOwnedTerminalReplicaRow(invalid)];
    const spy = vi.spyOn(TerminalReplicaCellSchemaZ._zod, "run");
    try {
      expect(() => encode(p)).toThrow();
      spy.mockClear();
      expect(() => encode(p)).toThrow();
      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(12);
    } finally {
      spy.mockRestore();
    }
    const thrown = Object.freeze({ sentinel: true });
    const q: FaultInput = payload();
    const foreign = row();
    Object.defineProperty(foreign.cells[0], "grapheme", {
      get() {
        throw thrown;
      },
    });
    q.patch.rows.push({ index: 1, row: foreign });
    let actual: unknown;
    try {
      encode(q);
    } catch (e) {
      actual = e;
    }
    expect(actual).toBe(thrown);
  });
  it("preserves issue paths and outer refinement across every strict row error category", () => {
    const mutations = [
      (r: FaultInput) => (r.cells = null),
      (r: FaultInput) => (r.wrapped = "false"),
      (r: FaultInput) => (r.extra = 1),
      (r: FaultInput) => (r.cells[0].grapheme = 12),
      (r: FaultInput) => (r.cells[0].width = 3),
      (r: FaultInput) => (r.cells[0].attributes = -1),
      (r: FaultInput) => (r.cells[0].attributes = 256),
      (r: FaultInput) => (r.cells[0].attributes = 1.5),
      (r: FaultInput) => (r.cells[0].foreground = { kind: "nope" }),
      (r: FaultInput) => (r.cells[0].foreground = { kind: "indexed", index: 256 }),
      (r: FaultInput) => (r.cells[0].background = { kind: "rgb", value: -1 }),
      (r: FaultInput) => (r.cells[0].foreground = { kind: "default", extra: 1 }),
    ];
    for (const mutate of mutations) {
      const p: FaultInput = payload();
      const foreign: FaultInput = row();
      mutate(foreign);
      p.patch.rows.push({ index: 1, row: foreign });
      p.revision = p.baseRevision;
      expect(issues(() => encode(p))).toEqual(
        issues(() => TerminalSemanticDeliveryPayloadSchemaZ.parse(p)),
      );
    }
  });
  it("does not peek accessor frame/patch/row containers during branch selection", () => {
    const paths = [
      ["frame"],
      ["patch"],
      ["patch", "rows"],
      ["patch", "rows", "0"],
      ["patch", "rows", "0", "row"],
      ["patch", "history"],
      ["patch", "historyDelta"],
      ["patch", "historyDelta", "append"],
    ];
    for (const path of paths) {
      const make = () => {
        const p: FaultInput = payload();
        let target = p;
        for (const key of path.slice(0, -1)) target = target[key];
        const key = path.at(-1)!;
        const value = target[key];
        let reads = 0;
        Object.defineProperty(target, key, {
          enumerable: true,
          get() {
            reads++;
            return value;
          },
        });
        return { p, reads: () => reads };
      };
      const actual = make(),
        reference = make();
      TerminalSemanticDeliveryPayloadSchemaZ.parse(reference.p);
      encode(actual.p as TerminalSemanticDeliveryPayload);
      expect(actual.reads()).toBe(reference.reads());
    }
  });
});
