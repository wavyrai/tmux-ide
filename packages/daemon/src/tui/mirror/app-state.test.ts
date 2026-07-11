import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_COMMANDS_CAP,
  DEFAULT_APP_STATE,
  PALETTE_USAGE_CAP,
  RECENTS_CAP,
  SIDEBAR_W_DEFAULT,
  SPAWN_MEMORY_CAP,
  addCustomCommand,
  addRecentFolder,
  recordPaletteUse,
  appStateHome,
  appStatePath,
  clampSidebarWidth,
  isTab,
  parseAppState,
  rememberSpawn,
  serializeAppState,
  spawnMemoryKey,
  type AppState,
} from "./app-state.ts";
import type { LastSpawn } from "./agent-lifecycle.ts";

describe("isTab", () => {
  it("accepts the four surface keys and rejects anything else", () => {
    expect(isTab("home")).toBe(true);
    expect(isTab("terminal")).toBe(true);
    expect(isTab("files")).toBe(true);
    expect(isTab("diff")).toBe(true);
    expect(isTab("mirror")).toBe(false);
    expect(isTab(2)).toBe(false);
    expect(isTab(null)).toBe(false);
  });
});

describe("parseAppState", () => {
  it("round-trips a full state", () => {
    const state: AppState = {
      lastTab: "files",
      contextSession: "zz-demo",
      openFile: "/tmp/a.ts",
      diffFile: "src/x.ts",
      sidebarW: 30,
      recentFolders: ["/tmp/one", "/tmp/two"],
      lastSpawns: {
        "/tmp/one": { kind: "claude", command: "claude", placement: "split-h" },
        "session:web": { kind: "custom-command", command: "my-agent --x", placement: "window" },
      },
      customCommands: ["my-agent --x", "other --y"],
      paletteUsage: {
        save: { count: 3, lastUsed: 1700000100 },
        "attach:web": { count: 1, lastUsed: 1700000200 },
      },
      filesShowHidden: true,
      filesShowIgnored: false,
    };
    expect(parseAppState(serializeAppState(state))).toEqual(state);
  });

  it("falls back to defaults on invalid JSON", () => {
    expect(parseAppState("{not json")).toEqual(DEFAULT_APP_STATE);
    expect(parseAppState("null")).toEqual(DEFAULT_APP_STATE);
    expect(parseAppState("[]")).toEqual(DEFAULT_APP_STATE);
  });

  it("defaults an unknown tab back to home but keeps valid siblings", () => {
    const parsed = parseAppState(
      JSON.stringify({ lastTab: "bogus", contextSession: "s", openFile: "/f", diffFile: "d" }),
    );
    expect(parsed).toEqual({
      lastTab: "home",
      contextSession: "s",
      openFile: "/f",
      diffFile: "d",
      sidebarW: SIDEBAR_W_DEFAULT,
      recentFolders: [],
      lastSpawns: {},
      customCommands: [],
      paletteUsage: {},
      filesShowHidden: false,
      filesShowIgnored: false,
    });
  });

  it("coerces empty strings and wrong types to null", () => {
    const parsed = parseAppState(
      JSON.stringify({ lastTab: "diff", contextSession: "", openFile: 42, diffFile: null }),
    );
    expect(parsed).toEqual({
      lastTab: "diff",
      contextSession: null,
      openFile: null,
      diffFile: null,
      sidebarW: SIDEBAR_W_DEFAULT,
      recentFolders: [],
      lastSpawns: {},
      customCommands: [],
      paletteUsage: {},
      filesShowHidden: false,
      filesShowIgnored: false,
    });
  });

  it("drops malformed spawn-memory entries and keeps clean ones (order preserved)", () => {
    const parsed = parseAppState(
      JSON.stringify({
        lastSpawns: {
          "/good": { kind: "claude", command: "claude", placement: "window" },
          "/bad-placement": { kind: "claude", command: "claude", placement: "pane" },
          "/bad-kind": { kind: "", command: "claude", placement: "window" },
          "/bad-shape": "claude",
          "": { kind: "claude", command: "claude", placement: "window" },
          "/good2": { kind: "custom-command", command: "m --x", placement: "session" },
        },
        customCommands: ["a", "", 5, "a", "b"],
      }),
    );
    expect(Object.keys(parsed.lastSpawns)).toEqual(["/good", "/good2"]);
    expect(parsed.customCommands).toEqual(["a", "b"]);
  });

  it("yields empty spawn memory for a non-object value", () => {
    expect(parseAppState(JSON.stringify({ lastSpawns: ["x"], customCommands: "y" }))).toEqual(
      DEFAULT_APP_STATE,
    );
  });

  it("keeps only clean, deduped, capped recent folders", () => {
    const parsed = parseAppState(
      JSON.stringify({
        recentFolders: ["/a", "/a", "", 5, "/b", "/c", "/d", "/e", "/f", "/g", "/h", "/i"],
      }),
    );
    // dedupe drops the second "/a", blanks/non-strings drop, then cap at RECENTS_CAP.
    expect(parsed.recentFolders).toEqual(["/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"]);
    expect(parsed.recentFolders.length).toBe(RECENTS_CAP);
  });

  it("clamps a persisted sidebar width to the bounds and rounds it", () => {
    expect(parseAppState(JSON.stringify({ sidebarW: 9 })).sidebarW).toBe(16);
    expect(parseAppState(JSON.stringify({ sidebarW: 99 })).sidebarW).toBe(48);
    expect(parseAppState(JSON.stringify({ sidebarW: 30.6 })).sidebarW).toBe(31);
    expect(parseAppState(JSON.stringify({ sidebarW: "wide" })).sidebarW).toBe(SIDEBAR_W_DEFAULT);
  });
});

describe("clampSidebarWidth", () => {
  it("clamps to [16,48], rounds, and defaults non-finite", () => {
    expect(clampSidebarWidth(24)).toBe(24);
    expect(clampSidebarWidth(0)).toBe(16);
    expect(clampSidebarWidth(1000)).toBe(48);
    expect(clampSidebarWidth(20.4)).toBe(20);
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_W_DEFAULT);
  });
});

describe("serializeAppState", () => {
  it("emits exactly the persisted keys and drops extras", () => {
    const parsed = JSON.parse(
      serializeAppState({
        lastTab: "terminal",
        contextSession: "s",
        openFile: null,
        diffFile: null,
        sidebarW: SIDEBAR_W_DEFAULT,
        recentFolders: [],
        lastSpawns: {},
        customCommands: [],
        paletteUsage: {},
        filesShowHidden: false,
        filesShowIgnored: false,
        // @ts-expect-error — runtime extra keys must not leak into the file
        junk: "x",
      }),
    );
    expect(Object.keys(parsed).sort()).toEqual([
      "contextSession",
      "customCommands",
      "diffFile",
      "filesShowHidden",
      "filesShowIgnored",
      "lastSpawns",
      "lastTab",
      "openFile",
      "paletteUsage",
      "recentFolders",
      "sidebarW",
    ]);
  });
});

describe("spawnMemoryKey", () => {
  it("prefers the dir, falls back to a namespaced session, else null", () => {
    expect(spawnMemoryKey("/proj", "web")).toBe("/proj");
    expect(spawnMemoryKey(null, "web")).toBe("session:web");
    expect(spawnMemoryKey("", "web")).toBe("session:web");
    expect(spawnMemoryKey(null, undefined)).toBeNull();
    expect(spawnMemoryKey(null, "")).toBeNull();
  });
});

describe("rememberSpawn", () => {
  const spawn = (kind: string): LastSpawn => ({ kind, command: kind, placement: "window" });

  it("re-inserts an existing key as newest (LRU order) without touching the input", () => {
    const map = { "/a": spawn("claude"), "/b": spawn("codex") };
    const out = rememberSpawn(map, "/a", spawn("opencode"));
    expect(Object.keys(out)).toEqual(["/b", "/a"]);
    expect(out["/a"]!.kind).toBe("opencode");
    expect(Object.keys(map)).toEqual(["/a", "/b"]); // input untouched
  });

  it("drops the oldest entries past the cap", () => {
    let map: Record<string, LastSpawn> = {};
    for (let i = 0; i < SPAWN_MEMORY_CAP + 3; i++) {
      map = rememberSpawn(map, `/p${i}`, spawn("claude"));
    }
    const keys = Object.keys(map);
    expect(keys.length).toBe(SPAWN_MEMORY_CAP);
    expect(keys[0]).toBe("/p3"); // /p0../p2 fell off
    expect(keys[keys.length - 1]).toBe(`/p${SPAWN_MEMORY_CAP + 2}`);
  });
});

describe("addCustomCommand", () => {
  it("moves a command to the front, dedupes, caps, and ignores blanks", () => {
    expect(addCustomCommand(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(addCustomCommand(["a", "b", "c", "d", "e"], "f")).toEqual(["f", "a", "b", "c", "d"]);
    expect(addCustomCommand(["a"], "  ")).toEqual(["a"]);
    expect(addCustomCommand([], "x --y").length).toBeLessThanOrEqual(CUSTOM_COMMANDS_CAP);
  });
});

describe("addRecentFolder", () => {
  it("moves an opened folder to the front and dedupes", () => {
    expect(addRecentFolder(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    expect(addRecentFolder(["/a", "/b"], "/new")).toEqual(["/new", "/a", "/b"]);
  });

  it("caps the list, dropping the oldest", () => {
    const full = ["/1", "/2", "/3", "/4", "/5", "/6", "/7", "/8"];
    expect(addRecentFolder(full, "/new")).toEqual([
      "/new",
      "/1",
      "/2",
      "/3",
      "/4",
      "/5",
      "/6",
      "/7",
    ]);
  });

  it("ignores a blank path", () => {
    expect(addRecentFolder(["/a"], "")).toEqual(["/a"]);
  });
});

describe("recordPaletteUse (M24.4)", () => {
  it("bumps count, stamps lastUsed, and moves the key to newest", () => {
    const m0 = recordPaletteUse({}, "save", 100);
    expect(m0).toEqual({ save: { count: 1, lastUsed: 100 } });
    const m1 = recordPaletteUse(m0, "quit", 200);
    const m2 = recordPaletteUse(m1, "save", 300);
    expect(m2.save).toEqual({ count: 2, lastUsed: 300 });
    // re-use re-inserts LAST — the LRU order JSON round-trips
    expect(Object.keys(m2)).toEqual(["quit", "save"]);
  });

  it("caps at the limit, dropping the least-recently-used", () => {
    let m: Record<string, { count: number; lastUsed: number }> = {};
    for (let i = 0; i < PALETTE_USAGE_CAP + 3; i++) m = recordPaletteUse(m, `k${i}`, i);
    expect(Object.keys(m)).toHaveLength(PALETTE_USAGE_CAP);
    expect(m.k0).toBeUndefined();
    expect(m.k2).toBeUndefined();
    expect(m.k3).toBeDefined();
  });

  it("ignores a blank key and never mutates the input", () => {
    const orig = { save: { count: 1, lastUsed: 1 } };
    expect(recordPaletteUse(orig, "", 9)).toEqual(orig);
    const next = recordPaletteUse(orig, "save", 9);
    expect(orig.save.count).toBe(1);
    expect(next.save.count).toBe(2);
  });
});

describe("paletteUsage sanitization", () => {
  it("drops malformed entries and non-object values on parse", () => {
    const parsed = parseAppState(
      JSON.stringify({
        paletteUsage: {
          good: { count: 2, lastUsed: 123 },
          floats: { count: 2.9, lastUsed: 456.2 },
          negative: { count: 0, lastUsed: 1 },
          mistyped: { count: "3", lastUsed: 1 },
          missing: { count: 1 },
          notObject: 7,
        },
      }),
    );
    expect(parsed.paletteUsage).toEqual({
      good: { count: 2, lastUsed: 123 },
      floats: { count: 2, lastUsed: 456 },
    });
    expect(parseAppState(JSON.stringify({ paletteUsage: [1] })).paletteUsage).toEqual({});
  });
});

describe("appStateHome / appStatePath", () => {
  const prev = process.env.TMUX_IDE_HOME;
  beforeEach(() => {
    delete process.env.TMUX_IDE_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TMUX_IDE_HOME;
    else process.env.TMUX_IDE_HOME = prev;
  });

  it("honors TMUX_IDE_HOME as the whole home dir", () => {
    process.env.TMUX_IDE_HOME = "/tmp/zz-home";
    expect(appStateHome()).toBe("/tmp/zz-home");
    expect(appStatePath()).toBe("/tmp/zz-home/app-state.json");
  });

  it("defaults under the user home when unset", () => {
    expect(appStatePath().endsWith("/.tmux-ide/app-state.json")).toBe(true);
  });
});

describe("files toggles (M24.6)", () => {
  it("default hidden, parse tolerates absence/mistypes, round-trips", () => {
    expect(parseAppState("{}").filesShowHidden).toBe(false);
    expect(parseAppState("{}").filesShowIgnored).toBe(false);
    expect(parseAppState('{"filesShowHidden":"yes"}').filesShowHidden).toBe(false);
    const s = parseAppState('{"filesShowHidden":true,"filesShowIgnored":true}');
    expect(s.filesShowHidden).toBe(true);
    expect(s.filesShowIgnored).toBe(true);
    const round = parseAppState(serializeAppState(s));
    expect(round.filesShowHidden).toBe(true);
    expect(round.filesShowIgnored).toBe(true);
  });
});
