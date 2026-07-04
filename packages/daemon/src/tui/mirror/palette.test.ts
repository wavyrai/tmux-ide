import { describe, expect, it } from "vitest";
import { staticPaletteActions, filterPaletteActions, parseBufferList } from "./palette.ts";

describe("staticPaletteActions", () => {
  it("offers the four tab switches, one attach per session, then save/refresh/paste/quit", () => {
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
      "Paste buffer…",
      "Quit",
    ]);
  });

  it("offers the paste-buffer action on every surface (no terminal gate)", () => {
    expect(staticPaletteActions([]).some((a) => a.kind === "paste-buffer")).toBe(true);
    expect(
      staticPaletteActions([], { terminal: true }).some((a) => a.kind === "paste-buffer"),
    ).toBe(true);
  });
});

describe("parseBufferList", () => {
  it("parses name + sample lines, dropping blank/nameless rows", () => {
    const bufs = parseBufferList(["buffer0\thello world", "buffer1\tsecond", "", "\tno name"]);
    expect(bufs).toEqual([
      { name: "buffer0", preview: "hello world" },
      { name: "buffer1", preview: "second" },
    ]);
  });

  it("truncates the preview and sanitizes control characters", () => {
    const bufs = parseBufferList(["b\tline1\nline2\ttabbed"], 8);
    expect(bufs[0]).toEqual({ name: "b", preview: "line1·li" });
  });

  it("handles a buffer with no sample field", () => {
    expect(parseBufferList(["buffer2"])).toEqual([{ name: "buffer2", preview: "" }]);
  });
});

describe("filterPaletteActions", () => {
  it("returns every static action for an empty query, no open-file entry", () => {
    const actions = filterPaletteActions("", ["alpha"]);
    expect(actions.some((a) => a.kind === "open-file")).toBe(false);
    expect(actions).toHaveLength(9);
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

  it("offers the window/pane verbs only in terminal context", () => {
    const off = staticPaletteActions(["a"]).map((x) => x.kind);
    expect(off).not.toContain("new-window");
    expect(off).not.toContain("zoom-pane");
    const on = staticPaletteActions(["a"], { terminal: true }).map((x) => x.kind);
    expect(on).toEqual(expect.arrayContaining(["new-window", "kill-window", "zoom-pane"]));
  });

  it("offers the M20.2 pane-op + layout verbs only in terminal context", () => {
    const off = staticPaletteActions(["a"]).map((x) => x.kind);
    expect(off).not.toContain("select-layout");
    expect(off).not.toContain("sync-toggle");
    const on = staticPaletteActions(["a"], { terminal: true });
    expect(on.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["swap-pane", "break-pane", "rotate-window", "sync-toggle"]),
    );
    // One select-layout action per preset, carrying the layout name.
    const layouts = on.filter((x) => x.kind === "select-layout");
    expect(layouts.map((x) => (x.kind === "select-layout" ? x.layout : ""))).toEqual([
      "even-horizontal",
      "even-vertical",
      "main-horizontal",
      "main-vertical",
      "tiled",
    ]);
  });

  it("appends a rename-window verb for a non-empty terminal query", () => {
    const actions = filterPaletteActions("build", ["a"], { terminal: true });
    expect(actions.some((x) => x.kind === "rename-window" && x.name === "build")).toBe(true);
    // …and never off the Terminal surface.
    expect(filterPaletteActions("build", ["a"]).some((x) => x.kind === "rename-window")).toBe(
      false,
    );
  });
});
