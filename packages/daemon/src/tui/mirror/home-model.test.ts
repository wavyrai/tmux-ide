import { describe, expect, it } from "vitest";
import {
  buildHomeItems,
  centerPad,
  clampSelectable,
  firstRunTip,
  isFirstRun,
  isSelectable,
  isValidSessionName,
  RECENTS_HEADER_LABEL,
  REGISTRY_HEADER_LABEL,
  sessionNameFor,
  stepSelectable,
  type HomeFleetProject,
  type HomeItem,
} from "./home-model.ts";
import type { AppKeys } from "../../lib/app-config.ts";

const proj = (over: Partial<HomeFleetProject>): HomeFleetProject => ({
  name: "p",
  dir: "/tmp/p",
  registered: false,
  running: true,
  sessions: [],
  ...over,
});
const sess = (name: string, windows = 1) => ({
  name,
  status: "idle" as const,
  windows: Array.from({ length: windows }, () => ({})),
});

describe("buildHomeItems", () => {
  it("lists every project's live sessions first, in payload order", () => {
    const items = buildHomeItems([
      proj({ name: "a", sessions: [sess("a1", 2), sess("a2")] }),
      proj({ name: "b", dir: null, sessions: [sess("b1")] }),
    ]);
    expect(items).toEqual([
      { kind: "session", session: "a1", project: "a", status: "idle", windows: 2, dir: "/tmp/p" },
      { kind: "session", session: "a2", project: "a", status: "idle", windows: 1, dir: "/tmp/p" },
      { kind: "session", session: "b1", project: "b", status: "idle", windows: 1, dir: null },
    ]);
  });

  it("appends a header + one row per registered-but-not-running project", () => {
    const items = buildHomeItems([
      proj({ name: "live", sessions: [sess("live")] }),
      proj({ name: "reg", dir: "/tmp/reg", registered: true, running: false }),
    ]);
    expect(items.slice(1)).toEqual([
      { kind: "header", label: REGISTRY_HEADER_LABEL },
      { kind: "project", name: "reg", dir: "/tmp/reg" },
    ]);
  });

  it("omits the registry section when every registered project is running", () => {
    const items = buildHomeItems([
      proj({ name: "reg", registered: true, running: true, sessions: [sess("reg")] }),
    ]);
    expect(items.every((i) => i.kind === "session")).toBe(true);
  });

  it("shows only the registry section on an all-idle fleet", () => {
    const items = buildHomeItems([proj({ name: "reg", registered: true, running: false })]);
    expect(items.map((i) => i.kind)).toEqual(["header", "project"]);
  });

  it("appends a recents section with basenames, most-recent first", () => {
    const items = buildHomeItems([], ["/code/alpha", "/code/beta"]);
    expect(items).toEqual([
      { kind: "header", label: RECENTS_HEADER_LABEL },
      { kind: "recent", name: "alpha", dir: "/code/alpha" },
      { kind: "recent", name: "beta", dir: "/code/beta" },
    ]);
  });

  it("dedupes a recent against the registry but keeps a live-session dir", () => {
    const items = buildHomeItems(
      [
        // An unregistered running session does NOT hide its folder from recents —
        // an opened folder gets a session yet stays reopenable under "recent".
        proj({ name: "live", dir: "/code/live", sessions: [sess("live")] }),
        proj({ name: "reg", dir: "/code/reg", registered: true, running: false }),
      ],
      ["/code/reg", "/code/live", "/code/fresh"],
    );
    const recents = items.filter((i) => i.kind === "recent");
    expect(recents).toEqual([
      { kind: "recent", name: "live", dir: "/code/live" },
      { kind: "recent", name: "fresh", dir: "/code/fresh" },
    ]);
  });

  it("omits the recents section when nothing survives the dedupe", () => {
    const items = buildHomeItems(
      [proj({ name: "reg", dir: "/code/reg", registered: true, running: false })],
      ["/code/reg"],
    );
    expect(items.some((i) => i.kind === "recent")).toBe(false);
    expect(items.some((i) => i.label === RECENTS_HEADER_LABEL)).toBe(false);
  });
});

describe("isFirstRun", () => {
  it("is true with no sessions and no registered projects", () => {
    expect(isFirstRun([])).toBe(true);
    expect(isFirstRun([proj({ registered: false, running: false, sessions: [] })])).toBe(true);
  });

  it("is false once a session or a registered project exists", () => {
    expect(isFirstRun([proj({ sessions: [sess("s")] })])).toBe(false);
    expect(isFirstRun([proj({ registered: true, running: false, sessions: [] })])).toBe(false);
  });
});

describe("firstRunTip", () => {
  const keys: AppKeys = {
    popup: "M-p",
    home: "M-h",
    cheatsheet: "M-k",
    menu: "M-m",
    sidebar: "M-b",
    panels: { explorer: "M-e", changes: "M-g", config: "M-," },
  };

  it("renders the reliable prefix twins for the user's keys", () => {
    // home M-h → prefix h; switch M-p is remapped to prefix j; menu M-m → prefix u.
    expect(firstRunTip(keys)).toBe("Your keys: prefix h home · prefix j switch sessions · prefix u actions");
  });
});

describe("centerPad", () => {
  it("centers and never goes negative", () => {
    expect(centerPad(20, 10)).toBe(5);
    expect(centerPad(21, 10)).toBe(5);
    expect(centerPad(8, 10)).toBe(0);
  });
});

describe("selection over items", () => {
  const items: HomeItem[] = [
    { kind: "session", session: "s0", project: "p", status: "idle", windows: 1, dir: null },
    { kind: "session", session: "s1", project: "p", status: "idle", windows: 1, dir: null },
    { kind: "header", label: "h" },
    { kind: "project", name: "r0", dir: null },
  ];

  it("isSelectable: sessions and projects yes, headers and undefined no", () => {
    expect(isSelectable(items[0])).toBe(true);
    expect(isSelectable(items[2])).toBe(false);
    expect(isSelectable(items[3])).toBe(true);
    expect(isSelectable(undefined)).toBe(false);
  });

  it("clampSelectable clamps into range and skips headers downward then upward", () => {
    expect(clampSelectable(items, 0)).toBe(0);
    expect(clampSelectable(items, 99)).toBe(3); // over the end → last row (selectable)
    expect(clampSelectable(items, 2)).toBe(3); // header → next selectable below
    expect(clampSelectable(items, -5)).toBe(0);
    expect(clampSelectable([], 4)).toBe(0);
    // A trailing header falls back upward.
    const trailing: HomeItem[] = [items[0]!, { kind: "header", label: "h" }];
    expect(clampSelectable(trailing, 1)).toBe(0);
  });

  it("stepSelectable hops the header in both directions and pins at the ends", () => {
    expect(stepSelectable(items, 1, 1)).toBe(3); // s1 → r0, skipping the header
    expect(stepSelectable(items, 3, -1)).toBe(1); // r0 → s1
    expect(stepSelectable(items, 3, 1)).toBe(3); // bottom end
    expect(stepSelectable(items, 0, -1)).toBe(0); // top end
  });
});

describe("session names", () => {
  it("sessionNameFor collapses tmux-target chars and spaces to dashes", () => {
    expect(sessionNameFor("sfora.ai")).toBe("sfora-ai");
    expect(sessionNameFor("a:b c.d")).toBe("a-b-c-d");
    expect(sessionNameFor("plain")).toBe("plain");
  });

  it("isValidSessionName rejects empties, dots, colons, spaces", () => {
    expect(isValidSessionName("ok-name")).toBe(true);
    expect(isValidSessionName("")).toBe(false);
    expect(isValidSessionName("a.b")).toBe(false);
    expect(isValidSessionName("a:b")).toBe(false);
    expect(isValidSessionName("a b")).toBe(false);
  });
});
