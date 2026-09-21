import { describe, expect, it } from "vitest";
import { activeCommand, rankCommands, type WorkbenchCommand } from "./command-model";
const command = (id: string, label = id, group = "Navigation", extra = {}): WorkbenchCommand => ({
  id,
  label,
  group,
  run() {},
  ...extra,
});
describe("command search and selection", () => {
  it("ranks exact labels above prefixes and abbreviations", () => {
    expect(
      rankCommands(
        [
          command("weak", "Show more"),
          command("prefix", "Home settings"),
          command("exact", "Home"),
        ],
        "home",
      ).map((c) => c.id),
    ).toEqual(["exact", "prefix", "weak"]);
  });
  it("supports aliases, multiple terms and accent-insensitive search", () => {
    expect(
      rankCommands(
        [command("remote", "Connect café", "Machines", { keywords: ["ssh"] })],
        "SSH cafe",
      ),
    ).toHaveLength(1);
    expect(rankCommands([command("remote")], "missing")).toEqual([]);
  });
  it("keeps groups contiguous and ties stable, matching keyboard order", () => {
    const rows = [command("1", "One", "A"), command("2", "Two", "B"), command("3", "Three", "A")];
    expect(rankCommands(rows, "").map((c) => c.id)).toEqual(["1", "3", "2"]);
  });
  it("selects by stable identity despite duplicate labels and reordering", () => {
    expect(activeCommand([command("b", "Same"), command("a", "Same")], "a")?.id).toBe("a");
  });
  it("falls back safely when the selected result disappears or becomes disabled", () => {
    const rows = [command("a", "A", "Group", { disabled: true }), command("b")];
    expect(activeCommand(rows, "a")?.id).toBe("b");
    expect(activeCommand(rows, "removed")?.id).toBe("b");
    expect(activeCommand(rows.slice(0, 1), "a")).toBeUndefined();
    expect(activeCommand([], null)).toBeUndefined();
  });
});
