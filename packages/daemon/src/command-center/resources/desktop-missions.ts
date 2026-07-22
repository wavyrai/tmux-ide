import {
  DESKTOP_MISSION_MAX_ACTIVITY,
  DESKTOP_MISSION_MAX_HISTORY,
  DESKTOP_MISSION_MAX_VISIBLE,
  DesktopMissionWorkspaceResourceSchemaZ,
  type DesktopMissionActivityEvent,
  type DesktopMissionHistorySummary,
  type DesktopMissionLatestAttempt,
  type DesktopMissionProofSummary,
  type DesktopMissionSummary,
  type DesktopMissionWorkspaceResource,
  type MissionCardView,
  type MissionHistorySummary,
  type MissionProofSummary,
  type MissionTimelineEntry,
} from "@tmux-ide/contracts";

import {
  projectMissionBoard,
  projectMissionActivity,
  projectMissionHistory,
} from "../../lib/mission-projections.ts";
import type { MissionRepositorySnapshot } from "../../lib/mission-repository.ts";

const COLUMN_ORDER = ["running", "blocked", "review", "planned", "done"] as const;
export const DESKTOP_MISSION_MAX_SOURCE_MISSIONS = 512;
export const DESKTOP_MISSION_MAX_SOURCE_EVENTS = 8_192;

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1))}…`;
}

function proofSummary(proof: MissionProofSummary): DesktopMissionProofSummary {
  return {
    hasProof: proof.hasProof,
    proofCount: proof.proofIds.length,
    notesCount: proof.notesCount,
    noProofReasons: proof.noProofReasons.slice(0, 4).map((reason) => bounded(reason, 160)),
    tests: { ...proof.tests },
    commitCount: proof.commits.length,
    filesChanged: proof.diff.filesChanged,
    insertions: proof.diff.insertions,
    deletions: proof.diff.deletions,
    pullRequestCount: proof.prs.length,
    artifactCount: proof.artifacts.length,
  };
}

function latestAttempt(card: MissionCardView): DesktopMissionLatestAttempt | null {
  const attempt = card.latestAttempt;
  return attempt
    ? {
        id: attempt.id,
        taskId: attempt.taskId,
        status: attempt.status,
        ...(attempt.outcome === undefined ? {} : { outcome: attempt.outcome }),
        agent: attempt.agent,
        harness: attempt.harness,
        ...(attempt.model === undefined ? {} : { model: attempt.model }),
        updatedAt: attempt.updatedAt,
        durationMs: attempt.durationMs,
        proofCount: attempt.proofIds.length,
      }
    : null;
}

function missionSummary(card: MissionCardView): DesktopMissionSummary {
  return {
    id: card.id,
    title: bounded(card.title, 160),
    summary: bounded(card.summary, 512),
    status: card.status,
    column: card.column,
    updatedAt: card.updatedAt,
    ...(card.startedAt === undefined ? {} : { startedAt: card.startedAt }),
    ...(card.finishedAt === undefined ? {} : { finishedAt: card.finishedAt }),
    durationMs: card.durationMs,
    progress: { ...card.progress },
    blockedCount: card.blockedBy.length,
    latestAttempt: latestAttempt(card),
    proof: proofSummary(card.proofSummary),
  };
}

function historySummary(entry: MissionHistorySummary): DesktopMissionHistorySummary {
  return {
    mission: missionSummary(entry.mission),
    outcome: entry.outcome,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    attempts: {
      total: entry.attemptTotals.total,
      approved: entry.attemptTotals.approved,
      rejected: entry.attemptTotals.rejected,
      failed: entry.attemptTotals.failed,
      interrupted: entry.attemptTotals.interrupted,
    },
    lastEventLabel: entry.lastEvent ? bounded(entry.lastEvent.label, 160) : null,
  };
}

function activityEvent(entry: MissionTimelineEntry): DesktopMissionActivityEvent {
  return {
    id: `activity.${entry.sequence}`,
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    missionId: entry.missionId,
    ...(entry.taskId === undefined ? {} : { taskId: entry.taskId }),
    type: bounded(entry.type, 80),
    label: bounded(entry.label, 160),
    ...(entry.reason === undefined ? {} : { reason: bounded(entry.reason, 240) }),
    actor: {
      type: entry.actor.type,
      label: bounded(
        entry.actor.displayName ?? entry.actor.id ?? entry.actor.profile ?? entry.actor.type,
        200,
      ),
    },
  };
}

/**
 * Bounded, path-free desktop projection of durable mission state. It is
 * embedded in the existing application-shell V3 resource and contains no
 * repository locations, tmux targets, or mutation authority.
 */
export function projectDesktopMissionWorkspace(
  snapshot: MissionRepositorySnapshot,
): DesktopMissionWorkspaceResource {
  if (
    Object.keys(snapshot.state.missions).length > DESKTOP_MISSION_MAX_SOURCE_MISSIONS ||
    snapshot.history.length > DESKTOP_MISSION_MAX_SOURCE_EVENTS
  ) {
    return {
      status: "degraded",
      reason: "Mission history exceeds the bounded desktop projection window.",
    };
  }
  const board = projectMissionBoard(snapshot.state, snapshot.history);
  const history = projectMissionHistory(snapshot.state, snapshot.history);
  const cards = COLUMN_ORDER.flatMap((column) => board.columns[column]);
  const activity = projectMissionActivity(snapshot.state, snapshot.history);

  if (cards.length === 0 && history.length === 0 && activity.length === 0) {
    return DesktopMissionWorkspaceResourceSchemaZ.parse({
      status: "empty",
      counts: { missions: 0, history: 0, activity: 0 },
      missions: [],
      history: [],
      activity: [],
      truncated: false,
    });
  }

  return DesktopMissionWorkspaceResourceSchemaZ.parse({
    status: "ready",
    counts: {
      missions: cards.length,
      history: history.length,
      activity: activity.length,
    },
    missions: cards.slice(0, DESKTOP_MISSION_MAX_VISIBLE).map(missionSummary),
    history: history.slice(-DESKTOP_MISSION_MAX_HISTORY).reverse().map(historySummary),
    activity: activity.slice(0, DESKTOP_MISSION_MAX_ACTIVITY).map(activityEvent),
    truncated:
      cards.length > DESKTOP_MISSION_MAX_VISIBLE ||
      history.length > DESKTOP_MISSION_MAX_HISTORY ||
      activity.length > DESKTOP_MISSION_MAX_ACTIVITY,
  });
}
