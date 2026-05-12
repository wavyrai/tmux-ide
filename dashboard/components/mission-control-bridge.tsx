"use client";

/**
 * React → Solid bridge for the Mission Control dashboard widget.
 *
 * Subscribes to useSessionStream (WebSocket bus) for the live snapshot,
 * normalizes it into the framework-agnostic shape expected by the Solid
 * widget, and pushes updates through `setOptions({ snapshot })`. Click
 * callbacks travel Solid → React via onTaskClick / onAgentClick /
 * onShowAllEvents — the host routes those to the kanban tab, the agent
 * detail dialog, and the activity tab respectively.
 *
 * ADR-0001 §1.4 Rule 4: this is the one *Bridge file allowed to call
 * mount() for the Mission Control widget.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSessionStream } from "@/lib/useSessionStream";
import type {
  AgentDetail as DashAgent,
  Task as DashTask,
} from "@/lib/types";
import type { EventData, MilestoneData } from "@/lib/api";

interface MissionControlBridgeProps {
  sessionName: string;
}

// Match @tmux-ide/v2-solid-widgets's exported types without importing them
// at compile time (the package is dynamically imported below to keep this
// file inside Next's RSC graph).
interface BridgeSnapshot {
  mission: {
    title: string;
    description: string;
    status: string;
    branch: string | null;
  } | null;
  validation: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
    blocked: number;
  } | null;
  milestones: Array<{
    id: string;
    title: string;
    status: string;
    order: number;
    taskCount: number;
    tasksDone: number;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    milestone?: string | null;
    assignee?: string | null;
  }>;
  agents: Array<{
    paneTitle: string;
    paneId: string;
    isBusy: boolean;
    taskTitle: string | null;
    taskId: string | null;
    elapsed: string;
  }>;
  events: Array<{
    timestamp: string;
    type: string;
    message: string;
    agent?: string | null;
    taskId?: string;
    relative?: string;
  }>;
}

type MissionControlDashboardMountHandle = {
  unmount(): void;
  setOptions(next: {
    snapshot?: BridgeSnapshot | null;
    eventLimit?: number;
    onTaskClick?: (taskId: string) => void;
    onAgentClick?: (paneId: string) => void;
    onShowAllEvents?: () => void;
  }): void;
};

function normalize(snapshot: ReturnType<typeof useSessionStream>["snapshot"]): BridgeSnapshot | null {
  if (!snapshot) return null;
  const missionDetail = snapshot.mission;
  const milestones: BridgeSnapshot["milestones"] = (
    snapshot.milestones ?? missionDetail?.mission.milestones ?? []
  ).map((m: MilestoneData) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    order: m.order,
    taskCount: m.taskCount,
    tasksDone: m.tasksDone,
  }));
  return {
    mission: missionDetail
      ? {
          title: missionDetail.mission.title,
          description: missionDetail.mission.description,
          status: missionDetail.mission.status,
          branch: missionDetail.mission.branch,
        }
      : null,
    validation: missionDetail ? missionDetail.validationSummary : null,
    milestones,
    tasks: snapshot.tasks.map((t: DashTask) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      milestone: t.milestone ?? null,
      assignee: t.assignee ?? null,
    })),
    agents: snapshot.agents.map((a: DashAgent) => ({
      paneTitle: a.paneTitle,
      paneId: a.paneId,
      isBusy: a.isBusy,
      taskTitle: a.taskTitle,
      taskId: a.taskId,
      elapsed: a.elapsed,
    })),
    events: snapshot.events.map((e: EventData) => ({
      timestamp: e.timestamp,
      type: e.type,
      message: e.message,
      agent: e.agent ?? null,
      taskId: e.taskId,
      relative: e.relative,
    })),
  };
}

export function MissionControlBridge({ sessionName }: MissionControlBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MissionControlDashboardMountHandle | null>(null);
  const { snapshot } = useSessionStream(sessionName);
  const normalized = useMemo(() => normalize(snapshot), [snapshot]);

  // Stable callback refs so re-renders don't trigger remount.
  const handleTaskClick = useCallback((taskId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "kanban");
    url.searchParams.set("task", taskId);
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const handleAgentClick = useCallback((paneId: string) => {
    // The full agent dialog lives in the React tree; for now we route to
    // the activity surface and let the host pick up the pane focus.
    void paneId;
  }, []);
  const handleShowAllEvents = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "activity");
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountMissionControlDashboard(el, {
        snapshot: normalized,
        eventLimit: 20,
        onTaskClick: handleTaskClick,
        onAgentClick: handleAgentClick,
        onShowAllEvents: handleShowAllEvents,
      });
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // Mount once; snapshot updates flow through setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setOptions({ snapshot: normalized });
  }, [normalized]);

  return (
    <div
      ref={containerRef}
      data-testid="mission-control-bridge"
      data-session-name={sessionName}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
    />
  );
}
