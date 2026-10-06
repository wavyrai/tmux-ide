import { describe, expect, it } from "vitest";
import { TerminalReplicaCellSchemaZ } from "../terminal-replica.ts";

const cell = {
  grapheme: "界",
  width: 2,
  foreground: { kind: "rgb", value: 0x123456 },
  background: { kind: "default" },
  attributes: 0,
};

describe("terminal cell width contract", () => {
  it.each([0, -0, 1, 2])("preserves the exact allowed width %s", (width) => {
    const input = { ...cell, width };
    expect(TerminalReplicaCellSchemaZ.parse(input)).toEqual(input);
  });

  it.each([undefined, null, false, "1", -1, 0.5, 3, NaN, Infinity, -Infinity, {}, []])(
    "rejects an invalid width without coercion: %s",
    (width) => {
      const result = TerminalReplicaCellSchemaZ.safeParse({ ...cell, width });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["width"]);
    },
  );
});
