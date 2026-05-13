"use client";

/**
 * React → Solid bridge for the snapshot-driven CostsDashboard widget.
 *
 * Replaces V2CostsIsland (which mounted the polling Costs widget that
 * fetched mission/detail/events every 5s). The metrics endpoint
 * (/api/project/:name/metrics) is REST-only, so this bridge piggybacks
 * on the WS-bus channel: it does an initial fetch, then refetches on
 * each WS *.changed frame. Idle sessions stop refetching entirely —
 * the 5s polling timer is gone.
 *
 * ADR-0001 §1.4 Rule 4: the one *Bridge file allowed to call mount()
 * for the CostsDashboard widget.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchMetrics, type MetricsData } from "@/lib/api";
import { subscribeSession, type ServerFrame } from "@/lib/wsBus";
import type {
  CostsDashboardMountHandle,
  CostsDashboardMountOptions,
  CostsDashboardSnapshot,
} from "@tmux-ide/v2-solid-widgets";

interface CostsDashboardBridgeProps {
  projectName: string;
}

function toSnapshot(data: MetricsData): CostsDashboardSnapshot {
  return {
    session: data.session,
    tasks: data.tasks,
    agents: data.agents,
    mission: data.mission,
    timeline: data.timeline,
  };
}

export function CostsDashboardBridge({ projectName }: CostsDashboardBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CostsDashboardMountHandle | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);

  // Initial fetch + WS-driven refresh. The WS bus already broadcasts
  // task/mission/milestone/agent change frames; we refetch metrics on
  // any of them. No timer — idle sessions never refetch.
  useEffect(() => {
    if (!projectName) return;
    let cancelled = false;

    async function refresh() {
      const next = await fetchMetrics(projectName);
      if (!cancelled) setMetrics(next);
    }
    void refresh();

    const release = subscribeSession(projectName, (frame: ServerFrame) => {
      switch (frame.type) {
        case "snapshot":
        case "task.changed":
        case "mission.changed":
        case "milestone.changed":
        case "goal.changed":
        case "agent.changed":
        case "event.appended":
          void refresh();
          return;
        default:
          return;
      }
    });

    return () => {
      cancelled = true;
      release();
    };
  }, [projectName]);

  const mountOptions = useMemo<CostsDashboardMountOptions>(
    () => ({ snapshot: metrics ? toSnapshot(metrics) : null }),
    [metrics],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountCostsDashboard(el, mountOptions);
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
      data-testid="costs-dashboard-bridge"
      data-project-name={projectName}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
    />
  );
}
