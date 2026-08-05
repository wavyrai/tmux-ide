import { afterEach, describe, expect, it } from "bun:test";
import {
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellResourceV1SchemaZ,
  ApplicationShellResourceV2SchemaZ,
  ApplicationShellResourceV3SchemaZ,
  AppWindowDocumentV1SchemaZ,
  projectApplicationShellV1,
} from "@tmux-ide/contracts";
import { createApp } from "../server.ts";
import { isHostNameTitle } from "./application-shell.ts";
import { _setTmuxRunner } from "../discovery.ts";
import { _setExecutor } from "../../widgets/lib/pane-comms.ts";
import {
  projectApplicationShellResource,
  projectApplicationShellResourceV3,
  isAgentPane,
  resolveAgentPresentation,
} from "./application-shell.ts";
import { projectApplicationShellAgentGraphOverlay } from "./agent-graph-overlay.ts";
import { fleetSessionIdForName } from "./fleet-catalog.ts";
import { initialApplicationShellAppWindows } from "../../lib/application-shell-app-windows.ts";
import { stableAppWindowInstanceId } from "../../lib/app-window-state.ts";
import { MissionRepository, type MissionRepositorySnapshot } from "../../lib/mission-repository.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function missionSnapshotWithSpawn(): Promise<MissionRepositorySnapshot> {
  const dir = mkdtempSync(join(tmpdir(), "zz-shell-overlay-"));
  restorers.push(() => rmSync(dir, { recursive: true, force: true }));
  const repository = await MissionRepository.open(dir);
  const user = { type: "user" as const };
  const mission = repository.create({ title: "Ship overlay", objective: "o", actor: user });
  const taskA = repository.addTask({ missionId: mission.id, title: "A", actor: user });
  repository.claimTask(mission.id, taskA.id, "fable", user);
  repository.startAttempt({
    missionId: mission.id,
    taskId: taskA.id,
    agent: "fable",
    harness: "claude-code",
    terminal: "%11",
    actor: user,
  });
  const taskB = repository.addTask({ missionId: mission.id, title: "B", actor: user });
  repository.claimTask(mission.id, taskB.id, "codex", user);
  repository.startAttempt({
    missionId: mission.id,
    taskId: taskB.id,
    agent: "codex",
    harness: "claude-code",
    terminal: "%12",
    actor: { type: "agent", id: "fable" },
  });
  return repository.snapshot();
}

const EMPTY_APP_WINDOWS = AppWindowDocumentV1SchemaZ.parse({
  version: 1,
  revision: 0,
  updatedAt: "2026-07-22T10:00:00.000Z",
  windows: {},
  dockRoot: null,
  dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
  floatingOrder: [],
  focusedWindowId: null,
  activeLayoutId: null,
  layouts: {},
});

const restorers: Array<() => void> = [];

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

function liveSession() {
  return {
    name: "product\nworkspace",
    runtimeSessionId: "$4",
    dir: "/Users/example/Product Workspace",
    catalogIssue: "missing-semantic-stamp" as const,
    panes: [
      {
        runtimePaneId: "%11",
        semanticPaneId: "pane.pm",
        index: 0,
        title: "Project manager",
        currentCommand: "claude",
        active: false,
        windowPaneCount: 1,
        role: "lead",
        name: "Fable",
        type: "agent",
      },
      {
        runtimePaneId: "%12",
        semanticPaneId: null,
        index: 1,
        title: "Implementer",
        currentCommand: "codex",
        active: true,
        windowPaneCount: 1,
        role: "teammate",
        name: "Codex",
        type: "agent",
      },
    ],
  } as const;
}

describe("application-shell resource projector", () => {
  it("builds one immutable canonical input with correlated terminal resources", () => {
    const first = projectApplicationShellResource(liveSession());
    const second = projectApplicationShellResource(liveSession());

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(ApplicationShellProjectionInputV1SchemaZ.parse(first)).toEqual(first);
    expect(() => projectApplicationShellV1(first)).not.toThrow();
    expect(first.workspace.sidebar.agents).toEqual([
      expect.objectContaining({ name: "Fable", harness: "claude-code", paneId: "pane.pm" }),
      expect.objectContaining({ name: "Codex", harness: "codex" }),
    ]);
    const fallbackId = first.workspace.sidebar.agents[1]!.paneId!;
    expect(first.focus.appFocusedPaneId).toBe(fallbackId);
    expect(first.terminalInventory).toEqual({
      activeResourceId: fallbackId,
      resources: [
        {
          id: "pane.pm",
          title: "Fable",
          kind: "agent",
          active: false,
          attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
        },
        {
          id: fallbackId,
          title: "Codex",
          kind: "agent",
          active: true,
          attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
        },
      ],
    });
    const encoded = JSON.stringify(first);
    expect(encoded).not.toMatch(/%1[12]/u);
    expect(encoded).not.toContain("$4");
    expect(encoded).not.toContain("/Users/example");
    expect(encoded).not.toContain("currentCommand");
    expect(JSON.stringify(first.terminalInventory)).not.toMatch(/claude|codex/u);
    expect(first.project.name).toBe("product workspace");
  });

  it("publishes absent dock capabilities as disabled zero-count facts", () => {
    const result = projectApplicationShellResource(liveSession());

    expect(result.dock.tools.map(({ id }) => id)).toEqual([
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    for (const tool of result.dock.tools) {
      expect(tool.disabledReason).toContain("not available");
      expect(tool.unreadCount).toBe(0);
    }
    expect(result.dock.tools[0]!.data).toEqual({
      kind: "files",
      selectedResourceId: null,
      fileCount: 0,
    });
    expect(result.dock.tools[1]!.data).toEqual({
      kind: "changes",
      selectedResourceId: null,
      changeCount: 0,
    });
    expect(result.dock.tools[2]!.data).toEqual(
      expect.objectContaining({
        kind: "missions",
        title: "Missions unavailable",
        status: "disconnected",
        goalCount: 0,
        taskCount: 0,
      }),
    );
    expect(result.dock.tools[3]!.data).toEqual({
      kind: "activity",
      eventCount: 0,
      latestEventLabel: null,
    });
  });

  it("marks the V3 Files and Changes dock tools available with bounded counts", () => {
    const result = projectApplicationShellResourceV3(liveSession(), EMPTY_APP_WINDOWS, undefined, {
      fileCount: 214,
      changeCount: 4,
    });
    const files = result.dock.tools.find(({ id }) => id === "files")!;
    const changes = result.dock.tools.find(({ id }) => id === "changes")!;
    expect(files.disabledReason).toBeNull();
    expect(changes.disabledReason).toBeNull();
    expect(files.data).toEqual({ kind: "files", selectedResourceId: null, fileCount: 214 });
    expect(changes.data).toEqual({ kind: "changes", selectedResourceId: null, changeCount: 4 });
    // Missions and activity stay disabled until their own workspace lands.
    expect(result.dock.tools.find(({ id }) => id === "missions")?.disabledReason).toContain(
      "not available",
    );
  });

  it("keeps V3 Files and Changes openable with zero counts when no summary is provided", () => {
    const result = projectApplicationShellResourceV3(liveSession(), EMPTY_APP_WINDOWS);
    const files = result.dock.tools.find(({ id }) => id === "files")!;
    const changes = result.dock.tools.find(({ id }) => id === "changes")!;
    expect(files.disabledReason).toBeNull();
    expect(changes.disabledReason).toBeNull();
    expect(files.data).toEqual({ kind: "files", selectedResourceId: null, fileCount: 0 });
    expect(changes.data).toEqual({ kind: "changes", selectedResourceId: null, changeCount: 0 });
  });

  it("keeps duplicate stamps visible, uniquely keyed, and explicitly unavailable", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: "duplicate-semantic-stamp",
      panes: session.panes.map((pane) => ({ ...pane, semanticPaneId: "pane.duplicate" })),
    });
    const resources = result.terminalInventory!.resources;

    expect(new Set(resources.map(({ id }) => id)).size).toBe(2);
    expect(resources.every(({ id }) => id.startsWith("terminal.discovered."))).toBe(true);
    expect(resources.map(({ attachability }) => attachability)).toEqual([
      { status: "unavailable", reason: "duplicate-semantic-stamp" },
      { status: "unavailable", reason: "duplicate-semantic-stamp" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/%1[12]/u);
  });

  it("keeps fallback identity durable across title, command, and index refreshes", () => {
    const before = projectApplicationShellResource(liveSession());
    const session = liveSession();
    const after = projectApplicationShellResource({
      ...session,
      panes: session.panes.map((pane, index) =>
        index === 1
          ? {
              ...pane,
              index: 9,
              title: "Renamed shell",
              currentCommand: "zsh",
              name: null,
              type: null,
            }
          : pane,
      ),
    });

    expect(after.terminalInventory!.resources[1]!.id).toBe(
      before.terminalInventory!.resources[1]!.id,
    );
    expect(after.terminalInventory!.resources[1]!.title).toBe("Renamed shell");
    expect(after.terminalInventory!.resources[1]!.id).not.toBe("Renamed shell");
  });

  it("keeps malformed stamps and multi-pane windows unavailable", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: "invalid-runtime-proof",
      panes: [
        { ...session.panes[0], semanticPaneId: "%7" },
        { ...session.panes[1], semanticPaneId: "pane.valid" },
      ],
    });

    expect(result.terminalInventory!.resources.map(({ attachability }) => attachability)).toEqual([
      { status: "unavailable", reason: "invalid-runtime-proof" },
      { status: "unavailable", reason: "invalid-runtime-proof" },
    ]);

    // Legacy facts source (no window facts gathered): the historical single-pane
    // gate still emits not-single-pane-window for wire compatibility.
    const multiPane = projectApplicationShellResource({
      ...session,
      catalogIssue: null,
      panes: [{ ...session.panes[0], windowPaneCount: 2 }],
    });
    expect(multiPane.terminalInventory.resources[0]!.attachability).toEqual({
      status: "unavailable",
      reason: "not-single-pane-window",
    });
  });

  it("makes every pane of a stamped multi-pane window attachable with one shared key", () => {
    const session = liveSession();
    const windowStamp = "window.abcdef0123456789";
    const panes = Array.from({ length: 9 }, (_, i) => ({
      ...session.panes[0],
      runtimePaneId: `%${100 + i}`,
      semanticPaneId: `pane.worker-${i}`,
      index: i,
      active: i === 0,
      windowId: "@7",
      windowStamp,
      windowPaneCount: 9,
    }));
    const result = projectApplicationShellResource({ ...session, catalogIssue: null, panes });
    const resources = result.terminalInventory.resources;

    expect(resources).toHaveLength(9);
    for (const [i, resource] of resources.entries()) {
      expect(resource.attachability).toEqual({
        status: "available",
        semanticPaneId: `pane.worker-${i}`,
      });
    }
    const keys = new Set(resources.map((resource) => resource.windowResourceId));
    expect(keys.size).toBe(1);
    const key = [...keys][0]!;
    expect(key).toMatch(/^terminal-window\.[a-f0-9]{20}$/u);
    // Wire-safety: neither the raw window stamp nor the runtime window/pane ids
    // ever reach the resource, only the stamp digest grouping key.
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(windowStamp);
    expect(encoded).not.toMatch(/@7\b/u);
    expect(encoded).not.toMatch(/%10[0-8]/u);
  });

  it("keeps an unstamped multi-pane window honestly unavailable and ungrouped", () => {
    const session = liveSession();
    const panes = [0, 1].map((i) => ({
      ...session.panes[0],
      runtimePaneId: `%${20 + i}`,
      semanticPaneId: `pane.member-${i}`,
      index: i,
      active: i === 0,
      windowId: "@9",
      windowStamp: null,
      windowPaneCount: 2,
    }));
    const result = projectApplicationShellResource({ ...session, catalogIssue: null, panes });

    for (const resource of result.terminalInventory.resources) {
      expect(resource.attachability).toEqual({
        status: "unavailable",
        reason: "missing-window-stamp",
      });
      expect(resource.windowResourceId).toBeUndefined();
    }
  });

  it("keeps a single-pane window attachable and ungrouped through the window path", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: null,
      panes: [
        {
          ...session.panes[0],
          semanticPaneId: "pane.solo",
          active: true,
          windowId: "@3",
          windowStamp: null,
          windowPaneCount: 1,
        },
      ],
    });
    const resource = result.terminalInventory.resources[0]!;

    expect(resource.attachability).toEqual({ status: "available", semanticPaneId: "pane.solo" });
    expect(resource.windowResourceId).toBeUndefined();
  });

  it("fails a partially stamped multi-pane window closed as inconsistent", () => {
    const session = liveSession();
    const panes = [
      {
        ...session.panes[0],
        runtimePaneId: "%30",
        semanticPaneId: "pane.consistent-a",
        index: 0,
        active: true,
        windowId: "@4",
        windowStamp: "window.aaaaaaaaaaaaaaaa",
        windowPaneCount: 2,
      },
      {
        ...session.panes[0],
        runtimePaneId: "%31",
        semanticPaneId: "pane.consistent-b",
        index: 1,
        active: false,
        windowId: "@4",
        windowStamp: null,
        windowPaneCount: 2,
      },
    ];
    const result = projectApplicationShellResource({ ...session, catalogIssue: null, panes });

    for (const resource of result.terminalInventory.resources) {
      expect(resource.attachability).toEqual({
        status: "unavailable",
        reason: "window-stamp-inconsistent",
      });
      expect(resource.windowResourceId).toBeUndefined();
    }
  });

  it("fails a window stamp claimed by two runtime windows closed as duplicate", () => {
    const session = liveSession();
    const windowStamp = "window.dddddddddddddddd";
    const panes = [
      ["@5", "%40", "pane.w1a", true],
      ["@5", "%41", "pane.w1b", false],
      ["@6", "%42", "pane.w2a", false],
      ["@6", "%43", "pane.w2b", false],
    ].map(([windowId, runtimePaneId, semanticPaneId, active], index) => ({
      ...session.panes[0],
      runtimePaneId: runtimePaneId as string,
      semanticPaneId: semanticPaneId as string,
      index,
      active: active as boolean,
      windowId: windowId as string,
      windowStamp,
      windowPaneCount: 2,
    }));
    const result = projectApplicationShellResource({ ...session, catalogIssue: null, panes });

    for (const resource of result.terminalInventory.resources) {
      expect(resource.attachability).toEqual({
        status: "unavailable",
        reason: "duplicate-window-stamp",
      });
    }
  });

  it("never promotes the reserved fallback namespace to attachment authority", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      catalogIssue: null,
      panes: [
        {
          ...session.panes[0],
          semanticPaneId: "terminal.discovered.user-authored",
          active: true,
        },
      ],
    });
    const resource = result.terminalInventory.resources[0]!;

    expect(resource.id).toMatch(/^terminal\.discovered\.[a-f0-9]{20}$/u);
    expect(resource.id).not.toBe("terminal.discovered.user-authored");
    expect(resource.attachability).toEqual({
      status: "unavailable",
      reason: "invalid-runtime-proof",
    });
  });

  it("falls back for every semantic stamp outside attachment target grammar", () => {
    const session = liveSession();
    for (const semanticPaneId of [
      "pane:colon",
      "constructor",
      "__proto__",
      ".leading-dot",
      `pane.${"x".repeat(124)}`,
    ]) {
      const result = projectApplicationShellResource({
        ...session,
        catalogIssue: null,
        panes: [{ ...session.panes[0], semanticPaneId, active: true }],
      });
      const resource = result.terminalInventory.resources[0]!;
      expect(resource.id).toMatch(/^terminal\.discovered\.[a-f0-9]{20}$/u);
      expect(resource.id).not.toBe(semanticPaneId);
      expect(resource.attachability).toEqual({
        status: "unavailable",
        reason: "invalid-runtime-proof",
      });
    }
  });

  it("does not invent application focus when tmux reports no active pane", () => {
    const session = liveSession();
    const result = projectApplicationShellResource({
      ...session,
      panes: session.panes.map((pane) => ({ ...pane, active: false })),
    });

    expect(result.focus).toMatchObject({
      windowActivity: "inactive",
      focusZone: "primary-navigation",
      appFocusedPaneId: null,
      terminalInputPaneId: null,
      layoutSelectedPaneId: null,
    });
    expect(result.terminalInventory!.activeResourceId).toBeNull();
    expect(result.terminalInventory!.resources.every(({ active }) => !active)).toBe(true);
  });

  it("attaches an optional agent-graph overlay to V3 and omits it when absent", () => {
    const base = projectApplicationShellResource(liveSession());
    const sourceIds = base.terminalInventory.resources.map(({ id }) => id);
    const appWindows = initialApplicationShellAppWindows(
      sourceIds,
      base.terminalInventory.activeResourceId,
      "2026-07-22T10:00:00.000Z",
    );
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: liveSession(),
      appWindows,
      missionSnapshot: null,
      nowSec: 1_000_000,
    });
    expect(Object.keys(overlay.nodes)).toHaveLength(2);

    const withOverlay = projectApplicationShellResourceV3(
      liveSession(),
      appWindows,
      undefined,
      undefined,
      overlay,
    );
    expect(withOverlay.agentGraphOverlay).toEqual(overlay);
    const pmWindow = stableAppWindowInstanceId({ kind: "terminal", terminalSourceId: "pane.pm" });
    expect(withOverlay.agentGraphOverlay!.nodes[pmWindow]).toMatchObject({
      status: "working",
      label: "Fable",
    });

    const withoutOverlay = projectApplicationShellResourceV3(liveSession(), appWindows);
    expect(Object.hasOwn(withoutOverlay, "agentGraphOverlay")).toBe(false);

    // The open workspace's own fleet correlation key is minted by the SAME
    // authority the catalog projector and promotion reversal share, so the
    // renderer can mark this session open and drop it from the graph merge. It
    // is an opaque digest — never the raw session name.
    expect(withoutOverlay.fleetSessionId).toBe(fleetSessionIdForName(liveSession().name));
    expect(withoutOverlay.fleetSessionId).toMatch(/^session\.[A-Za-z0-9_-]{16,64}$/u);
    expect(JSON.stringify(withoutOverlay)).not.toContain("product\nworkspace");

    // The overlay never carries a raw pane id, session name, or absolute path.
    const wire = JSON.stringify(withOverlay.agentGraphOverlay);
    expect(wire).not.toMatch(/%1[12]/u);
    expect(wire).not.toContain("Product Workspace");
    expect(wire).not.toContain("/Users/example");
  });
});

describe("agent status composition (facts -> presentation)", () => {
  const NOW = 1_000_000;
  const presentationPane = {
    semanticPaneId: "pane.agent",
    index: 0,
    title: "Agent",
    currentCommand: "claude",
    active: true,
    role: "lead" as const,
    name: "Fable",
    type: "agent" as const,
  };

  it("treats a self-reporting shell pane as an agent pane on the stamp alone", () => {
    // The documented contract: ANY agent can self-report via @agent_state with
    // no integration metadata. A bare shell with a stamp must classify.
    const bareShell = {
      ...presentationPane,
      currentCommand: "zsh",
      role: null,
      type: null,
      agentStateRaw: `working:${NOW}`,
      agentScrapeState: null,
    };
    expect(isAgentPane(bareShell)).toBe(true);
    expect(isAgentPane({ ...bareShell, agentStateRaw: `done:${NOW - 900}` })).toBe(true);
    // Garbage stamps do not classify.
    expect(isAgentPane({ ...bareShell, agentStateRaw: "working" })).toBe(false);
    expect(isAgentPane({ ...bareShell, agentStateRaw: null })).toBe(false);
  });

  it("takes fresh authority over everything and maps each state through the shared table", () => {
    const working = resolveAgentPresentation(
      { ...presentationPane, agentStateRaw: `working:${NOW}`, agentScrapeState: null },
      NOW,
    );
    expect(working).toMatchObject({
      activity: "running",
      attention: false,
      statusSource: "authority",
      detectStatus: "working",
    });

    const blocked = resolveAgentPresentation(
      { ...presentationPane, agentStateRaw: `blocked:${NOW}`, agentScrapeState: null },
      NOW,
    );
    expect(blocked).toMatchObject({
      activity: "waiting",
      attention: true,
      statusSource: "authority",
    });

    const done = resolveAgentPresentation(
      { ...presentationPane, agentStateRaw: `done:${NOW - 10_000}`, agentScrapeState: null },
      NOW,
    );
    // done/idle are terminal and never go stale.
    expect(done).toMatchObject({
      activity: "complete",
      attention: false,
      statusSource: "authority",
    });
  });

  it("falls back to the scrape verdict when authority is stale", () => {
    // working/blocked older than the 600s guard go stale; the discovery layer's
    // screen-scrape verdict is used instead of the dead authority stamp.
    const stale = resolveAgentPresentation(
      { ...presentationPane, agentStateRaw: `working:${NOW - 700}`, agentScrapeState: "blocked" },
      NOW,
    );
    expect(stale).toMatchObject({
      activity: "waiting",
      attention: true,
      statusSource: "scrape",
      detectStatus: "blocked",
    });

    // Scraped-but-unrecognized -> unknown -> disconnected, source "unknown".
    const unknown = resolveAgentPresentation(
      { ...presentationPane, agentStateRaw: null, agentScrapeState: "unknown" },
      NOW,
    );
    expect(unknown).toMatchObject({ activity: "disconnected", statusSource: "unknown" });
  });

  it("keeps the legacy heuristic when the facts source gathered no agent options", () => {
    // agentScrapeState undefined -> pre-inventory discovery -> legacy behavior.
    const active = resolveAgentPresentation({ ...presentationPane, currentCommand: "claude" }, NOW);
    expect(active).toMatchObject({ activity: "running", statusSource: "unknown" });
    const shell = resolveAgentPresentation({ ...presentationPane, currentCommand: "zsh" }, NOW);
    expect(shell).toMatchObject({ activity: "idle", statusSource: "unknown" });
  });

  it("sanitizes hostile display metadata and only trusts it while authority is fresh", () => {
    const hostile = "\x1b[31mrm -rf /\x1b[0m\nEVIL\t".padEnd(200, "x");
    const fresh = resolveAgentPresentation(
      {
        ...presentationPane,
        agentStateRaw: `working:${NOW}`,
        agentStatusTextRaw: hostile,
        agentDisplayNameRaw: hostile,
        agentScrapeState: null,
      },
      NOW,
    );
    // ANSI stripped, control chars collapsed, clamped to 32 chars with ellipsis.
    expect(fresh.displayName).toBeDefined();
    expect(fresh.statusText).toBeDefined();
    expect(fresh.displayName!.length).toBeLessThanOrEqual(32);
    expect(fresh.displayName).not.toContain("\x1b");
    expect(fresh.displayName).not.toContain("\n");
    expect(fresh.displayName).not.toContain("\t");

    // A stale stamp drops the metadata entirely rather than lying beside a scrape.
    const stale = resolveAgentPresentation(
      {
        ...presentationPane,
        agentStateRaw: `working:${NOW - 700}`,
        agentStatusTextRaw: hostile,
        agentDisplayNameRaw: hostile,
        agentScrapeState: "idle",
      },
      NOW,
    );
    expect(stale.displayName).toBeUndefined();
    expect(stale.statusText).toBeUndefined();
  });

  it("surfaces a fresh display name on the projected sidebar agent, sanitized", () => {
    const session = liveSession();
    const result = projectApplicationShellResource(
      {
        ...session,
        panes: [
          {
            ...session.panes[0],
            agentStateRaw: `blocked:${NOW}`,
            agentDisplayNameRaw: "Refactor bot",
            agentStatusTextRaw: "waiting for review",
            agentScrapeState: null,
          },
          { ...session.panes[1], agentStateRaw: `working:${NOW}`, agentScrapeState: null },
        ],
      },
      { nowSec: NOW },
    );
    expect(result.workspace.sidebar.agents[0]).toMatchObject({
      name: "Refactor bot",
      activity: "waiting",
      attention: true,
    });
    expect(result.workspace.sidebar.agents[1]).toMatchObject({
      activity: "running",
      attention: false,
    });
    // Raw option strings never cross the wire — only the sanitized bounded label.
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("waiting for review");
    expect(encoded).not.toMatch(/blocked:|working:/u);
  });
});

describe("GET /api/project/:name/application-shell", () => {
  it("keeps standalone default and explicit V1 discovery while V2/V3 fail closed", async () => {
    restorers.push(
      _setTmuxRunner((args) => {
        if (args[0] === "list-sessions") return "product";
        if (args[0] === "display-message") return "/repo/product";
        if (args[0] === "list-panes") return "%7\tpane.implementer";
        return "";
      }),
    );
    restorers.push(
      _setExecutor((_command, args) =>
        args[0] === "list-panes"
          ? "%7\t0\tImplementer\tcodex\t120\t40\t1\tteammate\tCodex\tagent"
          : "",
      ),
    );
    const app = createApp();

    for (const path of [
      "/api/project/product/application-shell",
      "/api/project/product/application-shell?version=1",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      const body = ApplicationShellResourceV1SchemaZ.parse(await response.json());
      expect(body.resource.workspace.sidebar.agents[0]).toEqual(
        expect.objectContaining({ name: "Codex", paneId: "pane.implementer" }),
      );
      expect(Object.hasOwn(body.resource, "terminalInventory")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("%7");
    }

    const v2 = await app.request("/api/project/product/application-shell?version=2");
    expect(v2.status).toBe(503);
    expect(await v2.json()).toEqual({ error: "Session discovery unavailable" });
    const v3 = await app.request("/api/project/product/application-shell?version=3");
    expect(v3.status).toBe(503);
    expect(await v3.json()).toEqual({ error: "Session discovery unavailable" });
  });

  it("negotiates V3 with the persisted app-window document while preserving V1/V2", async () => {
    const requests: string[] = [];
    const windowLoads: unknown[] = [];
    const appWindows = AppWindowDocumentV1SchemaZ.parse({
      version: 1,
      revision: 4,
      updatedAt: "2026-07-21T00:00:00.000Z",
      windows: {},
      dockRoot: null,
      dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
      floatingOrder: [],
      focusedWindowId: null,
      activeLayoutId: null,
      layouts: {},
    });
    const app = createApp({
      remoteAccess: { bindHostname: "0.0.0.0", token: "secret" },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
      applicationShellInventoryBackend: {
        async discoverApplicationShellSession(name) {
          requests.push(name);
          return { ...liveSession(), name: "product" };
        },
      },
      applicationShellAppWindowBackend: {
        async load(projectDir, terminalSourceIds, focusedTerminalSourceId) {
          windowLoads.push({ projectDir, terminalSourceIds, focusedTerminalSourceId });
          return appWindows;
        },
      },
    });

    const denied = await app.request("/api/project/product/application-shell", {
      headers: { origin: "https://desktop.invalid" },
    });
    expect(denied.status).toBe(401);

    const legacyResponse = await app.request("/api/project/product/application-shell", {
      headers: {
        authorization: "Bearer secret",
        origin: "https://desktop.invalid",
      },
    });
    expect(legacyResponse.status).toBe(200);
    expect(legacyResponse.headers.get("access-control-allow-origin")).toBe("*");
    const legacy = ApplicationShellResourceV1SchemaZ.parse(await legacyResponse.json());
    expect(legacy.daemon.instanceId).toBe("9bcf33b0-c837-4a94-b5e8-c0977f54464f");
    expect(Object.hasOwn(legacy.resource, "terminalInventory")).toBe(false);

    const response = await app.request("/api/project/product/application-shell?version=2", {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    const body = ApplicationShellResourceV2SchemaZ.parse(await response.json());
    expect(body.resource.workspace.sidebar.agents[0]).toEqual(
      expect.objectContaining({ name: "Fable", paneId: "pane.pm" }),
    );
    expect(body.resource.terminalInventory.resources).toHaveLength(2);
    expect(body.resource.terminalInventory.resources[1]).toEqual(
      expect.objectContaining({
        title: "Codex",
        kind: "agent",
        attachability: { status: "unavailable", reason: "missing-semantic-stamp" },
      }),
    );
    expect(JSON.stringify(body)).not.toMatch(/%[79]/u);

    const v3Response = await app.request("/api/project/product/application-shell?version=3", {
      headers: { authorization: "Bearer secret" },
    });
    expect(v3Response.status).toBe(200);
    const v3 = ApplicationShellResourceV3SchemaZ.parse(await v3Response.json());
    expect(v3.resource.appWindows).toEqual(appWindows);
    expect(windowLoads).toEqual([
      {
        projectDir: liveSession().dir,
        terminalSourceIds: v3.resource.terminalInventory.resources.map(({ id }) => id),
        focusedTerminalSourceId: v3.resource.terminalInventory.activeResourceId,
      },
    ]);
    expect(requests).toEqual(["product", "product", "product"]);
  });

  it("degrades only mission history when its repository fails and preserves terminal truth", async () => {
    const app = createApp({
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => ({ ...liveSession(), name: "product" }),
      },
      applicationShellAppWindowBackend: {
        load: async () =>
          AppWindowDocumentV1SchemaZ.parse({
            version: 1,
            revision: 0,
            updatedAt: "2026-07-22T10:00:00.000Z",
            windows: {},
            dockRoot: null,
            dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
            floatingOrder: [],
            focusedWindowId: null,
            activeLayoutId: null,
            layouts: {},
          }),
      },
      applicationShellMissionBackend: {
        load: async () => {
          throw new Error("repository unavailable at /private/secret/project");
        },
      },
    });

    const response = await app.request("/api/project/product/application-shell?version=3");
    expect(response.status).toBe(200);
    const body = ApplicationShellResourceV3SchemaZ.parse(await response.json());
    expect(body.resource.terminalInventory.resources).toHaveLength(2);
    expect(body.resource.appWindows.revision).toBe(0);
    expect(body.resource.missionWorkspace).toEqual({
      status: "degraded",
      reason: "Mission history could not be verified. The terminal workspace remains available.",
    });
    expect(body.resource.dock.tools.find(({ id }) => id === "missions")?.disabledReason).toBeNull();
    expect(body.resource.dock.tools.find(({ id }) => id === "files")?.disabledReason).toBeNull();
    expect(body.resource.dock.tools.find(({ id }) => id === "changes")?.disabledReason).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/\/private\/secret|repository unavailable/u);
  });

  it("assembles a path-free agent-graph overlay into the V3 route response", async () => {
    const snapshot = await missionSnapshotWithSpawn();
    const app = createApp({
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => ({ ...liveSession(), name: "product" }),
      },
      applicationShellAppWindowBackend: {
        load: async (_projectDir, terminalSourceIds, focusedTerminalSourceId) =>
          initialApplicationShellAppWindows(
            terminalSourceIds,
            focusedTerminalSourceId,
            "2026-07-22T10:00:00.000Z",
          ),
      },
      applicationShellMissionBackend: {
        load: async () => ({
          status: "empty",
          counts: { missions: 0, history: 0, activity: 0 },
          missions: [],
          history: [],
          activity: [],
          truncated: false,
        }),
        loadSnapshot: async () => snapshot,
      },
    });

    const response = await app.request("/api/project/product/application-shell?version=3");
    expect(response.status).toBe(200);
    const body = ApplicationShellResourceV3SchemaZ.parse(await response.json());
    const overlay = body.resource.agentGraphOverlay;
    expect(overlay).toBeDefined();
    expect(Object.keys(overlay!.nodes)).toHaveLength(2);
    expect(overlay!.groups).toHaveLength(1);
    expect(overlay!.groups[0]!.label).toBe("Ship overlay");
    expect(overlay!.edges).toHaveLength(1);
    expect(overlay!.edges[0]!.kind).toBe("spawned");
    // The overlay correlated raw %pane targets to durable window ids only.
    expect(JSON.stringify(overlay)).not.toMatch(/%1[12]/u);
  });

  it("omits the overlay but still serves V3 when the mission snapshot fails", async () => {
    const app = createApp({
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => ({ ...liveSession(), name: "product" }),
      },
      applicationShellAppWindowBackend: {
        load: async (_projectDir, terminalSourceIds, focusedTerminalSourceId) =>
          initialApplicationShellAppWindows(
            terminalSourceIds,
            focusedTerminalSourceId,
            "2026-07-22T10:00:00.000Z",
          ),
      },
      applicationShellMissionBackend: {
        load: async () => ({
          status: "degraded",
          reason: "Mission history is unavailable from this daemon.",
        }),
        loadSnapshot: async () => {
          throw new Error("snapshot unavailable at /private/secret/project");
        },
      },
    });

    const response = await app.request("/api/project/product/application-shell?version=3");
    expect(response.status).toBe(200);
    const body = ApplicationShellResourceV3SchemaZ.parse(await response.json());
    // Nodes exist but no mission edges/groups; the overlay may still project the
    // fleet nodes, and the shell read never fails on a mission-snapshot error.
    expect(body.resource.agentGraphOverlay?.edges ?? []).toEqual([]);
    expect(body.resource.agentGraphOverlay?.groups ?? []).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/\/private\/secret|snapshot unavailable/u);
  });

  it("returns the established 404 envelope for an unknown session", async () => {
    const response = await createApp({
      applicationShellInventoryBackend: { discoverApplicationShellSession: async () => null },
    }).request("/api/project/missing/application-shell");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("distinguishes failed tmux discovery from an empty session", async () => {
    const response = await createApp({
      applicationShellInventoryBackend: {
        discoverApplicationShellSession: async () => {
          throw new Error("tmux unavailable");
        },
      },
    }).request("/api/project/product/application-shell?version=2");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Session discovery unavailable" });
  });
});

describe("pane titles", () => {
  it("refuses to present the machine's own name as a pane title", () => {
    // Bug this catches: tmux seeds pane_title with the hostname, so a pane
    // nobody titled shows the user's machine name as its window title — the
    // same useless string on every pane, and their hostname in every
    // screenshot they share.
    expect(isHostNameTitle("Thijs-MacBook-Pro-M4-Pro.fritz.box", "Thijs-MacBook-Pro-M4-Pro")).toBe(
      true,
    );
    expect(isHostNameTitle("Thijs-MacBook-Pro-M4-Pro", "Thijs-MacBook-Pro-M4-Pro.fritz.box")).toBe(
      true,
    );
    expect(isHostNameTitle("build-box", "BUILD-BOX")).toBe(true);
  });

  it("leaves a title a human or a program actually set", () => {
    // The other half: a pane genuinely called something must keep its name,
    // including one that merely starts with the host name.
    expect(isHostNameTitle("claude", "build-box")).toBe(false);
    expect(isHostNameTitle("build-box-worker", "build-box")).toBe(false);
    expect(isHostNameTitle(null, "build-box")).toBe(false);
    expect(isHostNameTitle("", "build-box")).toBe(false);
    // An empty hostname must never make every title vanish.
    expect(isHostNameTitle("anything", "")).toBe(false);
  });
});
