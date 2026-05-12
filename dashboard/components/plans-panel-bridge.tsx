"use client";

/**
 * React → Solid bridge for the production Plans panel.
 *
 * Companion to PlansRail's bridge surface. The host owns the
 * currently-selected plan + its body+authorship payload and pushes
 * them through `setOptions({ plan, planData })` on every prop change.
 * The widget never fetches.
 *
 * ADR-0001 §1.4 Rule 4: this is the one *Bridge file allowed to call
 * mount() for the plans panel.
 */

import { useEffect, useRef } from "react";
import type { PlanData, PlanSummary } from "@/lib/api";

interface PlansPanelBridgeProps {
  plan: PlanSummary | null;
  planData: PlanData;
  onEdit?: () => void;
  onMarkDone?: () => void;
}

type PlansPanelMountHandle = {
  unmount(): void;
  setOptions(next: {
    plan?: PlanSummary | null;
    planData?: PlanData | null;
    onEdit?: () => void;
    onMarkDone?: () => void;
  }): void;
};

export function PlansPanelBridge({
  plan,
  planData,
  onEdit,
  onMarkDone,
}: PlansPanelBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<PlansPanelMountHandle | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountPlansPanel(el, {
        plan,
        planData,
        onEdit,
        onMarkDone,
      });
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
    handleRef.current?.setOptions({ plan, planData, onEdit, onMarkDone });
  }, [plan, planData, onEdit, onMarkDone]);

  return (
    <div
      ref={containerRef}
      data-testid="plans-panel-bridge"
      data-plan-file={plan?.path ?? ""}
      style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
    />
  );
}
