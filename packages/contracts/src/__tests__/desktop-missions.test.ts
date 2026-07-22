import { describe, expect, it } from "vitest";

import {
  ApplicationShellProjectionInputV3SchemaZ,
  COHESION_FIXTURE_V1,
  DESKTOP_MISSION_MAX_ACTIVITY,
  DesktopMissionWorkspaceResourceSchemaZ,
} from "../index.ts";

const proof = {
  hasProof: false,
  proofCount: 0,
  notesCount: 0,
  noProofReasons: ["Implementation proof has not been recorded yet."],
  tests: { suites: 0, passed: 0, failed: 0, skipped: 0, total: 0 },
  commitCount: 0,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  pullRequestCount: 0,
  artifactCount: 0,
} as const;

const mission = {
  id: "mis_alpha",
  title: "Desktop mission journey",
  summary: "Show durable status, progress, evidence, and recovery.",
  status: "started",
  column: "running",
  updatedAt: "2026-07-22T10:00:00.000Z",
  durationMs: 1_000,
  progress: {
    total: 1,
    planned: 0,
    running: 1,
    review: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    done: 0,
  },
  blockedCount: 0,
  latestAttempt: null,
  proof,
} as const;

const activity = {
  id: "activity.1",
  sequence: 1,
  timestamp: "2026-07-22T10:00:00.000Z",
  missionId: "mis_alpha",
  type: "mission.started",
  label: "Mission started",
  actor: { type: "user", label: "Project manager" },
} as const;

describe("desktop mission workspace contract", () => {
  it("accepts bounded, path-free ready, empty, and degraded resources", () => {
    expect(
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "ready",
        counts: { missions: 1, history: 0, activity: 1 },
        missions: [mission],
        history: [],
        activity: [activity],
        truncated: false,
      }).status,
    ).toBe("ready");
    expect(
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "empty",
        counts: { missions: 0, history: 0, activity: 0 },
        missions: [],
        history: [],
        activity: [],
        truncated: false,
      }).status,
    ).toBe("empty");
    expect(
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "degraded",
        reason: "Mission history is temporarily unavailable.",
      }).status,
    ).toBe("degraded");
  });

  it("rejects authority-bearing fields and unbounded activity payloads", () => {
    expect(() =>
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "ready",
        counts: { missions: 1, history: 0, activity: 1 },
        missions: [{ ...mission, worktree: "/private/repo" }],
        history: [],
        activity: [activity],
        truncated: false,
      }),
    ).toThrow();
    expect(() =>
      DesktopMissionWorkspaceResourceSchemaZ.parse({
        status: "ready",
        counts: { missions: 0, history: 0, activity: DESKTOP_MISSION_MAX_ACTIVITY + 1 },
        missions: [],
        history: [],
        activity: Array.from({ length: DESKTOP_MISSION_MAX_ACTIVITY + 1 }, (_, index) => ({
          ...activity,
          id: `activity.${index + 1}`,
          sequence: index + 1,
        })),
        truncated: true,
      }),
    ).toThrow();
  });

  it("keeps the V3 mission projection optional for existing resource producers", () => {
    const parsed = ApplicationShellProjectionInputV3SchemaZ.safeParse({
      project: COHESION_FIXTURE_V1.project,
      workspace: COHESION_FIXTURE_V1.workspace,
      dock: COHESION_FIXTURE_V1.dock,
      focus: COHESION_FIXTURE_V1.focus,
      connection: COHESION_FIXTURE_V1.connection,
      terminalInventory: {
        resources: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
          id: agent.paneId,
          title: agent.name,
          kind: "agent" as const,
          active: agent.paneId === COHESION_FIXTURE_V1.focus.appFocusedPaneId,
          attachability: { status: "available" as const, semanticPaneId: agent.paneId },
        })),
        activeResourceId: COHESION_FIXTURE_V1.focus.appFocusedPaneId,
      },
      appWindows: {
        version: 1,
        revision: 0,
        updatedAt: "2026-07-22T10:00:00.000Z",
        windows: {},
        dockRoot: null,
        dockState: {
          mode: "collapsed",
          preferredHeight: null,
          focusZone: "canvas",
        },
        floatingOrder: [],
        focusedWindowId: null,
        activeLayoutId: null,
        layouts: {},
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an optional agent-graph overlay on V3 and rejects a malformed one", () => {
    const baseInput = {
      project: COHESION_FIXTURE_V1.project,
      workspace: COHESION_FIXTURE_V1.workspace,
      dock: COHESION_FIXTURE_V1.dock,
      focus: COHESION_FIXTURE_V1.focus,
      connection: COHESION_FIXTURE_V1.connection,
      terminalInventory: {
        resources: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
          id: agent.paneId,
          title: agent.name,
          kind: "agent" as const,
          active: agent.paneId === COHESION_FIXTURE_V1.focus.appFocusedPaneId,
          attachability: { status: "available" as const, semanticPaneId: agent.paneId },
        })),
        activeResourceId: COHESION_FIXTURE_V1.focus.appFocusedPaneId,
      },
      appWindows: {
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
      },
    };
    const node = {
      windowId: "window-terminal-pane.pm-0-abc",
      status: "working" as const,
      statusSource: "authority" as const,
      attention: false,
      label: "Fable",
    };

    const withOverlay = ApplicationShellProjectionInputV3SchemaZ.safeParse({
      ...baseInput,
      agentGraphOverlay: {
        nodes: { [node.windowId]: node },
        edges: [],
        groups: [],
      },
    });
    expect(withOverlay.success).toBe(true);

    // A raw tmux pane id can never key an overlay node -> the whole V3 input fails.
    const malformed = ApplicationShellProjectionInputV3SchemaZ.safeParse({
      ...baseInput,
      agentGraphOverlay: {
        nodes: { "%12": { ...node, windowId: "%12" } },
        edges: [],
        groups: [],
      },
    });
    expect(malformed.success).toBe(false);
  });
});
