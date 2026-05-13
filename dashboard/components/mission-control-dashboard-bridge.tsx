"use client";

/**
 * React → Solid bridge for the snapshot-driven MissionControlDashboard
 * widget. Source is `useSessionStream` — the shared WS-bus channel that
 * already powers the rest of the dashboard. No polling: when the bus
 * pushes a snapshot or *.changed frame, useSessionStream's channel
 * refetches once and broadcasts; this bridge re-derives the dashboard
 * snapshot shape and pushes it into the widget via setOptions.
 *
 * Replaces V2MissionControlIsland (which mounted the polling
 * MissionControl widget that fetched mission/detail/events every 5s).
 *
 * ADR-0001 §1.4 Rule 4: the one *Bridge file allowed to call mount()
 * for the MissionControlDashboard widget.
 */

import { useEffect, useMemo, useRef } from "react";
import { useSessionStream } from "@/lib/useSessionStream";
import type {
  MissionControlDashboardMountHandle,
  MissionControlDashboardMountOptions,
  MissionControlDashboardSnapshot,
} from "@tmux-ide/v2-solid-widgets";

interface MissionControlDashboardBridgeProps {
  projectName: string;
  onTaskClick?: (taskId: string) => void;
  onAgentClick?: (paneId: string) => void;
  onShowAllEvents?: () => void;
}

export function MissionControlDashboardBridge({
  projectName,
  onTaskClick,
  onAgentClick,
  onShowAllEvents,
}: MissionControlDashboardBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MissionControlDashboardMountHandle | null>(null);
  const { snapshot } = useSessionStream(projectName);

  const dashboardSnapshot = useMemo<MissionControlDashboardSnapshot | null>(() => {
    if (!snapshot) return null;
    const missionInfo = snapshot.mission?.mission ?? null;
    return {
      mission: missionInfo
        ? {
            title: missionInfo.title,
            description: missionInfo.description,
            status: missionInfo.status,
            branch: missionInfo.branch ?? null,
          }
        : null,
      validation: snapshot.mission?.validationSummary ?? null,
      milestones: snapshot.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        order: m.order,
        taskCount: m.taskCount,
        tasksDone: m.tasksDone,
      })),
      tasks: snapshot.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        milestone: t.milestone ?? null,
        assignee: t.assignee ?? null,
      })),
      agents: snapshot.agents.map((a) => ({
        paneTitle: a.paneTitle,
        paneId: a.paneId,
        isBusy: a.isBusy,
        taskTitle: a.taskTitle,
        taskId: a.taskId,
        elapsed: a.elapsed,
      })),
      events: snapshot.events.map((e) => ({
        timestamp: e.timestamp,
        type: e.type,
        message: e.message,
        agent: e.agent ?? null,
        taskId: e.taskId,
        relative: e.relative,
      })),
    };
  }, [snapshot]);

  const mountOptions = useMemo<MissionControlDashboardMountOptions>(
    () => ({
      snapshot: dashboardSnapshot,
      onTaskClick,
      onAgentClick,
      onShowAllEvents,
    }),
    [dashboardSnapshot, onTaskClick, onAgentClick, onShowAllEvents],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountMissionControlDashboard(el, mountOptions);
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // Mount once; updates flow via setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setOptions(mountOptions);
  }, [mountOptions]);

  return (
    <div
      ref={containerRef}
      data-testid="mission-control-dashboard-bridge"
      data-project-name={projectName}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
    />
  );
}
