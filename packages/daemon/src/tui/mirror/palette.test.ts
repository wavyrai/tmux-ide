import { describe, expect, it } from "vitest";
import {
  staticPaletteActions,
  filterPaletteActions,
  parseBufferList,
  paletteActionKey,
  paletteRows,
  paletteRowText,
  firstPaletteAction,
  stepPaletteRow,
  PALETTE_RECENT_LIMIT,
  type PaletteAction,
  type PaletteRow,
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

describe("paletteActionKey (M24.4)", () => {
  it("keys on kind + restart-stable payload, never the label or pane id", () => {
    expect(paletteActionKey({ kind: "tab", tab: "files", label: "Switch tab: Files" })).toBe(
      "tab:files",
    );
    expect(paletteActionKey({ kind: "attach", session: "web", label: "x" })).toBe("attach:web");
    // jump keys by SESSION: pane ids renumber across restarts, labels relabel.
    expect(
      paletteActionKey({
        kind: "jump-agent",
        paneId: "%9",
        session: "web",
        windowIndex: 2,
        label: "y",
      }),
    ).toBe("jump-agent:web");
    expect(
      paletteActionKey({
        kind: "restart-agent",
        paneId: "%9",
        agentKind: "claude",
        session: "web",
        label: "z",
      }),
    ).toBe("restart-agent:web:claude");
    expect(paletteActionKey({ kind: "settings", id: "settings-theme", label: "w" })).toBe(
      "settings:settings-theme",
    );
    expect(paletteActionKey({ kind: "select-layout", layout: "tiled", label: "v" })).toBe(
      "select-layout:tiled",
    );
    expect(paletteActionKey({ kind: "open-file", path: "src/a.ts", label: "u" })).toBe(
      "open-file:src/a.ts",
    );
    expect(paletteActionKey({ kind: "save", label: "Save file" })).toBe("save");
    // rename-window's typed name is query state, not identity.
    expect(paletteActionKey({ kind: "rename-window", name: "build", label: "t" })).toBe(
      "rename-window",
    );
  });

  it("identical actions with different labels share a key (relabels keep history)", () => {
    const a: PaletteAction = { kind: "attach", session: "web", label: "Attach session: web" };
    const b: PaletteAction = { kind: "attach", session: "web", label: "Open workspace: web" };
    expect(paletteActionKey(a)).toBe(paletteActionKey(b));
  });
});

describe("filterPaletteActions usage tie-break (M24.4)", () => {
  it("breaks score ties by frequency then recency; score still wins first", () => {
    // "attach s" matches every attach row identically — usage decides.
    const usage = {
      "attach:beta": { count: 2, lastUsed: 100 },
      "attach:alpha": { count: 1, lastUsed: 999 },
    };
    const ranked = filterPaletteActions("attach s", ["alpha", "beta", "gamma"], { usage })
      .filter((a) => a.kind === "attach")
      .map((a) => (a.kind === "attach" ? a.session : ""));
    expect(ranked).toEqual(["beta", "alpha", "gamma"]);
    // …but usage never outranks a better fuzzy score: an exact session query
    // puts that session first however often another was used.
    const exact = filterPaletteActions("attach session: gamma", ["alpha", "beta", "gamma"], {
      usage: { "attach:beta": { count: 50, lastUsed: 999 } },
    }).filter((a) => a.kind === "attach");
    expect(exact[0]).toMatchObject({ session: "gamma" });
  });
});

describe("paletteRows (M24.4 — grouped empty query)", () => {
  const agent = (over: Partial<{ paneId: string; session: string; state: string }>) => ({
    paneId: over.paneId ?? "%1",
    windowIndex: 0,
    session: over.session ?? "web",
    kind: "claude",
    state: (over.state ?? "working") as "working" | "blocked",
    since: null,
  });
  const labels = (rows: PaletteRow[]) =>
    rows.map((r) => (r.type === "header" ? `#${r.label}` : r.action.label));

  it("is exactly the ungrouped statics when there is nothing to group", () => {
    const rows = paletteRows("", ["alpha"]);
    expect(rows.every((r) => r.type === "action")).toBe(true);
    expect(rows.map((r) => (r.type === "action" ? r.action.label : ""))).toEqual(
      staticPaletteActions(["alpha"]).map((a) => a.label),
    );
  });

  it("shows recent-then-suggested-then-commands; a twice-used action outranks a once-used", () => {
    const usage = {
      "tab:diff": { count: 1, lastUsed: 999 }, // once, most recently
      save: { count: 2, lastUsed: 100 }, // twice, earlier — frequency wins
    };
    const rows = paletteRows("", ["alpha"], { usage, surface: "files" });
    const ls = labels(rows);
    expect(ls[0]).toBe("#recent");
    expect(ls[1]).toBe("Save file");
    expect(ls[2]).toBe("Switch tab: Diff");
    const sug = ls.indexOf("#suggested");
    expect(sug).toBeGreaterThan(2);
    // Files surface suggests save + open-folder; save is already RECENT, so
    // only open-folder remains (no duplicate rows).
    expect(ls.slice(sug + 1, ls.indexOf("#commands"))).toEqual(["Open folder…"]);
    expect(ls.filter((l) => l === "Save file")).toHaveLength(1);
    // …and the rest keeps today's natural order under "#commands".
    expect(ls.indexOf("#commands")).toBeGreaterThan(sug);
    expect(ls.slice(ls.indexOf("#commands") + 1)).toContain("Quit");
  });

  it("caps the recent group and ignores usage keys with no current action", () => {
    const usage: Record<string, { count: number; lastUsed: number }> = {
      "attach:gone-session": { count: 9, lastUsed: 999 }, // no longer offerable
    };
    for (let i = 0; i < 8; i++) usage[`settings:x${i}`] = { count: 1, lastUsed: i };
    usage["save"] = { count: 1, lastUsed: 50 };
    usage["quit"] = { count: 1, lastUsed: 51 };
    const rows = paletteRows("", [], { usage });
    const recent = [];
    for (const r of rows.slice(1)) {
      if (r.type === "header") break;
      recent.push(r.action.label);
    }
    // only real, currently-offered actions land, capped at the limit
    expect(recent.length).toBeLessThanOrEqual(PALETTE_RECENT_LIMIT);
    expect(recent).toContain("Save file");
    expect(recent).toContain("Quit");
  });

  it("tops the suggested group with BLOCKED agents' jumps, attention order kept", () => {
    const agents = [
      agent({ paneId: "%3", session: "help-me", state: "blocked" }),
      agent({ paneId: "%4", session: "busy", state: "working" }),
    ];
    const rows = paletteRows("", ["help-me", "busy"], {
      agents,
      surface: "terminal",
      terminal: true,
    });
    const ls = labels(rows);
    const sug = ls.indexOf("#suggested");
    expect(sug).toBeGreaterThanOrEqual(0);
    expect(ls[sug + 1]).toBe("Agent: claude · help-me (blocked)");
    // the WORKING agent's jump is not suggested — it stays under commands
    expect(ls.slice(sug, ls.indexOf("#commands"))).not.toContain("Agent: claude · busy (working)");
  });

  it("suggests the Terminal surface's again-spawn + window/pane verbs", () => {
    const rows = paletteRows("", ["a"], {
      terminal: true,
      surface: "terminal",
      againName: "claude",
    });
    const ls = labels(rows);
    const sug = ls.indexOf("#suggested");
    const cmd = ls.indexOf("#commands");
    const suggested = ls.slice(sug + 1, cmd);
    expect(suggested[0]).toBe("New agent: claude (again)");
    expect(suggested).toEqual(
      expect.arrayContaining(["New window", "Zoom pane", "Swap pane with next"]),
    );
  });

  it("a typed query yields a FLAT ranked list — no headers", () => {
    const rows = paletteRows("set", ["a"], { usage: { save: { count: 3, lastUsed: 9 } } });
    expect(rows.some((r) => r.type === "header")).toBe(false);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("attaches the keycap to rows whose action key has one", () => {
    const rows = paletteRows("", ["a"], { keycaps: { save: "^s", "tab:home": "F1" } });
    const save = rows.find((r) => r.type === "action" && r.action.kind === "save");
    const home = rows.find(
      (r) => r.type === "action" && r.action.kind === "tab" && r.action.tab === "home",
    );
    const quit = rows.find((r) => r.type === "action" && r.action.kind === "quit");
    expect(save?.type === "action" && save.shortcut).toBe("^s");
    expect(home?.type === "action" && home.shortcut).toBe("F1");
    expect(quit?.type === "action" && quit.shortcut).toBe(null);
  });
});

describe("palette selection helpers (M24.4)", () => {
  const rows: PaletteRow[] = [
    { type: "header", label: "recent" },
    { type: "action", action: { kind: "save", label: "Save file" }, shortcut: null },
    { type: "header", label: "commands" },
    { type: "action", action: { kind: "quit", label: "Quit" }, shortcut: null },
  ];
  it("firstPaletteAction lands past a leading header; -1 when no actions", () => {
    expect(firstPaletteAction(rows)).toBe(1);
    expect(firstPaletteAction([{ type: "header", label: "x" }])).toBe(-1);
    expect(firstPaletteAction([])).toBe(-1);
  });
  it("stepPaletteRow skips headers both ways and pins at the ends", () => {
    expect(stepPaletteRow(rows, 1, 1)).toBe(3); // down over the header
    expect(stepPaletteRow(rows, 3, -1)).toBe(1); // up over the header
    expect(stepPaletteRow(rows, 3, 1)).toBe(3); // bottom stays
    expect(stepPaletteRow(rows, 1, -1)).toBe(1); // top stays (header above)
  });
});

describe("paletteRowText (M24.4 — right-aligned keycaps)", () => {
  it("right-aligns the keycap and pads between", () => {
    expect(paletteRowText("Save file", "^s", 20)).toBe("Save file         ^s");
  });
  it("truncates the label with an ellipsis so the keycap always fits", () => {
    const out = paletteRowText("A very long palette action label", "F1", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("F1")).toBe(true);
    expect(out).toContain("…");
  });
  it("without a keycap it only truncates", () => {
    expect(paletteRowText("Quit", null, 20)).toBe("Quit");
    expect(paletteRowText("A very long palette action label", null, 10)).toBe("A very lo…");
  });
  it("degrades safely at tiny widths", () => {
    expect(paletteRowText("Save file", "^s", 3)).toBe("Sa…");
    expect(paletteRowText("Save file", "^s", 0)).toBe("");
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
