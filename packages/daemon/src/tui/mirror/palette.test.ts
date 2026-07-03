import { describe, expect, it } from "vitest";
import { staticPaletteActions, filterPaletteActions } from "./palette.ts";

describe("staticPaletteActions", () => {
  it("offers the four tab switches, one attach per session, then save/refresh/quit", () => {
    const actions = staticPaletteActions(["alpha", "beta"]);
    expect(actions.map((a) => a.label)).toEqual([
      "Switch tab: Home",
      "Switch tab: Terminal",
      "Switch tab: Files",
      "Switch tab: Diff",
      "Attach session: alpha",
      "Attach session: beta",
      "Save file",
      "Refresh diff",
      "Quit",
    ]);
  });
});

describe("filterPaletteActions", () => {
  it("returns every static action for an empty query, no open-file entry", () => {
    const actions = filterPaletteActions("", ["alpha"]);
    expect(actions.some((a) => a.kind === "open-file")).toBe(false);
    expect(actions).toHaveLength(8);
  });

  it("fuzzy-ranks matches and appends an open-file action for a plain word", () => {
    const actions = filterPaletteActions("ses", ["alpha"]);
    expect(actions[0]).toMatchObject({ kind: "attach", session: "alpha" });
    const last = actions[actions.length - 1];
    expect(last).toMatchObject({ kind: "open-file", path: "ses", label: "Open file: ses" });
  });

  it("pins the open-file action first when the query looks like a path", () => {
    const actions = filterPaletteActions("src/app.ts", ["alpha"]);
    expect(actions[0]).toMatchObject({ kind: "open-file", path: "src/app.ts" });
  });

  it("matches the quit action by subsequence", () => {
    const labels = filterPaletteActions("quit", []).map((a) => a.label);
    expect(labels).toContain("Quit");
  });
});
