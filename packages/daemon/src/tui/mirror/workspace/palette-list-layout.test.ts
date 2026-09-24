import { describe, expect, it } from "vitest";
import { applicationPaletteCommands } from "../runtime/application-palette-input.ts";
import { paletteListLayout } from "./palette-list-layout.ts";

const commands = applicationPaletteCommands(null, ["alpha", "beta"]);
describe("palette section layout", () => {
  it("keeps every selected command visible without exceeding the cell budget", () => {
    for (const capacity of [1, 3, 6, 10, 18, 30]) {
      for (let selected = 0; selected < commands.length; selected++) {
        const rows = paletteListLayout(commands, selected, capacity, true);
        expect(rows.some((row) => row.index === selected)).toBe(true);
        expect(
          rows.reduce(
            (height, row) => height + 1 + Number(Boolean(row.heading)) + Number(row.gap),
            0,
          ),
        ).toBeLessThanOrEqual(capacity);
        expect(rows.map((row) => row.command)).toEqual(
          commands.slice(rows[0]!.index, rows.at(-1)!.index + 1),
        );
      }
    }
  });
  it("shows clear sections and removes decorative rows during search or at tiny sizes", () => {
    expect(
      paletteListLayout(commands, 0, 40, true).flatMap((row) => (row.heading ? [row.heading] : [])),
    ).toEqual(["Navigation", "Panes", "Appearance", "Help", "Sessions"]);
    for (const rows of [
      paletteListLayout(commands, 4, 4, true),
      paletteListLayout(commands, 4, 20, false),
    ]) {
      expect(rows.every((row) => !row.heading && !row.gap)).toBe(true);
    }
    expect(paletteListLayout([], 0, 20, true)).toEqual([]);
  });
});
