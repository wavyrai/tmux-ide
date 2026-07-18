import { describe, expect, it } from "vitest";
import {
  MissionBoardViewSchemaZ,
  MissionDetailViewSchemaZ,
  MissionHistorySummarySchemaZ,
  MissionTimelineEntrySchemaZ,
  type MissionCardView,
  type MissionProofSummary,
} from "../mission-projections.ts";

const proofSummary: MissionProofSummary = {
  proofIds: ["prf_one"],
  hasProof: true,
  noProofReasons: [],
  notesCount: 1,
  tests: { suites: 1, passed: 1, failed: 0, skipped: 0, total: 3 },
  commits: ["abcdef1"],
  diff: {
    summaries: ["Added read models"],
    urls: ["https://example.test/diff"],
    filesChanged: 2,
    insertions: 10,
    deletions: 1,
  },
  prs: [{ number: 116, url: "https://example.test/pr/116", status: "open" }],
  artifacts: [{ name: "log", uri: "artifact://log", kind: "text" }],
};

const missionCard: MissionCardView = {
  version: 1,
  id: "mis_alpha",
  title: "Alpha",
  summary: "Ship alpha",
  status: "completed",
  column: "done",
  labels: ["m27"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:10.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:00:10.000Z",
  durationMs: 9000,
  progress: {
    total: 1,
    planned: 0,
    running: 0,
    blocked: 0,
    review: 0,
    completed: 1,
    failed: 0,
    cancelled: 0,
    done: 1,
  },
  blockedBy: [],
  latestAttempt: {
    id: "att_one",
    taskId: "tsk_one",
    status: "approved",
    outcome: "approved",
    agent: "agent/a",
    harness: "generic",
    startedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:09.000Z",
    finishedAt: "2026-01-01T00:00:09.000Z",
    durationMs: 7000,
    proofIds: ["prf_one"],
  },
  proofSummary,
  refs: {
    missionId: "mis_alpha",
    taskIds: ["tsk_one"],
    attemptIds: ["att_one"],
    proofIds: ["prf_one"],
  },
};

describe("mission projection contracts", () => {
  it("strictly parses versioned board, detail, history, and timeline views", () => {
    const task = {
      version: 1,
      id: "tsk_one",
      missionId: "mis_alpha",
      title: "Task",
      summary: "Task",
      status: "completed",
      column: "done",
      priority: 1,
      dependencies: [],
      blockedBy: [],
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:09.000Z",
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:09.000Z",
      durationMs: 7000,
      latestAttempt: missionCard.latestAttempt,
      proofSummary,
      refs: {
        missionId: "mis_alpha",
        taskId: "tsk_one",
        attemptIds: ["att_one"],
        proofIds: ["prf_one"],
      },
    };
    const timeline = {
      version: 1,
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      missionId: "mis_alpha",
      type: "mission.created",
      label: "Mission created",
      actor: { type: "user", id: "pm" },
      refs: { missionId: "mis_alpha" },
    };

    expect(
      MissionBoardViewSchemaZ.parse({
        version: 1,
        columns: { planned: [], running: [], blocked: [], review: [], done: [missionCard] },
        counts: { planned: 0, running: 0, blocked: 0, review: 0, done: 1, total: 1 },
      }),
    ).toMatchObject({ counts: { total: 1 } });
    expect(
      MissionDetailViewSchemaZ.parse({
        version: 1,
        mission: missionCard,
        taskBoard: {
          columns: { planned: [], running: [], blocked: [], review: [], done: [task] },
          counts: { planned: 0, running: 0, blocked: 0, review: 0, done: 1, total: 1 },
        },
        attempts: [missionCard.latestAttempt],
        proofSummary,
        progress: missionCard.progress,
        timeline: [timeline],
      }),
    ).toMatchObject({ mission: { id: "mis_alpha" } });
    expect(MissionTimelineEntrySchemaZ.parse(timeline)).toEqual(timeline);
    expect(
      MissionHistorySummarySchemaZ.parse({
        version: 1,
        mission: missionCard,
        outcome: "completed",
        startedAt: "2026-01-01T00:00:01.000Z",
        finishedAt: "2026-01-01T00:00:10.000Z",
        durationMs: 9000,
        taskTotals: missionCard.progress,
        attemptTotals: {
          total: 1,
          submitted: 0,
          approved: 1,
          rejected: 0,
          failed: 0,
          interrupted: 0,
          running: 0,
        },
        proofSummary,
        lastEvent: timeline,
      }),
    ).toMatchObject({ outcome: "completed" });
  });

  it("rejects stale versions, arbitrary raw fields, and duplicate navigation references", () => {
    expect(MissionBoardViewSchemaZ.safeParse({ version: 2, columns: {}, counts: {} }).success).toBe(
      false,
    );
    expect(MissionBoardViewSchemaZ.safeParse({ ...missionCard, rawEvidence: {} }).success).toBe(
      false,
    );
    expect(
      MissionBoardViewSchemaZ.safeParse({
        version: 1,
        columns: {
          planned: [],
          running: [],
          blocked: [],
          review: [],
          done: [
            {
              ...missionCard,
              refs: { ...missionCard.refs, proofIds: ["prf_one", "prf_one"] },
            },
          ],
        },
        counts: { planned: 0, running: 0, blocked: 0, review: 0, done: 1, total: 1 },
      }).success,
    ).toBe(false);
  });
});
