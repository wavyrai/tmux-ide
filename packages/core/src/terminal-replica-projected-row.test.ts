import { describe, expect, it } from "vitest";
import { TerminalReplicaRowSchemaZ } from "@tmux-ide/contracts";
import {
  createProjectedTerminalReplicaRowBuilder,
  freezeOwnedTerminalReplicaRow,
  isOwnedTerminalReplicaRow,
  TERMINAL_REPLICA_DEFAULT_COLOR,
  TERMINAL_REPLICA_EMPTY_CELL,
  TERMINAL_REPLICA_SPACE_CELL,
} from "./terminal-replica-owned-row.ts";
import { hashTerminalReplicaRowCached } from "./terminal-replica-hash-cache.ts";

describe("primitive projected row construction", () => {
  it("creates exact immutable ordinary cells with distinct blanks, colors and wide storage", () => {
    const b = createProjectedTerminalReplicaRowBuilder();
    b.append("", 1, 0, "default", -1, "default", -1);
    b.append(" ", 1, 0, "default", 0, "default", 0);
    b.append("界", 2, 129, "indexed", 42, "rgb", 42);
    b.append("", 0, 129, "indexed", 42, "rgb", 42);
    b.append("e\u0301", 1, 2, "rgb", 0x123456, "default", -1);
    const actual = b.finish(true);
    const expected = {
      wrapped: true,
      cells: [
        {
          grapheme: "",
          width: 1,
          attributes: 0,
          foreground: { kind: "default" },
          background: { kind: "default" },
        },
        {
          grapheme: " ",
          width: 1,
          attributes: 0,
          foreground: { kind: "default" },
          background: { kind: "default" },
        },
        {
          grapheme: "界",
          width: 2,
          attributes: 129,
          foreground: { kind: "indexed", index: 42 },
          background: { kind: "rgb", value: 42 },
        },
        {
          grapheme: "",
          width: 0,
          attributes: 129,
          foreground: { kind: "indexed", index: 42 },
          background: { kind: "rgb", value: 42 },
        },
        {
          grapheme: "e\u0301",
          width: 1,
          attributes: 2,
          foreground: { kind: "rgb", value: 0x123456 },
          background: { kind: "default" },
        },
      ],
    };
    expect(actual).toEqual(expected);
    expect(isOwnedTerminalReplicaRow(actual)).toBe(true);
    expect(actual.cells[0]).toBe(TERMINAL_REPLICA_EMPTY_CELL);
    expect(actual.cells[1]).toBe(TERMINAL_REPLICA_SPACE_CELL);
    expect(actual.cells[4]!.background).toBe(TERMINAL_REPLICA_DEFAULT_COLOR);
    expect(hashTerminalReplicaRowCached(actual)).toBe(
      hashTerminalReplicaRowCached(TerminalReplicaRowSchemaZ.parse(expected)),
    );
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.cells)).toBe(true);
    for (const cell of actual.cells) {
      expect(Object.isFrozen(cell)).toBe(true);
      expect(Object.isFrozen(cell.foreground)).toBe(true);
      expect(Object.isFrozen(cell.background)).toBe(true);
      expect(Object.values(Object.getOwnPropertyDescriptors(cell)).every((d) => "value" in d)).toBe(
        true,
      );
    }
    expect(() => b.append("later", 1, 0, "default", 0, "default", 0)).toThrow("finished");
    expect(() => b.finish(false)).toThrow("finished");
  });
  it("never accepts object references or brands them and does not confer schema validity", () => {
    const b = createProjectedTerminalReplicaRowBuilder();
    const object = { toString: () => "X" };
    expect(() => b.append(object as unknown as string, 1, 0, "default", 0, "default", 0)).toThrow(
      "primitive",
    );
    expect(() => b.append("X", 1, 0, "rgb", object as unknown as number, "default", 0)).toThrow(
      "primitive",
    );
    expect(() => b.append("X", 1, 0, "unknown" as "rgb", 42, "default", 0)).toThrow("Unknown");
    expect(() => b.finish(object as unknown as boolean)).toThrow("boolean");
    b.append("X", 3 as 1, 256, "indexed", -1, "default", 0);
    const row = b.finish(false);
    expect(row.cells).toHaveLength(1);
    expect(isOwnedTerminalReplicaRow(row)).toBe(true);
    expect(TerminalReplicaRowSchemaZ.safeParse(row).success).toBe(false);
    expect(isOwnedTerminalReplicaRow(object)).toBe(false);
  });
  it("leaves foreign copying, getters and extra fields detached and unchanged", () => {
    let reads = 0;
    const foreground = { kind: "indexed" as const, index: 42, extra: "color-extra" };
    const source = {
      wrapped: false,
      cells: [
        {
          get grapheme() {
            reads++;
            return "X";
          },
          width: 1 as const,
          attributes: 0,
          foreground,
          background: { kind: "default" as const },
          extra: "cell-extra",
        },
      ],
    };
    const row = freezeOwnedTerminalReplicaRow(source);
    expect(reads).toBe(1);
    foreground.index = 43;
    expect(row.cells[0]!.foreground).toEqual({ kind: "indexed", index: 42, extra: "color-extra" });
    expect(row.cells[0]).toHaveProperty("extra", "cell-extra");
    expect(TerminalReplicaRowSchemaZ.safeParse(row).success).toBe(false);
  });
});
