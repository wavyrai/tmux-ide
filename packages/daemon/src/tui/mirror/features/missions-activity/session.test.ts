import { describe, expect, it, vi } from "vitest";

import type { WorkspaceMissionsEnvelopeV1 } from "@tmux-ide/contracts";

import type { MissionsActivityFeatureHost } from "./contract.ts";
import { createMissionsActivityFeatureSession } from "./session.ts";

function envelope(
  workspaceName: string,
  options: { mission?: boolean; activitySequence?: number } = {},
): WorkspaceMissionsEnvelopeV1 {
  const mission = {
    id: "mission-alpha",
    title: "Ship shared surface",
    summary: "Keep Missions and Activity on one authority-owned session.",
    status: "running",
    column: "running",
    updatedAt: "2026-08-12T10:00:00.000Z",
    durationMs: 1_000,
    progress: { planned: 0, running: 1, blocked: 0, review: 0, done: 0, total: 1 },
    blockedCount: 0,
    latestAttempt: null,
    proof: {
      hasProof: false,
      proofCount: 0,
      notesCount: 0,
      noProofReasons: [],
      tests: { suites: 0, passed: 0, failed: 0, skipped: 0, total: 0 },
      commitCount: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      pullRequestCount: 0,
      artifactCount: 0,
    },
  };
  const activity = {
    id: "activity-alpha",
    sequence: options.activitySequence ?? 20,
    timestamp: "2026-08-12T10:01:00.000Z",
    missionId: "mission-alpha",
    type: "mission.updated",
    label: "Mission updated",
    actor: { type: "agent", label: "Codex" },
  };
  const missions = options.mission === false ? [] : [mission];
  return {
    version: 1,
    daemon: {
      instanceId: "daemon-alpha",
      pid: 42,
      startedAt: "2026-08-12T09:00:00.000Z",
    },
    resource: {
      workspaceName,
      missionWorkspace: {
        status: missions.length === 0 ? "empty" : "ready",
        counts: { missions: missions.length, history: 0, activity: missions.length },
        missions,
        history: [],
        activity: missions.length === 0 ? [] : [activity],
        truncated: false,
      },
    },
  } as unknown as WorkspaceMissionsEnvelopeV1;
}

function harness() {
  const persistedMissions: unknown[] = [];
  const persistedActivity: unknown[] = [];
  const host: MissionsActivityFeatureHost = {
    width: () => 120,
    height: () => 24,
    hover: () => null,
    agents: () => [],
    interactions: () => [
      {
        operationId: "op-1",
        sequence: 30,
        at: "2026-08-12T10:02:00.000Z",
        source: "Editor → Tests",
        message: "sent input",
        detail: "alpha · sdk",
        phase: "completed",
      },
    ],
    refresh: vi.fn(),
    setStatusNote: vi.fn(),
    persistMissions: (state) => persistedMissions.push(state),
    persistActivity: (state) => persistedActivity.push(state),
    deepLinkContext: () => ({
      projectRoot: "/repo",
      views: [],
      resolveProjectPath: () => null,
    }),
    executeDeepLink: vi.fn(),
  };
  const session = createMissionsActivityFeatureSession(
    host,
    {
      workspaceName: "alpha",
      directory: "/repo",
      projectRoot: "/repo",
      identityKey: "alpha-id",
    },
    7,
  );
  return { session, persistedMissions, persistedActivity };
}

describe("deferred Missions and Activity session", () => {
  it("projects one catalog through both surfaces and keeps Activity newest-first", () => {
    const test = harness();
    test.session.applyCatalog(7, envelope("alpha"));

    expect(test.session.missionLoadState().status).toBe("ready");
    expect(test.session.missionSnapshot()?.board.counts).toMatchObject({ running: 1, total: 1 });
    expect(test.session.activityProjection().rows.map((row) => row.id)).toEqual([
      "interaction:op-1",
      "mission:activity-alpha",
    ]);

    expect(
      test.session.handleActivityKey({ name: "down", ctrl: false, meta: false, shift: false }),
    ).toBe(true);
    expect(test.session.activityState().selectedRowId).toBe("interaction:op-1");
    expect(test.persistedActivity).toHaveLength(1);
    test.session.dispose();
  });

  it("rejects stale generations and same-directory catalogs for another workspace", () => {
    const test = harness();
    test.session.applyCatalog(6, envelope("alpha"));
    test.session.applyCatalog(7, envelope("beta"));
    expect(test.session.missionLoadState().status).toBe("loading");

    test.session.applyCatalog(7, envelope("alpha"));
    expect(test.session.missionLoadState().status).toBe("ready");
    test.session.setWorkspaceIdentity({
      workspaceName: "beta",
      directory: "/repo",
      projectRoot: "/repo",
      identityKey: "beta-id",
    });
    expect(test.session.missionLoadState().status).toBe("loading");
    expect(test.session.missionSnapshot()).toBeNull();
    test.session.dispose();
  });
});
