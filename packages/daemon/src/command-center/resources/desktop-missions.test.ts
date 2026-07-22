import { describe, expect, it } from "vitest";
import {
  DESKTOP_MISSION_MAX_ACTIVITY,
  DESKTOP_MISSION_MAX_VISIBLE,
  type MissionHistoryEntry,
} from "@tmux-ide/contracts";

import { replayMissionEvents } from "../../lib/mission-repository.ts";
import {
  DESKTOP_MISSION_MAX_SOURCE_EVENTS,
  projectDesktopMissionWorkspace,
} from "./desktop-missions.ts";

const timestamp = "2026-07-22T10:00:00.000Z";
const actor = { type: "user" as const, id: "pm", displayName: "Project manager" };

function snapshot(history: MissionHistoryEntry[]) {
  return {
    history,
    state: replayMissionEvents(
      history.map((entry) => ({
        version: 1 as const,
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        payload: entry.event,
      })),
    ),
  };
}

describe("desktop mission workspace projection", () => {
  it("projects an honest empty state", () => {
    expect(projectDesktopMissionWorkspace(snapshot([]))).toEqual({
      status: "empty",
      counts: { missions: 0, history: 0, activity: 0 },
      missions: [],
      history: [],
      activity: [],
      truncated: false,
    });
  });

  it("bounds mission and activity load while retaining newest-first event order", () => {
    const history: MissionHistoryEntry[] = [];
    let sequence = 0;
    for (let index = 0; index < DESKTOP_MISSION_MAX_VISIBLE + 6; index += 1) {
      const missionId = `mis_${String(index).padStart(3, "0")}`;
      sequence += 1;
      history.push({
        sequence,
        timestamp,
        event: {
          version: 1,
          type: "mission.created",
          missionId,
          title: `Mission ${index}`,
          objective: "Prove a bounded desktop projection.",
          acceptanceCriteria: [],
          constraints: [],
          labels: [],
          actor,
        },
      });
      sequence += 1;
      history.push({
        sequence,
        timestamp,
        event: { version: 1, type: "mission.started", missionId, actor },
      });
    }

    const projected = projectDesktopMissionWorkspace(snapshot(history));
    expect(projected.status).toBe("ready");
    if (projected.status !== "ready") return;
    expect(projected.counts).toEqual({
      missions: DESKTOP_MISSION_MAX_VISIBLE + 6,
      history: 0,
      activity: history.length,
    });
    expect(projected.missions).toHaveLength(DESKTOP_MISSION_MAX_VISIBLE);
    expect(projected.activity).toHaveLength(DESKTOP_MISSION_MAX_ACTIVITY);
    expect(projected.activity[0]?.sequence).toBe(history.length);
    expect(projected.activity.at(-1)?.sequence).toBe(
      history.length - DESKTOP_MISSION_MAX_ACTIVITY + 1,
    );
    expect(projected.truncated).toBe(true);
    expect(JSON.stringify(projected)).not.toMatch(/worktree|terminal|session|\/private\//u);
  });

  it("fails closed before projecting an oversized durable event stream", () => {
    const small = snapshot([
      {
        sequence: 1,
        timestamp,
        event: {
          version: 1,
          type: "mission.created",
          missionId: "mis_alpha",
          title: "Alpha",
          objective: "Keep desktop reads bounded.",
          acceptanceCriteria: [],
          constraints: [],
          labels: [],
          actor,
        },
      },
    ]);
    const oversized = {
      ...small,
      history: Array.from(
        { length: DESKTOP_MISSION_MAX_SOURCE_EVENTS + 1 },
        () => small.history[0]!,
      ),
    };

    expect(projectDesktopMissionWorkspace(oversized)).toEqual({
      status: "degraded",
      reason: "Mission history exceeds the bounded desktop projection window.",
    });
  });
});
