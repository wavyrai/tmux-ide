import { DesktopMissionWorkspaceResourceSchemaZ } from "@tmux-ide/contracts";

const proof = {
  hasProof: true,
  proofCount: 2,
  notesCount: 1,
  noProofReasons: [],
  tests: { suites: 1, passed: 12, failed: 0, skipped: 0, total: 12 },
  commitCount: 2,
  filesChanged: 6,
  insertions: 84,
  deletions: 14,
  pullRequestCount: 1,
  artifactCount: 1,
};

function mission(id: string, title: string, status: "started" | "review" = "started") {
  return {
    id,
    title,
    summary: `${title} objective`,
    status,
    column: status === "review" ? ("review" as const) : ("running" as const),
    updatedAt: "2026-07-22T15:30:00.000Z",
    startedAt: "2026-07-22T15:00:00.000Z",
    durationMs: null,
    progress: {
      total: 4,
      planned: 0,
      running: 1,
      blocked: 0,
      review: status === "review" ? 1 : 0,
      completed: 2,
      failed: 0,
      cancelled: 0,
      done: 2,
    },
    blockedCount: 0,
    latestAttempt: {
      id: `att_${id.slice(4)}`,
      taskId: `tsk_${id.slice(4)}`,
      status: "submitted" as const,
      outcome: "submitted" as const,
      agent: "codex",
      harness: "codex-cli",
      model: "gpt-5.5",
      updatedAt: "2026-07-22T15:29:00.000Z",
      durationMs: 1_740_000,
      proofCount: 2,
    },
    proof,
  };
}

export function createMissionActivityFixture() {
  const first = mission("mis_alpha", "Desktop parity");
  const second = mission("mis_beta", "Onboarding proof", "review");
  const completed = {
    ...mission("mis_gamma", "Native terminal recovery"),
    status: "completed" as const,
    column: "done" as const,
    finishedAt: "2026-07-22T15:31:00.000Z",
    durationMs: 1_860_000,
    progress: {
      total: 4,
      planned: 0,
      running: 0,
      blocked: 0,
      review: 0,
      completed: 4,
      failed: 0,
      cancelled: 0,
      done: 4,
    },
  };
  return DesktopMissionWorkspaceResourceSchemaZ.parse({
    status: "ready",
    counts: { missions: 3, history: 1, activity: 2 },
    missions: [first, second, completed],
    history: [
      {
        mission: completed,
        outcome: "completed",
        startedAt: completed.startedAt,
        finishedAt: completed.finishedAt,
        durationMs: completed.durationMs,
        attempts: { total: 2, approved: 2, rejected: 0, failed: 0, interrupted: 0 },
        lastEventLabel: "Mission completed with proof",
      },
    ],
    activity: [
      {
        id: "activity.12",
        sequence: 12,
        timestamp: "2026-07-22T15:30:00.000Z",
        missionId: first.id,
        taskId: "tsk_alpha",
        type: "proof.recorded",
        label: "Proof recorded",
        reason: "Renderer acceptance passed.",
        actor: { type: "agent", label: "Codex" },
      },
      {
        id: "activity.11",
        sequence: 11,
        timestamp: "2026-07-22T15:29:00.000Z",
        missionId: second.id,
        type: "mission.review",
        label: "Mission entered review",
        actor: { type: "system", label: "tmux-ide" },
      },
    ],
    truncated: false,
  });
}
