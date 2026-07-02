/**
 * Unit tests for the chrome updater's pure parts — the adopted-session parser
 * and the tick orchestration (with injected io, no live tmux).
 */
import { describe, expect, it, vi } from "vitest";
import { adoptedSessionsFrom, runUpdaterTick } from "./updater.ts";
import { buildStatusline } from "./statusline.ts";
import { paneChip } from "./chip.ts";
import type { AgentEventInit } from "./events.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { PaneDetail } from "../team/sessions.ts";
import type { TeamProject } from "../team/projects.ts";
import type { AttachedClient, ToastTarget } from "./notify.ts";

function project(name: string, overrides: Partial<TeamProject> = {}): TeamProject {
  return {
    name,
    dir: `/p/${name}`,
    hasIdeYml: false,
    gitBranch: null,
    registered: true,
    running: true,
    status: "idle",
    sessions: [{ name, attached: false, windows: 1, panes: 1, status: "idle", windowList: [] }],
    ...overrides,
  };
}

describe("adoptedSessionsFrom", () => {
  it("keeps only sessions whose marker field is exactly 1", () => {
    const lines = ["web\t1", "api\t", "db\t1", "scratch\t0"];
    expect(adoptedSessionsFrom(lines)).toEqual(["web", "db"]);
  });

  it("ignores blank / malformed lines", () => {
    expect(adoptedSessionsFrom(["", "web\t1", "\t1", "lonely"])).toEqual(["web"]);
  });

  it("returns [] for an empty fleet", () => {
    expect(adoptedSessionsFrom([])).toEqual([]);
  });
});

describe("runUpdaterTick", () => {
  it("writes each adopted session its own bar with that session flagged active", () => {
    const projects = [project("web"), project("api")];
    const writes: Array<[string, string]> = [];
    runUpdaterTick({
      listAdopted: () => ["web", "api"],
      computeProjects: () => projects,
      writeStatus: (session, value) => writes.push([session, value]),
    });

    expect(writes.map(([s]) => s)).toEqual(["web", "api"]);
    // Each session gets the bar computed with ITSELF as the active highlight.
    expect(writes[0]![1]).toBe(buildStatusline(projects, "web"));
    expect(writes[1]![1]).toBe(buildStatusline(projects, "api"));
    // The two bars differ precisely in which project is highlighted.
    expect(writes[0]![1]).not.toBe(writes[1]![1]);
  });

  it("computes the fleet ONCE per tick, not per session", () => {
    const computeProjects = vi.fn(() => [project("web")]);
    runUpdaterTick({
      listAdopted: () => ["web", "api", "db"],
      computeProjects,
      writeStatus: () => {},
    });
    expect(computeProjects).toHaveBeenCalledTimes(1);
  });

  it("does no work (no fleet scan, no writes) when nothing is adopted", () => {
    const computeProjects = vi.fn(() => []);
    const writeStatus = vi.fn();
    runUpdaterTick({ listAdopted: () => [], computeProjects, writeStatus });
    expect(computeProjects).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it("appends the fleet's transitions to the injected event sink", () => {
    const appended: AgentEventInit[][] = [];
    const prevState = new Map<string, AgentStatus>([["web", "working"]]);
    runUpdaterTick({
      listAdopted: () => ["web"],
      // web changes working→done; api is seen for the first time.
      computeProjects: () => [
        project("web", {
          status: "done",
          sessions: [{ name: "web", attached: false, windows: 1, panes: 1, status: "done", windowList: [] }],
        }),
        project("api", {
          status: "working",
          sessions: [{ name: "api", attached: false, windows: 1, panes: 1, status: "working", windowList: [] }],
        }),
      ],
      writeStatus: () => {},
      prevState,
      appendEvents: (events) => appended.push(events),
    });

    expect(appended).toEqual([
      [
        { session: "web", from: "working", to: "done" },
        { session: "api", from: null, to: "working" },
      ],
    ]);
    // prevState was mutated in place to the fresh fleet state.
    expect(prevState.get("web")).toBe("done");
    expect(prevState.get("api")).toBe("working");
  });

  it("dispatches a toast when a session transitions to blocked", () => {
    const toasted: ToastTarget[][] = [];
    const clients: AttachedClient[] = [{ client: "/dev/ttys000", session: "other" }];
    const lastNotified = new Map<string, number>();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: () => [
        project("web", {
          status: "blocked",
          sessions: [{ name: "web", attached: false, windows: 1, panes: 1, status: "blocked", windowList: [] }],
        }),
      ],
      writeStatus: () => {},
      prevState: new Map<string, AgentStatus>([["web", "working"]]),
      appendEvents: () => {},
      listClients: () => clients,
      lastNotified,
      now: () => 1000,
      prefs: { toast: true, macos: false },
      sendToasts: (t) => toasted.push(t),
      sendSystem: () => {},
    });

    expect(toasted).toEqual([[{ client: "/dev/ttys000", message: "⚠ web needs you (blocked)" }]]);
    // The debounce map was updated in place for the next tick.
    expect(lastNotified.get("web:blocked")).toBe(1000);
  });

  it("dispatches no toast for a working transition (only blocked/done notify)", () => {
    const sendToasts = vi.fn();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: () => [
        project("web", {
          status: "working",
          sessions: [{ name: "web", attached: false, windows: 1, panes: 1, status: "working", windowList: [] }],
        }),
      ],
      writeStatus: () => {},
      prevState: new Map<string, AgentStatus>([["web", "idle"]]),
      appendEvents: () => {},
      listClients: () => [{ client: "c1", session: "other" }],
      lastNotified: new Map(),
      now: () => 1000,
      prefs: { toast: true, macos: false },
      sendToasts,
      sendSystem: vi.fn(),
    });
    expect(sendToasts).toHaveBeenCalledWith([]);
  });

  it("does not call the event sink when nothing transitioned", () => {
    const appendEvents = vi.fn();
    const prevState = new Map<string, AgentStatus>([["web", "idle"]]);
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: () => [project("web")], // status "idle" — unchanged
      writeStatus: () => {},
      prevState,
      appendEvents,
    });
    expect(appendEvents).not.toHaveBeenCalled();
  });
});

describe("runUpdaterTick — pane chips", () => {
  // A fake fleet scan that feeds fixed pane details through the tick's onPane.
  function withPanes(panes: PaneDetail[]) {
    return (onPane: (pane: PaneDetail) => void): TeamProject[] => {
      for (const pane of panes) onPane(pane);
      return [project("web")];
    };
  }

  it("writes each adopted pane its `agent · status` chip", () => {
    const writes: Array<[string, string]> = [];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working" },
        { sessionName: "web", paneId: "%2", agent: null, status: "idle" },
      ]),
      writeStatus: () => {},
      writeChip: (paneId, value) => writes.push([paneId, value]),
      chipCache: new Map(),
    });
    expect(writes).toEqual([
      ["%1", paneChip("claude", "working")],
      ["%2", ""], // non-agent pane → empty chip (border falls back to title)
    ]);
  });

  it("skips panes of non-adopted sessions", () => {
    const writeChip = vi.fn();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working" },
        { sessionName: "other", paneId: "%9", agent: "codex", status: "blocked" },
      ]),
      writeStatus: () => {},
      writeChip,
      chipCache: new Map(),
    });
    expect(writeChip).toHaveBeenCalledTimes(1);
    expect(writeChip).toHaveBeenCalledWith("%1", paneChip("claude", "working"));
  });

  it("only writes a chip when its value CHANGED (uses the per-pane cache)", () => {
    const writeChip = vi.fn();
    const chipCache = new Map<string, string>();
    const deps = {
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working" as AgentStatus },
      ]),
      writeStatus: () => {},
      writeChip,
      chipCache,
    };
    runUpdaterTick(deps);
    runUpdaterTick(deps); // unchanged — must NOT rewrite
    expect(writeChip).toHaveBeenCalledTimes(1);
    expect(chipCache.get("%1")).toBe(paneChip("claude", "working"));
  });

  it("rewrites the chip when the pane's status changes", () => {
    const writeChip = vi.fn();
    const chipCache = new Map<string, string>();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working" },
      ]),
      writeStatus: () => {},
      writeChip,
      chipCache,
    });
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "blocked" },
      ]),
      writeStatus: () => {},
      writeChip,
      chipCache,
    });
    expect(writeChip).toHaveBeenCalledTimes(2);
    expect(writeChip).toHaveBeenLastCalledWith("%1", paneChip("claude", "blocked"));
  });

  it("does nothing without a writeChip/chipCache wired (bar-only callers)", () => {
    // No writeChip/chipCache — the tick still writes bars, just no chips.
    const writes: string[] = [];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working" },
      ]),
      writeStatus: (s) => writes.push(s),
    });
    expect(writes).toEqual(["web"]);
  });
});
