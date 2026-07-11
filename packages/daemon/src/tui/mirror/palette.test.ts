import { describe, expect, it } from "vitest";
import {
  staticPaletteActions,
  filterPaletteActions,
  parseBufferList,
  goToFileActions,
  GO_FILE_CAP,
} from "./palette.ts";

describe("staticPaletteActions", () => {
  it("offers the four tab switches, one attach per session, then save/refresh/paste/settings/quit", () => {
    const actions = staticPaletteActions(["alpha", "beta"]);
    expect(actions.map((a) => a.label)).toEqual([
      "Switch tab: Home",
      "Switch tab: Terminal",
      "Switch tab: Files",
      "Switch tab: Diff",
      "Open folder…",
      "New agent…",
      "Manage team…",
      "Attach session: alpha",
      "Attach session: beta",
      "Save file",
      "Refresh diff",
      "Paste buffer…",
      // the settings category (M22.4) — every setting is a palette command
      "Settings…",
      "Settings: Accent color",
      "Settings: Notifications",
      "Settings: Quiet hours",
      "Settings: Updates & background refresh",
      "Settings: Crash restore",
      "Settings: Keyboard shortcuts (view)",
      "Settings: Reset to defaults",
      "Quit",
    ]);
  });

  it("pins 'New agent: <name> (again)' FIRST when the context has spawn memory (M24.1)", () => {
    const actions = staticPaletteActions(["alpha"], { againName: "claude" });
    expect(actions[0]).toMatchObject({
      kind: "new-agent-again",
      label: "New agent: claude (again)",
    });
    // Empty-query Enter therefore repeats the spawn: F5 → Enter (≤2 Enters).
    expect(filterPaletteActions("", ["alpha"], { againName: "claude" })[0]!.kind).toBe(
      "new-agent-again",
    );
    // …and the action ranks above "New agent…" by construction.
    const labels = actions.map((a) => a.label);
    expect(labels.indexOf("New agent: claude (again)")).toBeLessThan(labels.indexOf("New agent…"));
    // Without memory it is absent entirely.
    expect(staticPaletteActions([]).some((a) => a.kind === "new-agent-again")).toBe(false);
  });

  it("offers the team console on every surface (M24.1)", () => {
    expect(staticPaletteActions([]).some((a) => a.kind === "manage-team")).toBe(true);
    expect(filterPaletteActions("team", []).some((a) => a.kind === "manage-team")).toBe(true);
  });

  it("offers the open-folder command on every surface", () => {
    expect(staticPaletteActions([]).some((a) => a.kind === "open-folder")).toBe(true);
    expect(filterPaletteActions("open fold", []).some((a) => a.kind === "open-folder")).toBe(true);
  });

  it("typing 'set' surfaces the settings umbrella (the battery's palette entry)", () => {
    const filtered = filterPaletteActions("set", []);
    expect(filtered.some((a) => a.kind === "settings" && a.id === "settings")).toBe(true);
  });

  it("offers new-agent on every surface, and per-agent lifecycle verbs after the jumps (M23.1)", () => {
    expect(staticPaletteActions([]).some((a) => a.kind === "new-agent")).toBe(true);
    const agent = {
      paneId: "%4",
      windowIndex: 1,
      session: "web",
      kind: "claude",
      state: "working" as const,
      since: null,
    };
    const actions = staticPaletteActions(["web"], { agents: [agent] });
    const labels = actions.map((a) => a.label);
    const jump = labels.indexOf("Agent: claude · web (working)");
    const restart = labels.indexOf("Restart agent: claude · web");
    const stop = labels.indexOf("Stop agent: claude · web");
    expect(jump).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(jump);
    expect(stop).toBeGreaterThan(restart);
    const r = actions[restart]!;
    expect(r.kind === "restart-agent" && r.paneId === "%4" && r.agentKind === "claude").toBe(true);
    // typing "restart" narrows straight to the verb
    expect(
      filterPaletteActions("restart", ["web"], { agents: [agent] }).some(
        (a) => a.kind === "restart-agent",
      ),
    ).toBe(true);
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
    expect(actions).toHaveLength(20);
  });

  it("fuzzy-ranks matches and appends an open-file action for a plain word", () => {
    // "sess" (not "ses"): since M22.4 "ses" is a contiguous prefix of
    // "Settings…", which out-scores the subsequence hit in "Attach session".
    const actions = filterPaletteActions("sess", ["alpha"]);
    expect(actions[0]).toMatchObject({ kind: "attach", session: "alpha" });
    const last = actions[actions.length - 1];
    expect(last).toMatchObject({ kind: "open-file", path: "sess", label: "Open file: sess" });
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

  it("offers the reclaim action only on a terminal WITH a size mismatch (M22.8)", () => {
    // Not offered without a mismatch, even on the terminal surface…
    expect(
      staticPaletteActions(["a"], { terminal: true }).some((x) => x.kind === "resize-window"),
    ).toBe(false);
    // …nor off the terminal surface even if a mismatch is flagged…
    expect(
      staticPaletteActions(["a"], { sizeMismatch: true }).some((x) => x.kind === "resize-window"),
    ).toBe(false);
    // …only when both hold.
    expect(
      staticPaletteActions(["a"], { terminal: true, sizeMismatch: true }).some(
        (x) => x.kind === "resize-window",
      ),
    ).toBe(true);
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

describe("palette overlay geometry (M21.9)", () => {
  it("palettePos centers horizontally and sits at a sixth of the height, min 1", async () => {
    const { palettePos } = await import("./palette.ts");
    expect(palettePos(220, 60, 60)).toEqual({ left: 80, top: 10 });
    expect(palettePos(40, 4, 60)).toEqual({ left: 0, top: 1 }); // clamped small
  });

  it("paletteHeight counts chrome + rows, with one placeholder row when empty", async () => {
    const { paletteHeight } = await import("./palette.ts");
    expect(paletteHeight(10)).toBe(14); // border + input + rule + 10 rows + border
    expect(paletteHeight(0)).toBe(5); // the "no matches" row still occupies one
  });

  it("paletteRowAt maps interior rows and rejects chrome, borders, and below-list", async () => {
    const { paletteRowAt } = await import("./palette.ts");
    const g = { left: 80, top: 10, width: 60, visibleRows: 3 };
    expect(paletteRowAt(g, 100, 13)).toBe(0); // first result row
    expect(paletteRowAt(g, 100, 15)).toBe(2); // last visible row
    expect(paletteRowAt(g, 100, 16)).toBe(-1); // past the list
    expect(paletteRowAt(g, 100, 12)).toBe(-1); // the rule row
    expect(paletteRowAt(g, 80, 13)).toBe(-1); // left border column
    expect(paletteRowAt(g, 139, 13)).toBe(-1); // right border column
    expect(paletteRowAt(g, 81, 13)).toBe(0); // first interior column
    expect(paletteRowAt(g, 138, 13)).toBe(0); // last interior column
  });

  it("paletteContains covers the whole box incl. borders, nothing beyond", async () => {
    const { paletteContains, paletteHeight } = await import("./palette.ts");
    const g = { left: 80, top: 10, width: 60, visibleRows: 3 };
    const h = paletteHeight(3); // 7
    expect(paletteContains(g, 80, 10)).toBe(true); // top-left border cell
    expect(paletteContains(g, 139, 10 + h - 1)).toBe(true); // bottom-right border cell
    expect(paletteContains(g, 79, 12)).toBe(false);
    expect(paletteContains(g, 140, 12)).toBe(false);
    expect(paletteContains(g, 100, 10 + h)).toBe(false);
    expect(paletteContains(g, 100, 9)).toBe(false);
  });

  it("clampPaletteTop pins the window into [0, count - pageRows]", async () => {
    const { clampPaletteTop } = await import("./palette.ts");
    expect(clampPaletteTop(5, 25, 10)).toBe(5);
    expect(clampPaletteTop(99, 25, 10)).toBe(15);
    expect(clampPaletteTop(-3, 25, 10)).toBe(0);
    expect(clampPaletteTop(4, 6, 10)).toBe(0); // shorter than a page never scrolls
  });
});

describe("select-text action (M22.9)", () => {
  it("is offered only on the terminal surface with an app-mouse focused pane", () => {
    const on = staticPaletteActions([], { terminal: true, appMousePane: true });
    expect(on.some((a) => a.kind === "select-text")).toBe(true);
    expect(on.find((a) => a.kind === "select-text")?.label).toBe("Select text in pane");
  });
  it("is absent for ordinary panes (drags already select directly)", () => {
    const off = staticPaletteActions([], { terminal: true, appMousePane: false });
    expect(off.some((a) => a.kind === "select-text")).toBe(false);
    expect(staticPaletteActions([], { terminal: true }).some((a) => a.kind === "select-text")).toBe(
      false,
    );
  });
  it("is absent off the terminal surface even with an app-mouse pane", () => {
    const home = staticPaletteActions([], { terminal: false, appMousePane: true });
    expect(home.some((a) => a.kind === "select-text")).toBe(false);
  });
  it("fuzzy-matches by typing 'select'", () => {
    const filtered = filterPaletteActions("select", [], { terminal: true, appMousePane: true });
    expect(filtered.some((a) => a.kind === "select-text")).toBe(true);
  });
});

describe("goToFileActions / repoFiles (M24.6)", () => {
  const files = ["src/tui/mirror/file-tree.ts", "src/lib/app-config.ts", "README.md"];

  it("offers fuzzy-matched Go to file rows, capped, and none on an empty query", () => {
    const rows = goToFileActions("filetree", files);
    expect(rows.map((a) => a.label)).toEqual(["Go to file: src/tui/mirror/file-tree.ts"]);
    expect(rows[0]).toMatchObject({ kind: "go-file", path: "src/tui/mirror/file-tree.ts" });
    expect(goToFileActions("", files)).toEqual([]);
    expect(goToFileActions("x", [])).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    expect(goToFileActions("src", many, GO_FILE_CAP).length).toBe(GO_FILE_CAP);
  });

  it("appends go-file rows AFTER the existing results (ranking untouched)", () => {
    const out = filterPaletteActions("readme", [], { repoFiles: files });
    const kinds = out.map((a) => a.kind);
    // the dynamic open-file row still precedes the appended go-file rows
    expect(kinds.indexOf("open-file")).toBeLessThan(kinds.indexOf("go-file"));
    expect(out[out.length - 1]).toMatchObject({ kind: "go-file", path: "README.md" });
    // without repoFiles the list is exactly as before — no go-file rows
    expect(filterPaletteActions("readme", []).some((a) => a.kind === "go-file")).toBe(false);
  });
});
