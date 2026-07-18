import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventSequenceConflictError,
  createProjectRuntimeRepository,
  type ProjectRuntimeRepository,
  type RuntimeEvent,
} from "../project-runtime-repository.ts";
import type { ProjectResolution } from "../project-resolver.ts";
import {
  applyMissionEvent,
  MissionRepository,
  MissionRepositoryError,
  replayMissionEvents,
  type MissionProjectState,
} from "../mission-repository.ts";

const roots: string[] = [];
const actor = { type: "user" as const, id: "pm" };

function temporaryRoot(prefix = "tmux-ide-mission-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(
  projectRoot: string,
  overrides: Partial<ProjectResolution> = {},
): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: `git-${"b".repeat(64)}`,
    identitySource: "git-common-dir",
    identityAnchor: join(projectRoot, ".git"),
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
    ...overrides,
  };
}

function repository(
  project = temporaryRoot("tmux-ide-project-"),
  home = temporaryRoot("tmux-ide-home-"),
  overrides: Partial<ProjectResolution> = {},
): {
  runtime: ProjectRuntimeRepository;
  missions: MissionRepository;
  home: string;
  project: string;
} {
  const runtime = createProjectRuntimeRepository(resolution(project, overrides), { home });
  return { runtime, missions: new MissionRepository(runtime), home, project };
}

function expectNoAppend(missions: MissionRepository, action: () => unknown, code: string): void {
  const before = missions.history().length;
  expect(action).toThrow(MissionRepositoryError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
  expect(missions.history()).toHaveLength(before);
}

function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

function rawEvent(sequence: number, payload: unknown): string {
  return JSON.stringify({
    version: 1,
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    payload,
  });
}

function missionCreated(missionId = "mis_raw"): Record<string, unknown> {
  return {
    version: 1,
    type: "mission.created",
    missionId,
    title: "Raw",
    objective: "Raw replay",
    acceptanceCriteria: [],
    constraints: [],
    labels: [],
    source: { type: "user" },
    actor,
  };
}

function taskAdded(
  taskId = "tsk_raw",
  dependencies: string[] = [],
  missionId = "mis_raw",
): Record<string, unknown> {
  return {
    version: 1,
    type: "task.added",
    missionId,
    taskId,
    title: taskId,
    priority: 0,
    dependencies,
    actor,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MissionRepository replay and persistence", () => {
  it("creates missions, tasks, attempts, retries, proof, and deterministic state from one event stream", () => {
    const { missions } = repository();

    const mission = missions.create({
      id: "mis_alpha",
      title: "Mission Alpha",
      objective: "Prove durable replay",
      acceptanceCriteria: ["all tests pass"],
      constraints: ["harness-neutral"],
      labels: ["m27"],
      source: { type: "user", id: "card-114" },
      actor,
    });
    expect(mission.status).toBe("created");
    missions.planMission("mis_alpha", actor);
    missions.startMission("mis_alpha", actor);
    missions.addTask({
      id: "tsk_setup",
      missionId: "mis_alpha",
      title: "Setup",
      priority: 1,
      actor,
    });
    missions.addTask({
      id: "tsk_finish",
      missionId: "mis_alpha",
      title: "Finish",
      dependencies: ["tsk_setup"],
      actor,
    });
    missions.readyTask("mis_alpha", "tsk_setup", actor);
    missions.claimTask("mis_alpha", "tsk_setup", "worker", actor);
    missions.startTask("mis_alpha", "tsk_setup", actor);
    missions.startAttempt({
      id: "att_first",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      agent: "worker",
      harness: "generic",
      model: "opaque/model",
      actor,
    });
    const proof = missions.recordProof({
      id: "prf_first",
      missionId: "mis_alpha",
      taskId: "tsk_setup",
      attemptId: "att_first",
      proof: { tests: [{ name: "unit", status: "passed", passed: 1, total: 1 }] },
      actor,
    });
    expect(proof.tests?.[0]?.name).toBe("unit");
    missions.submitAttempt("mis_alpha", "tsk_setup", "att_first", actor, { proofId: "prf_first" });
    missions.approveAttempt("mis_alpha", "tsk_setup", "att_first", actor, { proofId: "prf_first" });
    missions.submitTask("mis_alpha", "tsk_setup", actor, { proofId: "prf_first" });
    missions.completeTask("mis_alpha", "tsk_setup", actor, { proofId: "prf_first" });
    missions.readyTask("mis_alpha", "tsk_finish", actor);
    missions.claimTask("mis_alpha", "tsk_finish", "worker", actor);
    missions.startTask("mis_alpha", "tsk_finish", actor);
    missions.startAttempt({
      id: "att_retry",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      agent: "worker",
      harness: "generic",
      actor,
    });
    missions.interruptAttempt("mis_alpha", "tsk_finish", "att_retry", actor, {
      reason: "terminal closed",
    });
    missions.startAttempt({
      id: "att_second",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      agent: "worker",
      harness: "generic",
      actor,
    });
    missions.recordProof({
      id: "prf_second",
      missionId: "mis_alpha",
      taskId: "tsk_finish",
      attemptId: "att_second",
      proof: { noProofReason: "Manual verification accepted" },
      actor,
    });
    missions.submitAttempt("mis_alpha", "tsk_finish", "att_second", actor, {
      proofId: "prf_second",
    });
    missions.approveAttempt("mis_alpha", "tsk_finish", "att_second", actor, {
      proofId: "prf_second",
    });
    missions.submitTask("mis_alpha", "tsk_finish", actor, { proofId: "prf_second" });
    missions.completeTask("mis_alpha", "tsk_finish", actor, { proofId: "prf_second" });
    missions.reviewMission("mis_alpha", actor);
    missions.completeMission("mis_alpha", actor);

    const stateA = missions.state();
    const stateB = replayMissionEvents(
      missions.history().map(
        (entry) =>
          ({
            version: 1,
            sequence: entry.sequence,
            timestamp: entry.timestamp,
            payload: entry.event,
          }) satisfies RuntimeEvent<never>,
      ),
    );
    expect(stateB).toEqual(stateA);
    expect(stateA.missions.mis_alpha?.status).toBe("completed");
    expect(stateA.missions.mis_alpha?.tasks.tsk_finish?.dependencies).toEqual(["tsk_setup"]);
    expect(stateA.missions.mis_alpha?.attempts.att_retry?.status).toBe("interrupted");
    expect(stateA.missions.mis_alpha?.attempts.att_second?.status).toBe("approved");
    expect(stateA.missions.mis_alpha?.tasks.tsk_setup?.proofIds).toEqual(["prf_first"]);
    expect(stateA.missions.mis_alpha?.attempts.att_first?.proofIds).toEqual(["prf_first"]);
    expect(missions.history().map((entry) => entry.sequence)).toEqual(
      Array.from({ length: missions.history().length }, (_, index) => index + 1),
    );

    const detached = missions.get("mis_alpha")!;
    detached.tasks.tsk_setup!.title = "mutated";
    expect(missions.get("mis_alpha")?.tasks.tsk_setup?.title).toBe("Setup");
  });

  it("reopens with byte-equivalent logical state and keeps multiple missions isolated", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const first = repository(project, home).missions;
    first.create({ id: "mis_one", title: "One", objective: "one", actor });
    first.create({ id: "mis_two", title: "Two", objective: "two", actor });

    const reopened = repository(project, home).missions;
    expect(JSON.stringify(reopened.state())).toBe(JSON.stringify(first.state()));
    expect(reopened.list().map((mission) => mission.id)).toEqual(["mis_one", "mis_two"]);
  });
});

describe("MissionRepository guards and corruption handling", () => {
  it("enforces dependency and mission-completion invariants without appending events", () => {
    const { missions } = repository();
    missions.create({ id: "mis_guard", title: "Guard", objective: "guard", actor });
    missions.startMission("mis_guard", actor);
    missions.addTask({ id: "tsk_a", missionId: "mis_guard", title: "A", actor });
    missions.addTask({
      id: "tsk_b",
      missionId: "mis_guard",
      title: "B",
      dependencies: ["tsk_a"],
      actor,
    });

    expectNoAppend(
      missions,
      () => missions.readyTask("mis_guard", "tsk_b", actor),
      "TASK_DEPENDENCY_UNMET",
    );
    expectNoAppend(
      missions,
      () => missions.completeMission("mis_guard", actor),
      "MISSION_HISTORY_INVALID",
    );
  });

  it("requires review and complete tasks before mission completion", () => {
    const { missions } = repository();
    missions.create({ id: "mis_complete", title: "Complete", objective: "complete", actor });
    missions.startMission("mis_complete", actor);
    missions.addTask({ id: "tsk_complete", missionId: "mis_complete", title: "Complete", actor });
    expectNoAppend(
      missions,
      () => missions.completeMission("mis_complete", actor),
      "MISSION_HISTORY_INVALID",
    );
    missions.reviewMission("mis_complete", actor);
    expectNoAppend(
      missions,
      () => missions.completeMission("mis_complete", actor),
      "MISSION_INCOMPLETE_TASKS",
    );
  });

  it("returns stable typed errors for invalid lifecycle transitions and preserves history", () => {
    const { missions } = repository();
    missions.create({ id: "mis_invalid", title: "Invalid", objective: "invalid", actor });
    missions.addTask({ id: "tsk_invalid", missionId: "mis_invalid", title: "Invalid", actor });

    expectNoAppend(
      missions,
      () => missions.startTask("mis_invalid", "tsk_invalid", actor),
      "TASK_INVALID_TRANSITION",
    );
    expectNoAppend(
      missions,
      () =>
        missions.startAttempt({
          id: "att_invalid",
          missionId: "mis_invalid",
          taskId: "tsk_invalid",
          agent: "worker",
          harness: "generic",
          actor,
        }),
      "TASK_INVALID_TRANSITION",
    );
    missions.readyTask("mis_invalid", "tsk_invalid", actor);
    missions.claimTask("mis_invalid", "tsk_invalid", "worker", actor);
    missions.startTask("mis_invalid", "tsk_invalid", actor);
    missions.startAttempt({
      id: "att_invalid",
      missionId: "mis_invalid",
      taskId: "tsk_invalid",
      agent: "worker",
      harness: "generic",
      actor,
    });
    expectNoAppend(
      missions,
      () => missions.approveAttempt("mis_invalid", "tsk_invalid", "att_invalid", actor),
      "ATTEMPT_INVALID_TRANSITION",
    );
    expectNoAppend(
      missions,
      () => missions.submitAttempt("mis_invalid", "tsk_invalid", "att_invalid", actor),
      "PROOF_REQUIRED",
    );
  });

  it("preserves task status on task.updated and rejects dependency edits after execution begins", () => {
    const { missions } = repository();
    missions.create({ id: "mis_update", title: "Update", objective: "update", actor });
    missions.addTask({ id: "tsk_dep", missionId: "mis_update", title: "Dependency", actor });
    missions.addTask({ id: "tsk_update", missionId: "mis_update", title: "Update", actor });
    missions.updateTask({
      missionId: "mis_update",
      taskId: "tsk_update",
      title: "Updated title",
      actor,
    });
    expect(missions.get("mis_update")?.tasks.tsk_update?.status).toBe("added");
    missions.readyTask("mis_update", "tsk_update", actor);
    missions.claimTask("mis_update", "tsk_update", "worker", actor);
    expectNoAppend(
      missions,
      () =>
        missions.updateTask({
          missionId: "mis_update",
          taskId: "tsk_update",
          dependencies: ["tsk_dep"],
          actor,
        }),
      "TASK_INVALID_TRANSITION",
    );
  });

  it("rejects empty proof and invalid mutation input with stable mission errors", () => {
    const { missions } = repository();
    missions.create({ id: "mis_proof", title: "Proof", objective: "proof", actor });
    expectNoAppend(
      missions,
      () =>
        missions.recordProof({
          id: "prf_empty",
          missionId: "mis_proof",
          proof: {},
          actor,
        }),
      "MISSION_HISTORY_INVALID",
    );
    expectNoAppend(
      missions,
      () =>
        missions.recordProof({
          id: "prf_bad",
          missionId: "mis_proof",
          proof: { tests: [{ name: "unit", status: "passed", passed: 2, total: 1 }] },
          actor,
        }),
      "MISSION_HISTORY_INVALID",
    );
  });

  it("rejects dependency duplicate, self, cycle, and blocked-path bypass", () => {
    const { missions } = repository();
    missions.create({ id: "mis_deps", title: "Deps", objective: "deps", actor });
    missions.addTask({ id: "tsk_a", missionId: "mis_deps", title: "A", actor });
    missions.addTask({ id: "tsk_b", missionId: "mis_deps", title: "B", actor });
    expectNoAppend(
      missions,
      () =>
        missions.updateTask({
          missionId: "mis_deps",
          taskId: "tsk_b",
          dependencies: ["tsk_a", "tsk_a"],
          actor,
        }),
      "TASK_DEPENDENCY_UNMET",
    );
    expectNoAppend(
      missions,
      () =>
        missions.updateTask({
          missionId: "mis_deps",
          taskId: "tsk_b",
          dependencies: ["tsk_b"],
          actor,
        }),
      "TASK_DEPENDENCY_UNMET",
    );
    missions.updateTask({
      missionId: "mis_deps",
      taskId: "tsk_b",
      dependencies: ["tsk_a"],
      actor,
    });
    expectNoAppend(
      missions,
      () =>
        missions.updateTask({
          missionId: "mis_deps",
          taskId: "tsk_a",
          dependencies: ["tsk_b"],
          actor,
        }),
      "TASK_DEPENDENCY_UNMET",
    );
    missions.blockTask("mis_deps", "tsk_b", "waiting", actor);
    expectNoAppend(
      missions,
      () => missions.claimTask("mis_deps", "tsk_b", "worker", actor),
      "TASK_DEPENDENCY_UNMET",
    );
  });

  it("rejects mutations after a terminal mission state", () => {
    const { missions } = repository();
    missions.create({ id: "mis_terminal", title: "Terminal", objective: "terminal", actor });
    missions.cancelMission("mis_terminal", actor);
    expectNoAppend(
      missions,
      () => missions.addTask({ id: "tsk_late", missionId: "mis_terminal", title: "Late", actor }),
      "MISSION_TERMINAL",
    );
    expectNoAppend(
      missions,
      () =>
        missions.recordProof({
          id: "prf_late",
          missionId: "mis_terminal",
          proof: { noProofReason: "late" },
          actor,
        }),
      "MISSION_TERMINAL",
    );
  });

  it("fails stale concurrent sequence writes instead of overwriting", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const project = temporaryRoot("tmux-ide-project-");
    const first = repository(project, home).missions;
    const second = repository(project, home).missions;

    first.create({ id: "mis_concurrent", title: "Concurrent", objective: "concurrent", actor });
    expect(() =>
      second.create(
        { id: "mis_stale", title: "Stale", objective: "stale", actor },
        { expectedPreviousSequence: 0 },
      ),
    ).toThrow(EventSequenceConflictError);
  });

  it("surfaces unknown-version and unknown-event history instead of healing it", () => {
    const { runtime, missions } = repository();
    writeRaw(
      join(runtime.metadata.runtimeRoot, "events", "missions.jsonl"),
      `${JSON.stringify({
        version: 1,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { version: 2, type: "mission.created" },
      })}\n`,
    );
    expect(() => missions.state()).toThrow(MissionRepositoryError);
    try {
      missions.state();
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_HISTORY_INVALID" });
    }

    writeRaw(
      join(runtime.metadata.runtimeRoot, "events", "missions.jsonl"),
      `${JSON.stringify({
        version: 1,
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: { version: 1, type: "mission.teleported", actor },
      })}\n`,
    );
    expect(() => missions.history()).toThrow(MissionRepositoryError);
  });

  it("replayMissionEvents rejects non-contiguous sequences and invalid timestamps", () => {
    const first = {
      version: 1,
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      payload: missionCreated(),
    } satisfies RuntimeEvent<never>;
    expect(() =>
      replayMissionEvents([
        first,
        {
          ...first,
          sequence: 3,
          timestamp: "2026-01-01T00:00:03.000Z",
        },
      ]),
    ).toThrow(MissionRepositoryError);
    try {
      replayMissionEvents([{ ...first, timestamp: "not-a-date" }]);
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_HISTORY_INVALID" });
    }
  });

  it("history replay-validates semantic corruption before returning", () => {
    const { runtime, missions } = repository();
    writeRaw(
      join(runtime.metadata.runtimeRoot, "events", "missions.jsonl"),
      [rawEvent(1, missionCreated()), rawEvent(2, missionCreated())].join("\n") + "\n",
    );
    expect(() => missions.history()).toThrow(MissionRepositoryError);
    try {
      missions.history();
    } catch (error) {
      expect(error).toMatchObject({ code: "MISSION_ALREADY_EXISTS" });
    }
  });

  it("applyMissionEvent leaves caller state byte-identical when proof.recorded validation fails", () => {
    const state: MissionProjectState = {
      sequence: 1,
      missions: {
        mis_apply: {
          id: "mis_apply",
          title: "Apply",
          objective: "Apply validation",
          acceptanceCriteria: [],
          constraints: [],
          labels: [],
          source: { type: "user" },
          status: "created",
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          tasks: {
            tsk_apply: {
              id: "tsk_apply",
              missionId: "mis_apply",
              title: "Apply task",
              priority: 0,
              dependencies: [],
              status: "added",
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
              proofIds: [],
              attemptIds: [],
            },
          },
          attempts: {},
          proofs: {},
        },
      },
    };
    const before = JSON.stringify(state);

    expect(() =>
      applyMissionEvent(state, {
        version: 1,
        sequence: 2,
        timestamp: "2026-01-01T00:00:02.000Z",
        payload: {
          version: 1,
          type: "proof.recorded",
          missionId: "mis_apply",
          taskId: "tsk_apply",
          attemptId: "att_missing",
          proofId: "prf_apply",
          proof: { noProofReason: "manual" },
          actor,
        },
      }),
    ).toThrow(MissionRepositoryError);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("rejects schema-valid but semantically corrupt replay without partially mutating state", () => {
    const cases: Array<{ name: string; payloads: unknown[]; code: string }> = [
      {
        name: "duplicate mission",
        payloads: [missionCreated(), missionCreated()],
        code: "MISSION_ALREADY_EXISTS",
      },
      {
        name: "duplicate task",
        payloads: [missionCreated(), taskAdded("tsk_dup"), taskAdded("tsk_dup")],
        code: "TASK_ALREADY_EXISTS",
      },
      {
        name: "duplicate proof",
        payloads: [
          missionCreated(),
          {
            version: 1,
            type: "proof.recorded",
            missionId: "mis_raw",
            proofId: "prf_dup",
            proof: { noProofReason: "one" },
            actor,
          },
          {
            version: 1,
            type: "proof.recorded",
            missionId: "mis_raw",
            proofId: "prf_dup",
            proof: { noProofReason: "two" },
            actor,
          },
        ],
        code: "PROOF_ALREADY_EXISTS",
      },
      {
        name: "duplicate attempt",
        payloads: [
          missionCreated(),
          taskAdded("tsk_raw"),
          {
            version: 1,
            type: "task.claimed",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            assignee: "worker",
            actor,
          },
          {
            version: 1,
            type: "attempt.started",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            attemptId: "att_dup",
            agent: "worker",
            harness: "generic",
            actor,
          },
          {
            version: 1,
            type: "attempt.started",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            attemptId: "att_dup",
            agent: "worker",
            harness: "generic",
            actor,
          },
        ],
        code: "ATTEMPT_ALREADY_EXISTS",
      },
      {
        name: "invalid transition",
        payloads: [
          missionCreated(),
          { version: 1, type: "mission.completed", missionId: "mis_raw", actor },
        ],
        code: "MISSION_HISTORY_INVALID",
      },
      {
        name: "missing proof reference",
        payloads: [
          missionCreated(),
          taskAdded("tsk_raw"),
          { version: 1, type: "task.ready", missionId: "mis_raw", taskId: "tsk_raw", actor },
          {
            version: 1,
            type: "task.claimed",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            assignee: "worker",
            actor,
          },
          { version: 1, type: "task.started", missionId: "mis_raw", taskId: "tsk_raw", actor },
          {
            version: 1,
            type: "task.submitted",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            proofId: "prf_missing",
            actor,
          },
        ],
        code: "PROOF_NOT_FOUND",
      },
      {
        name: "ownership mismatch",
        payloads: [
          missionCreated(),
          taskAdded("tsk_raw"),
          {
            version: 1,
            type: "task.claimed",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            assignee: "worker-a",
            actor,
          },
          {
            version: 1,
            type: "attempt.started",
            missionId: "mis_raw",
            taskId: "tsk_raw",
            attemptId: "att_wrong",
            agent: "worker-b",
            harness: "generic",
            actor,
          },
        ],
        code: "ATTEMPT_OWNERSHIP_CONFLICT",
      },
    ];

    for (const testCase of cases) {
      const { runtime, missions } = repository();
      writeRaw(
        join(runtime.metadata.runtimeRoot, "events", "missions.jsonl"),
        testCase.payloads.map((payload, index) => rawEvent(index + 1, payload)).join("\n") + "\n",
      );
      expect(() => missions.state(), testCase.name).toThrow(MissionRepositoryError);
      try {
        missions.state();
      } catch (error) {
        expect(error, testCase.name).toMatchObject({ code: testCase.code });
      }
    }
  });

  it("shares history across linked worktree identities and isolates unrelated projects", () => {
    const home = temporaryRoot("tmux-ide-home-");
    const main = temporaryRoot("tmux-ide-main-");
    const linked = temporaryRoot("tmux-ide-linked-");
    const unrelated = temporaryRoot("tmux-ide-unrelated-");
    const identity = `git-${"c".repeat(64)}`;
    const first = repository(main, home, {
      identityKey: identity,
      identityAnchor: join(main, ".git"),
    }).missions;
    const second = repository(linked, home, {
      identityKey: identity,
      identityAnchor: join(main, ".git"),
    }).missions;
    const third = repository(unrelated, home, {
      identityKey: `git-${"d".repeat(64)}`,
      identityAnchor: join(unrelated, ".git"),
    }).missions;

    first.create({ id: "mis_shared", title: "Shared", objective: "shared", actor });
    expect(second.get("mis_shared")?.title).toBe("Shared");
    expect(third.get("mis_shared")).toBeNull();
    expect(existsSync(join(home, "projects", identity, "events", "missions.jsonl"))).toBe(true);
  });
});
