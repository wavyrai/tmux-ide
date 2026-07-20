import { describe, expect, it } from "vitest";
import {
  parsePaneGeometry,
  geometryFromLeaves,
  parseSessionPaneDescriptors,
  type PaneGeometry,
} from "./session-mirror.ts";
import { parseLayout } from "./layout-parse.ts";

const g = (id: string, left: number, top: number, w: number, h: number, active = false) =>
  ({ id, left, top, width: w, height: h, active, appMouse: false, zoomed: false }) as PaneGeometry;

describe("parsePaneGeometry", () => {
  it("parses list-panes lines", () => {
    expect(parsePaneGeometry(["%1 0 0 80 20 1", "%2 81 0 79 20 0"])).toEqual([
      g("%1", 0, 0, 80, 20, true),
      g("%2", 81, 0, 79, 20),
    ]);
  });
  it("skips malformed lines", () => {
    expect(parsePaneGeometry(["junk", "%3 0 0 x 20 0", "", "%4 1 2 3 4 0 0"])).toEqual([
      g("%4", 1, 2, 3, 4),
    ]);
  });
  it("reads the trailing window_zoomed_flag", () => {
    const [a, b] = parsePaneGeometry(["%1 0 0 80 20 1 0 1", "%2 81 0 79 20 0 1 0"]);
    expect(a).toMatchObject({ id: "%1", active: true, appMouse: false, zoomed: true });
    expect(b).toMatchObject({ id: "%2", active: false, appMouse: true, zoomed: false });
  });
  it("ignores extra trailing fields (the sync format appends window_id)", () => {
    expect(parsePaneGeometry(["%1 0 0 80 20 1 0 0 @387"])).toEqual([g("%1", 0, 0, 80, 20, true)]);
  });
});

describe("parseSessionPaneDescriptors", () => {
  it("discovers semantic identity, role/type, process, cwd, title, and window facts", () => {
    expect(
      parseSessionPaneDescriptors([
        "%42\tagent-alpha\tlead\tagent\tcodex\t/repo/apps/web\t3\tmission one\t@9\tImplement home page",
      ]),
    ).toEqual([
      {
        runtimePaneId: "%42",
        semanticPaneId: "agent-alpha",
        role: "lead",
        type: "agent",
        currentCommand: "codex",
        cwd: "/repo/apps/web",
        title: "Implement home page",
        windowIndex: 3,
        windowName: "mission one",
        windowId: "@9",
      },
    ]);
  });

  it("preserves raw invalid stamps for reconciliation and degrades malformed optional facts", () => {
    expect(
      parseSessionPaneDescriptors([
        "%7\tbad stamp\t\t\tzsh\t/tmp\\twith-tab\tnan\tmain\tnot-a-window\tShell\\twith tab",
        "not-a-pane\tignored",
      ]),
    ).toEqual([
      {
        runtimePaneId: "%7",
        semanticPaneId: "bad stamp",
        role: null,
        type: null,
        currentCommand: "zsh",
        cwd: "/tmp\twith-tab",
        title: "Shell\twith tab",
        windowIndex: null,
        windowName: "main",
        windowId: null,
      },
    ]);
  });
});

describe("geometryFromLeaves", () => {
  // A real captured visible layout feeds the leaves, as in production.
  const leaves = parseLayout(
    "468e,120x40,0,0{60x40,0,0,443,59x40,61,0[59x20,61,0,444,59x19,61,21,445]}",
  )!.leaves;

  it("builds geometry from leaves with tracked active + appMouse flags", () => {
    const out = geometryFromLeaves(leaves, [], "%444", new Map([["%444", true]]), false);
    expect(out).toEqual([
      {
        id: "%443",
        left: 0,
        top: 0,
        width: 60,
        height: 40,
        active: false,
        appMouse: false,
        zoomed: false,
      },
      {
        id: "%444",
        left: 61,
        top: 0,
        width: 59,
        height: 20,
        active: true,
        appMouse: true,
        zoomed: false,
      },
      {
        id: "%445",
        left: 61,
        top: 21,
        width: 59,
        height: 19,
        active: false,
        appMouse: false,
        zoomed: false,
      },
    ]);
  });

  it("falls back to the previous geometry's flags while trackers are silent", () => {
    const prev = [{ ...g("%443", 0, 0, 60, 40, true), appMouse: true }];
    const out = geometryFromLeaves(leaves, prev, "", new Map(), false);
    expect(out[0]).toMatchObject({ id: "%443", active: true, appMouse: true });
    expect(out[1]).toMatchObject({ id: "%444", active: false, appMouse: false });
  });

  it("the tracked active pane overrides a stale previous flag", () => {
    const prev = [g("%443", 0, 0, 60, 40, true)];
    const out = geometryFromLeaves(leaves, prev, "%445", new Map(), false);
    expect(out.find((p) => p.id === "%443")!.active).toBe(false);
    expect(out.find((p) => p.id === "%445")!.active).toBe(true);
  });

  it("stamps the zoom flag on every visible pane", () => {
    const zoomedLeaves = parseLayout("6a6f,100x30,0,0,445")!.leaves;
    const out = geometryFromLeaves(zoomedLeaves, [], "%445", new Map(), true);
    expect(out).toEqual([
      {
        id: "%445",
        left: 0,
        top: 0,
        width: 100,
        height: 30,
        active: true,
        appMouse: false,
        zoomed: true,
      },
    ]);
  });
});
