import { describe, expect, it } from "vitest";
import {
  MissionActorSchemaZ,
  MissionAttemptIdSchemaZ,
  MissionEventSchemaZ,
  MissionIdSchemaZ,
  MissionAttemptSchemaZ,
  MissionProjectStateSchemaZ,
  MissionSnapshotSchemaZ,
  MissionProofSchemaZ,
  MissionReferenceIdSchemaZ,
  MissionStatusSchemaZ,
  MissionTaskSchemaZ,
  MissionTaskIdSchemaZ,
  MissionTaskStatusSchemaZ,
} from "../domain.ts";

const actor = { type: "user" as const, id: "pm" };

describe("mission domain contracts", () => {
  it("round-trips provider-neutral mission, task, attempt, and proof events", () => {
    const events = [
      {
        version: 1,
        type: "mission.created",
        missionId: "mis_alpha",
        title: "Ship durable missions",
        objective: "Persist mission state",
        acceptanceCriteria: ["replayable"],
        constraints: ["harness-neutral"],
        labels: ["m27"],
        source: { type: "user", id: "sfora-card-114" },
        actor,
      },
      {
        version: 1,
        type: "task.added",
        missionId: "mis_alpha",
        taskId: "tsk_contracts",
        title: "Add contracts",
        priority: 1,
        dependencies: [],
        assignee: "worker.profile",
        actor,
      },
      {
        version: 1,
        type: "attempt.started",
        missionId: "mis_alpha",
        taskId: "tsk_contracts",
        attemptId: "att_first",
        agent: "worker.profile",
        harness: "generic-harness",
        model: "opaque/model-ref",
        terminal: "term_1",
        session: "session_1",
        worktree: "worktrees/task",
        actor,
      },
      {
        version: 1,
        type: "proof.recorded",
        missionId: "mis_alpha",
        taskId: "tsk_contracts",
        attemptId: "att_first",
        proofId: "prf_tests",
        proof: {
          tests: [{ name: "contracts", status: "passed", passed: 12, total: 12 }],
          commits: [{ sha: "abcdef1" }],
          diff: { summary: "Added schemas", stats: { filesChanged: 2 } },
          pr: { number: 114, status: "open" },
          artifacts: [{ name: "log", uri: "runtime://artifact/log" }],
          notes: "All checks passed",
        },
        actor,
      },
    ];

    for (const event of events) {
      expect(MissionEventSchemaZ.parse(event)).toEqual(event);
    }
  });

  it("rejects malformed IDs, references, statuses, proofs, and event payloads", () => {
    expect(MissionIdSchemaZ.safeParse("../mis").success).toBe(false);
    expect(MissionTaskIdSchemaZ.safeParse("task-1").success).toBe(false);
    expect(MissionAttemptIdSchemaZ.safeParse("att space").success).toBe(false);
    expect(MissionReferenceIdSchemaZ.safeParse("../profile").success).toBe(false);
    expect(MissionStatusSchemaZ.safeParse("dispatching").success).toBe(false);
    expect(MissionTaskStatusSchemaZ.safeParse("updated").success).toBe(false);
    expect(MissionActorSchemaZ.safeParse({ type: "claude" }).success).toBe(false);
    expect(MissionProofSchemaZ.safeParse({}).success).toBe(false);
    expect(
      MissionProofSchemaZ.safeParse({
        tests: [{ name: "unit", status: "passed", passed: 2, total: 1 }],
      }).success,
    ).toBe(false);
    expect(MissionProofSchemaZ.safeParse({ tests: [{ name: "", status: "passed" }] }).success).toBe(
      false,
    );
    expect(
      MissionEventSchemaZ.safeParse({
        version: 2,
        type: "mission.created",
        missionId: "mis_alpha",
        title: "x",
        objective: "x",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        actor,
      }).success,
    ).toBe(false);
    expect(
      MissionEventSchemaZ.safeParse({
        version: 1,
        type: "provider.claude.spawned",
        missionId: "mis_alpha",
        actor,
      }).success,
    ).toBe(false);
  });

  it("strictly parses projected task, attempt, and mission snapshots", () => {
    const task = {
      id: "tsk_contracts",
      missionId: "mis_alpha",
      title: "Contracts",
      priority: 1,
      dependencies: [],
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      proofIds: ["prf_tests"],
      attemptIds: ["att_first"],
    };
    const attempt = {
      id: "att_first",
      missionId: "mis_alpha",
      taskId: "tsk_contracts",
      agent: "worker",
      harness: "generic",
      status: "approved",
      outcome: "approved",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      proofIds: ["prf_tests"],
    };

    expect(MissionTaskSchemaZ.parse(task)).toEqual(task);
    expect(MissionAttemptSchemaZ.parse(attempt)).toEqual(attempt);
    expect(
      MissionSnapshotSchemaZ.parse({
        id: "mis_alpha",
        title: "Alpha",
        objective: "Ship",
        acceptanceCriteria: [],
        constraints: [],
        labels: [],
        source: { type: "user" },
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        tasks: { tsk_contracts: task },
        attempts: { att_first: attempt },
        proofs: { prf_tests: { noProofReason: "manual acceptance" } },
      }),
    ).toMatchObject({ tasks: { tsk_contracts: { status: "completed" } } });

    expect(MissionTaskSchemaZ.safeParse({ ...task, extra: true }).success).toBe(false);
    expect(MissionAttemptSchemaZ.safeParse({ ...attempt, provider: "claude" }).success).toBe(false);
  });

  it("rejects projected state with broken keys, references, or duplicate reference arrays", () => {
    const validTask = {
      id: "tsk_contracts",
      missionId: "mis_alpha",
      title: "Contracts",
      priority: 1,
      dependencies: [],
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      proofIds: ["prf_tests"],
      attemptIds: ["att_first"],
    };
    const validAttempt = {
      id: "att_first",
      missionId: "mis_alpha",
      taskId: "tsk_contracts",
      agent: "worker",
      harness: "generic",
      status: "approved",
      outcome: "approved",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      proofIds: ["prf_tests"],
    };
    const validMission = {
      id: "mis_alpha",
      title: "Alpha",
      objective: "Ship",
      acceptanceCriteria: [],
      constraints: [],
      labels: [],
      source: { type: "user" },
      status: "completed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      tasks: { tsk_contracts: validTask },
      attempts: { att_first: validAttempt },
      proofs: { prf_tests: { noProofReason: "manual acceptance" } },
    };

    expect(
      MissionProjectStateSchemaZ.safeParse({
        sequence: 1,
        missions: { mis_other: validMission },
      }).success,
    ).toBe(false);
    expect(
      MissionSnapshotSchemaZ.safeParse({
        ...validMission,
        tasks: { tsk_wrong: validTask },
      }).success,
    ).toBe(false);
    expect(
      MissionSnapshotSchemaZ.safeParse({
        ...validMission,
        tasks: {
          tsk_contracts: {
            ...validTask,
            proofIds: ["prf_tests", "prf_tests"],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MissionSnapshotSchemaZ.safeParse({
        ...validMission,
        attempts: { att_first: { ...validAttempt, taskId: "tsk_missing" } },
      }).success,
    ).toBe(false);
    expect(
      MissionSnapshotSchemaZ.safeParse({
        ...validMission,
        tasks: {
          tsk_contracts: {
            ...validTask,
            attemptIds: ["att_first"],
          },
        },
        attempts: { att_first: { ...validAttempt, taskId: "tsk_missing" } },
      }).success,
    ).toBe(false);
    expect(
      MissionSnapshotSchemaZ.safeParse({
        ...validMission,
        attempts: { att_first: { ...validAttempt, proofIds: ["prf_missing"] } },
      }).success,
    ).toBe(false);
  });
});
