/**
 * Unit tests for the chrome updater's pure parts — the adopted-session parser
 * and the tick orchestration (with injected io, no live tmux).
 */
import { describe, expect, it, vi } from "vitest";
import {
  adoptedSessionsFrom,
  createUnreachableCounter,
  diffPaneTransitions,
  runUpdaterTick,
  updaterProbeArgv,
  updaterSpawnArgv,
  UPDATER_SESSION,
  UPDATER_UNREACHABLE_EXIT_TICKS,
  updateSegment,
  type PendingOsPing,
} from "./updater.ts";
import { buildStatusline } from "./statusline.ts";
import { DEFAULT_THEME } from "../../lib/app-config.ts";
import type { UpdateStatus } from "../../lib/update-check.ts";
import { paneChip } from "./chip.ts";
import type { AgentEventInit } from "./events.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { PaneDetail } from "../team/sessions.ts";
import type { TeamProject } from "../team/projects.ts";
import type {
  AttachedClient,
  NotificationPrefs,
  SystemNotification,
  ToastTarget,
  TtyWrite,
} from "./notify.ts";

/** A fully-enabled prefs object for the notification-dispatch tests. The
 *  M25.2 channels default OFF/immediate here so the M25.1 tests keep asserting
 *  the immediate paths; the M25.2 suite opts in per test. */
const FULL_PREFS: NotificationPrefs = {
  enabled: true,
  toast: true,
  macos: false,
  terminal: false,
  delaySeconds: 0,
  sound: "none",
  onBlocked: true,
  onDone: true,
  quietHours: null,
};

/**
 * PaneDetail factory — the chip/notify tests only care about identity + agent +
 * status; the capture fields (pid/dir/sessionId) get inert defaults.
 */
function pd(
  over: Pick<PaneDetail, "sessionName" | "paneId" | "agent" | "status"> & Partial<PaneDetail>,
): PaneDetail {
  return { windowIndex: 1, pid: 0, dir: "/", sessionId: null, ...over };
}

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
          sessions: [
            { name: "web", attached: false, windows: 1, panes: 1, status: "done", windowList: [] },
          ],
        }),
        project("api", {
          status: "working",
          sessions: [
            {
              name: "api",
              attached: false,
              windows: 1,
              panes: 1,
              status: "working",
              windowList: [],
            },
          ],
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

  it("dispatches a toast when a PANE transitions to blocked, naming the agent + location", () => {
    const toasted: ToastTarget[][] = [];
    const clients: AttachedClient[] = [{ client: "/dev/ttys000", session: "other" }];
    const lastNotified = new Map<string, number>();
    const persistNotified = vi.fn();
    runUpdaterTick({
      listAdopted: () => ["web"],
      // Emit a blocked claude pane — pane transitions drive the notification.
      computeProjects: (onPane) => {
        onPane({
          sessionName: "web",
          paneId: "%3",
          agent: "claude",
          status: "blocked",
          windowIndex: 1,
        });
        return [
          project("web", {
            status: "blocked",
            sessions: [
              {
                name: "web",
                attached: false,
                windows: 1,
                panes: 1,
                status: "blocked",
                windowList: [],
              },
            ],
          }),
        ];
      },
      writeStatus: () => {},
      prevState: new Map<string, AgentStatus>([["web", "working"]]),
      appendEvents: () => {},
      prevPaneState: new Map<string, AgentStatus>([["%3", "working"]]),
      listClients: () => clients,
      lastNotified,
      now: () => 1000,
      prefs: FULL_PREFS,
      sendToasts: (t) => toasted.push(t),
      sendSystem: () => {},
      locatePane: (paneId) => (paneId === "%3" ? "web:1.2" : paneId),
      persistNotified,
    });

    expect(toasted).toEqual([
      [{ client: "/dev/ttys000", message: "claude blocked · web:1.2 — needs input" }],
    ]);
    // The debounce map was updated in place (per-pane key) AND persisted.
    expect(lastNotified.get("%3:blocked")).toBe(1000);
    expect(persistNotified).toHaveBeenCalledWith(lastNotified);
  });

  it("does not re-ping a pane the updater sees for the FIRST time (restart grace)", () => {
    const sendToasts = vi.fn();
    const sendSystem = vi.fn();
    const persistNotified = vi.fn();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: (onPane) => {
        // Already blocked when the (re)started updater first looks.
        onPane({
          sessionName: "web",
          paneId: "%3",
          agent: "claude",
          status: "blocked",
          windowIndex: 0,
        });
        return [project("web")];
      },
      writeStatus: () => {},
      prevPaneState: new Map(), // fresh start — no pane ever seen
      listClients: () => [{ client: "c1", session: "other" }],
      lastNotified: new Map(),
      now: () => 1000,
      prefs: FULL_PREFS,
      sendToasts,
      sendSystem,
      persistNotified,
    });
    expect(sendToasts).toHaveBeenCalledWith([]);
    expect(sendSystem).not.toHaveBeenCalled();
    expect(persistNotified).not.toHaveBeenCalled();
  });

  it("dispatches no toast for a working transition (only blocked/done notify)", () => {
    const sendToasts = vi.fn();
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: (onPane) => {
        onPane({
          sessionName: "web",
          paneId: "%3",
          agent: "claude",
          status: "working",
          windowIndex: 0,
        });
        return [project("web")];
      },
      writeStatus: () => {},
      prevPaneState: new Map<string, AgentStatus>([["%3", "idle"]]),
      listClients: () => [{ client: "c1", session: "other" }],
      lastNotified: new Map(),
      now: () => 1000,
      prefs: FULL_PREFS,
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

  // Drive a single blocked PANE transition through the notification path with
  // the given prefs / clock, returning what each channel received.
  function runBlockedTick(opts: {
    prefs: NotificationPrefs;
    now?: number;
    lastNotified?: Map<string, number>;
  }): { toasts: ToastTarget[][]; system: SystemNotification[] } {
    const toasts: ToastTarget[][] = [];
    const system: SystemNotification[] = [];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: (onPane) => {
        onPane({
          sessionName: "web",
          paneId: "%1",
          agent: null,
          status: "blocked",
          windowIndex: 0,
        });
        return [project("web")];
      },
      writeStatus: () => {},
      prevPaneState: new Map<string, AgentStatus>([["%1", "working"]]),
      listClients: () => [{ client: "c1", session: "other" }],
      lastNotified: opts.lastNotified ?? new Map(),
      now: () => opts.now ?? 1000,
      prefs: opts.prefs,
      sendToasts: (t) => toasts.push(t),
      sendSystem: (n) => system.push(n),
    });
    return { toasts, system };
  }

  it("sends nothing when notifications are disabled (master switch)", () => {
    const { toasts, system } = runBlockedTick({ prefs: { ...FULL_PREFS, enabled: false } });
    expect(toasts).toEqual([]);
    expect(system).toEqual([]);
  });

  it("suppresses a blocked ping when onBlocked is off", () => {
    const { toasts } = runBlockedTick({ prefs: { ...FULL_PREFS, onBlocked: false } });
    expect(toasts).toEqual([[]]); // dispatch ran, but the blocked state was filtered out
  });

  it("skips the macOS banner inside quiet hours but still toasts", () => {
    // 02:00 local sits inside 22:00–08:00.
    const nightMs = new Date(2026, 0, 1, 2, 0).getTime();
    const { toasts, system } = runBlockedTick({
      prefs: { ...FULL_PREFS, macos: true, quietHours: { start: "22:00", end: "08:00" } },
      now: nightMs,
    });
    expect(system).toEqual([]); // banner suppressed
    expect(toasts).toEqual([[{ client: "c1", message: "agent blocked · web — needs input" }]]);
  });

  it("fires the macOS banner outside quiet hours", () => {
    const dayMs = new Date(2026, 0, 1, 12, 0).getTime();
    const { system } = runBlockedTick({
      prefs: { ...FULL_PREFS, macos: true, quietHours: { start: "22:00", end: "08:00" } },
      now: dayMs,
    });
    expect(system).toEqual([
      {
        message: "agent blocked · web — needs input",
        session: "web",
        state: "blocked",
        paneId: "%1",
        windowIndex: 0,
      },
    ]);
  });
});

describe("runUpdaterTick — delayed, re-verified OS channels (M25.2)", () => {
  /** The M25.2 channels all on: banner + terminal escape + sound-on-blocked. */
  const OS_PREFS: NotificationPrefs = {
    ...FULL_PREFS,
    macos: true,
    terminal: true,
    sound: "blocked",
    delaySeconds: 2,
  };

  /**
   * A minimal multi-tick rig: one agent pane whose status/existence the test
   * mutates between ticks, every channel captured, the pending queue and the
   * debounce/pane maps persistent across ticks — the loop's real shape.
   */
  function tickRig(prefs: NotificationPrefs) {
    const state = {
      status: "working" as AgentStatus,
      paneGone: false,
      now: 0,
      prefs,
      focusPanes: null as string[] | null,
    };
    const prevPaneState = new Map<string, AgentStatus>();
    const pendingPings: PendingOsPing[] = [];
    const lastNotified = new Map<string, number>();
    const toasts: ToastTarget[][] = [];
    const system: SystemNotification[] = [];
    const ttyWrites: TtyWrite[][] = [];
    let sounds = 0;
    const tick = () =>
      runUpdaterTick({
        listAdopted: () => ["web"],
        computeProjects: (onPane) => {
          if (!state.paneGone) {
            onPane(pd({ sessionName: "web", paneId: "%1", agent: "claude", status: state.status }));
          }
          return [project("web")];
        },
        writeStatus: () => {},
        prevPaneState,
        pendingPings,
        listClients: () => [
          {
            client: "c1",
            session: "other",
            windowIndex: 0,
            tty: "/dev/t1",
            termname: "xterm-256color",
          },
        ],
        lastNotified,
        now: () => state.now,
        prefs: state.prefs,
        sendToasts: (t) => toasts.push(t),
        sendSystem: (n) => system.push(n),
        sendTerminal: (w) => ttyWrites.push(w),
        playSound: () => {
          sounds += 1;
        },
        appFocus: () =>
          state.focusPanes
            ? { ts: state.now, attached: true, session: "web", panes: state.focusPanes }
            : null,
      });
    return {
      state,
      pendingPings,
      toasts,
      system,
      ttyWrites,
      sounds: () => sounds,
      tick,
    };
  }

  it("toasts immediately but queues the OS channels, firing them once the state HELD", () => {
    const rig = tickRig(OS_PREFS);
    rig.tick(); // first sight — working, nothing pings
    rig.state.status = "blocked";
    rig.state.now = 1000;
    rig.tick(); // the transition: toast now, OS channels queued for +2s
    expect(rig.toasts.flat()).toHaveLength(1);
    expect(rig.system).toEqual([]);
    expect(rig.ttyWrites).toEqual([]);
    expect(rig.sounds()).toBe(0);
    expect(rig.pendingPings).toHaveLength(1);
    rig.state.now = 2000;
    rig.tick(); // not due yet
    expect(rig.system).toEqual([]);
    rig.state.now = 3200; // past dueAt (1000 + 2000)
    rig.tick(); // still blocked → everything fires
    expect(rig.system).toHaveLength(1);
    expect(rig.system[0]).toMatchObject({ state: "blocked", paneId: "%1", session: "web" });
    expect(rig.ttyWrites).toHaveLength(1);
    expect(rig.ttyWrites[0]![0]!.tty).toBe("/dev/t1");
    expect(rig.ttyWrites[0]![0]!.data).toContain("\x1b]9;");
    expect(rig.ttyWrites[0]![0]!.data.endsWith("\x07\x07")).toBe(true); // OSC 9 BEL + the bell BEL
    expect(rig.sounds()).toBe(1);
    expect(rig.pendingPings).toEqual([]);
    // no double fire on the next tick
    rig.state.now = 5000;
    rig.tick();
    expect(rig.system).toHaveLength(1);
  });

  it("a flap inside the window fires NOTHING OS-level (the toast already informed)", () => {
    const rig = tickRig(OS_PREFS);
    rig.tick();
    rig.state.status = "blocked";
    rig.state.now = 1000;
    rig.tick(); // blocked → queued
    expect(rig.toasts.flat()).toHaveLength(1);
    rig.state.status = "working";
    rig.state.now = 1800; // flips back within 1s of the stamp
    rig.tick();
    rig.state.now = 3200;
    rig.tick(); // due — but the pane is working again
    expect(rig.system).toEqual([]);
    expect(rig.ttyWrites).toEqual([]);
    expect(rig.sounds()).toBe(0);
    expect(rig.pendingPings).toEqual([]);
  });

  it("a vanished pane cancels its pending ping", () => {
    const rig = tickRig(OS_PREFS);
    rig.tick();
    rig.state.status = "blocked";
    rig.state.now = 1000;
    rig.tick();
    rig.state.paneGone = true;
    rig.state.now = 3200;
    rig.tick();
    expect(rig.system).toEqual([]);
    expect(rig.pendingPings).toEqual([]);
  });

  it("delaySeconds 0 fires the OS channels immediately", () => {
    const rig = tickRig({ ...OS_PREFS, delaySeconds: 0 });
    rig.tick();
    rig.state.status = "blocked";
    rig.state.now = 1000;
    rig.tick();
    expect(rig.system).toHaveLength(1);
    expect(rig.ttyWrites).toHaveLength(1);
    expect(rig.sounds()).toBe(1);
    expect(rig.pendingPings).toEqual([]);
  });

  it("quiet hours gate EVERY OS channel but never the toast", () => {
    const night = new Date(2026, 0, 1, 2, 0).getTime(); // inside 22:00–08:00
    const rig = tickRig({
      ...OS_PREFS,
      delaySeconds: 0,
      quietHours: { start: "22:00", end: "08:00" },
    });
    rig.state.now = night;
    rig.tick();
    rig.state.status = "blocked";
    rig.state.now = night + 1000;
    rig.tick();
    expect(rig.toasts.flat()).toHaveLength(1); // the in-app note stays on
    expect(rig.system).toEqual([]);
    expect(rig.ttyWrites).toEqual([]);
    expect(rig.sounds()).toBe(0);
  });

  it("app focus at FIRE time cancels a queued ping (the user got there on their own)", () => {
    const rig = tickRig(OS_PREFS);
    rig.tick();
    rig.state.status = "blocked";
    rig.state.now = 1000;
    rig.tick(); // queued (no focus yet)
    rig.state.focusPanes = ["%1"]; // user opens the app on that pane
    rig.state.now = 3200;
    rig.tick();
    expect(rig.system).toEqual([]);
    expect(rig.pendingPings).toEqual([]);
  });

  it("the sound tri-state routes at fire time: 'all' rings on done, 'blocked' stays quiet", () => {
    const onDone = (sound: NotificationPrefs["sound"]) => {
      const rig = tickRig({ ...OS_PREFS, delaySeconds: 0, sound });
      rig.tick();
      rig.state.status = "done";
      rig.state.now = 1000;
      rig.tick();
      return rig.sounds();
    };
    expect(onDone("all")).toBe(1);
    expect(onDone("blocked")).toBe(0);
    expect(onDone("none")).toBe(0);
  });
});

describe("diffPaneTransitions", () => {
  const pane = (
    paneId: string,
    status: AgentStatus,
    agent: string | null = "claude",
  ): PaneDetail => ({ sessionName: "web", paneId, agent, status, windowIndex: 1 });

  it("emits a located, enriched event for a pane's blocked/done transition", () => {
    const prev = new Map<string, AgentStatus>([["%2", "working"]]);
    const events = diffPaneTransitions(prev, [pane("%2", "blocked")], (id) =>
      id === "%2" ? "web:1.2" : id,
    );
    expect(events).toEqual([
      {
        session: "web",
        from: "working",
        to: "blocked",
        paneId: "%2",
        windowIndex: 1,
        agent: "claude",
        location: "web:1.2",
      },
    ]);
    // prev was mutated in place to the fresh pane state.
    expect(prev.get("%2")).toBe("blocked");
  });

  it("emits first-sight events with from: null and does NOT locate them", () => {
    const locate = vi.fn((id: string) => id);
    const events = diffPaneTransitions(new Map(), [pane("%2", "blocked")], locate);
    expect(events).toEqual([
      {
        session: "web",
        from: null,
        to: "blocked",
        paneId: "%2",
        windowIndex: 1,
        agent: "claude",
        location: "web",
      },
    ]);
    expect(locate).not.toHaveBeenCalled();
  });

  it("does not locate a non-notifiable transition either (no tmux call for a non-ping)", () => {
    const locate = vi.fn((id: string) => id);
    const prev = new Map<string, AgentStatus>([["%2", "blocked"]]);
    const events = diffPaneTransitions(prev, [pane("%2", "working")], locate);
    expect(events).toHaveLength(1);
    expect(events[0]!.location).toBe("web");
    expect(locate).not.toHaveBeenCalled();
  });

  it("emits one event PER PANE — a second agent blocking in the same session is seen", () => {
    const prev = new Map<string, AgentStatus>([
      ["%1", "blocked"],
      ["%2", "working"],
    ]);
    const events = diffPaneTransitions(prev, [pane("%1", "blocked"), pane("%2", "blocked")]);
    expect(events.map((e) => e.paneId)).toEqual(["%2"]);
  });

  it("drops vanished panes from the state and emits nothing for them", () => {
    const prev = new Map<string, AgentStatus>([["%9", "working"]]);
    const events = diffPaneTransitions(prev, []);
    expect(events).toEqual([]);
    expect(prev.size).toBe(0);
  });
});

describe("createUnreachableCounter", () => {
  it("trips only after N consecutive misses and resets on any success", () => {
    const shouldExit = createUnreachableCounter(3);
    expect(shouldExit(false)).toBe(false);
    expect(shouldExit(false)).toBe(false);
    expect(shouldExit(true)).toBe(false); // reset
    expect(shouldExit(false)).toBe(false);
    expect(shouldExit(false)).toBe(false);
    expect(shouldExit(false)).toBe(true); // 3 in a row
  });

  it("defaults to the exported threshold", () => {
    const shouldExit = createUnreachableCounter();
    for (let i = 0; i < UPDATER_UNREACHABLE_EXIT_TICKS - 1; i++) {
      expect(shouldExit(false)).toBe(false);
    }
    expect(shouldExit(false)).toBe(true);
  });
});

describe("updater argv builders (the app's async front door)", () => {
  it("probes with an exact-match has-session and spawns the loop detached", () => {
    expect(updaterProbeArgv()).toEqual(["has-session", "-t", `=${UPDATER_SESSION}`]);
    expect(updaterSpawnArgv()).toEqual([
      "new-session",
      "-d",
      "-s",
      UPDATER_SESSION,
      "exec tmux-ide chrome-updater",
    ]);
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
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working", windowIndex: 0 },
        { sessionName: "web", paneId: "%2", agent: null, status: "idle", windowIndex: 0 },
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
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working", windowIndex: 0 },
        { sessionName: "other", paneId: "%9", agent: "codex", status: "blocked", windowIndex: 0 },
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
        {
          sessionName: "web",
          paneId: "%1",
          agent: "claude",
          status: "working" as AgentStatus,
          windowIndex: 0,
        },
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
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working", windowIndex: 0 },
      ]),
      writeStatus: () => {},
      writeChip,
      chipCache,
    });
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: withPanes([
        { sessionName: "web", paneId: "%1", agent: "claude", status: "blocked", windowIndex: 0 },
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
        { sessionName: "web", paneId: "%1", agent: "claude", status: "working", windowIndex: 0 },
      ]),
      writeStatus: (s) => writes.push(s),
    });
    expect(writes).toEqual(["web"]);
  });
});

describe("updateSegment", () => {
  it("renders a clickable `⬆ v<latest>` chip when an update is available", () => {
    const seg = updateSegment({ latest: "9.9.9", updateAvailable: true }, DEFAULT_THEME);
    expect(seg).toContain("⬆ v9.9.9");
    expect(seg).toContain(`#[fg=${DEFAULT_THEME.accent}]`);
    // wrapped in the `update` mouse range so the click router can float the popup
    expect(seg).toContain("#[range=user|update]");
    expect(seg).toContain("#[norange]");
  });

  it("is empty when no update is available (takes no space on the bar)", () => {
    expect(updateSegment({ latest: null, updateAvailable: false }, DEFAULT_THEME)).toBe("");
    expect(updateSegment({ latest: "2.6.0", updateAvailable: false }, DEFAULT_THEME)).toBe("");
  });
});

describe("runUpdaterTick — update surface", () => {
  const available: UpdateStatus = { latest: "9.9.9", updateAvailable: true };

  it("calls maybeCheckForUpdate once per tick and threads the segment into every bar", () => {
    const projects = [project("web"), project("api")];
    const check = vi.fn((): UpdateStatus => available);
    const writes: Array<[string, string]> = [];
    runUpdaterTick({
      listAdopted: () => ["web", "api"],
      computeProjects: () => projects,
      writeStatus: (s, v) => writes.push([s, v]),
      maybeCheckForUpdate: check,
    });
    expect(check).toHaveBeenCalledTimes(1);
    const extra = updateSegment(available, DEFAULT_THEME);
    // Each bar equals the buildStatusline with the update segment threaded in.
    expect(writes[0]![1]).toBe(buildStatusline(projects, "web", 12, DEFAULT_THEME, extra));
    expect(writes[1]![1]).toBe(buildStatusline(projects, "api", 12, DEFAULT_THEME, extra));
    expect(writes[0]![1]).toContain("⬆ v9.9.9");
  });

  it("threads NO segment when no update is available", () => {
    const projects = [project("web")];
    const writes: string[] = [];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: () => projects,
      writeStatus: (_s, v) => writes.push(v),
      maybeCheckForUpdate: () => ({ latest: null, updateAvailable: false }),
    });
    expect(writes[0]).toBe(buildStatusline(projects, "web"));
    expect(writes[0]).not.toContain("⬆");
  });

  it("toasts every client once per version via markUpdateNotified", () => {
    const clients: AttachedClient[] = [
      { client: "/dev/ttys000", session: "web" },
      { client: "/dev/ttys001", session: "api" },
    ];
    const toasted: ToastTarget[][] = [];
    const notified = new Set<string>();
    const deps = {
      listAdopted: () => ["web"],
      computeProjects: () => [project("web")],
      writeStatus: () => {},
      maybeCheckForUpdate: (): UpdateStatus => available,
      // Mirrors the real markUpdateNotified: true the first time per version.
      markUpdateNotified: (v: string) => (notified.has(v) ? false : (notified.add(v), true)),
      listClients: () => clients,
      sendToasts: (t: ToastTarget[]) => toasted.push(t),
    };
    runUpdaterTick(deps);
    runUpdaterTick(deps); // second tick — already notified, no re-toast
    expect(toasted).toHaveLength(1);
    expect(toasted[0]).toEqual([
      { client: "/dev/ttys000", message: "⬆ tmux-ide v9.9.9 available — run: tmux-ide update" },
      { client: "/dev/ttys001", message: "⬆ tmux-ide v9.9.9 available — run: tmux-ide update" },
    ]);
  });

  it("suppresses the update toast when the toast pref is off", () => {
    const toasted: ToastTarget[][] = [];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: () => [project("web")],
      writeStatus: () => {},
      maybeCheckForUpdate: (): UpdateStatus => available,
      markUpdateNotified: () => true,
      listClients: () => [{ client: "/dev/ttys000", session: "web" }],
      sendToasts: (t) => toasted.push(t),
      prefs: { toast: false, macos: false },
    });
    expect(toasted).toHaveLength(0);
  });
});

describe("runUpdaterTick — session-id capture", () => {
  it("forwards this tick's pane details to captureSessionIds", () => {
    const seen: PaneDetail[][] = [];
    const panes = [
      pd({ sessionName: "web", paneId: "%1", agent: "codex", status: "working" }),
      pd({ sessionName: "web", paneId: "%2", agent: null, status: "idle" }),
    ];
    runUpdaterTick({
      listAdopted: () => ["web"],
      computeProjects: (onPane) => {
        for (const pane of panes) onPane(pane);
        return [project("web")];
      },
      writeStatus: () => {},
      captureSessionIds: (p) => seen.push(p),
    });
    expect(seen).toEqual([panes]);
  });

  it("is optional — a tick without the capture dep still runs", () => {
    expect(() =>
      runUpdaterTick({
        listAdopted: () => ["web"],
        computeProjects: () => [project("web")],
        writeStatus: () => {},
      }),
    ).not.toThrow();
  });
});
