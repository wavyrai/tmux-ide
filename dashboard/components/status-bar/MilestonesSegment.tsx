"use client";

import { Milestone } from "lucide-react";
import { useState } from "react";
import type { MilestoneData } from "@/lib/api";
import type { SessionSnapshot } from "@/lib/useSessionStream";
import { StatusPopover } from "./StatusPopover";

function milestoneColor(status: MilestoneData["status"]): string {
  if (status === "done") return "var(--green)";
  if (status === "active") return "var(--accent)";
  if (status === "validating") return "var(--yellow)";
  return "var(--dim)";
}

function percent(milestone: MilestoneData): number {
  return milestone.taskCount > 0
    ? Math.round((milestone.tasksDone / milestone.taskCount) * 100)
    : 0;
}

export function MilestonesSegment({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const data = snapshot?.milestones ?? [];

  if (!snapshot) return null;

  const active = data.find((milestone) => milestone.status === "active");
  const label = active
    ? `${active.id} · ${active.tasksDone}/${active.taskCount}`
    : "no active milestone";

  return (
    <>
      <span className="mx-2 opacity-30">│</span>
      <StatusPopover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            data-testid="status-segment-milestones"
            onClick={() => setOpen((value) => !value)}
            className={`inline-flex items-center gap-1.5 text-left transition-colors motion-safe:active:scale-[0.98] hover:text-[var(--fg)] ${
              active ? "text-[var(--dim)]" : "text-[var(--dim)] opacity-70"
            }`}
          >
            <Milestone aria-hidden="true" size={12} />
            {active && (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: milestoneColor(active.status) }}
              />
            )}
            <span>{label}</span>
          </button>
        }
      >
        <div className="space-y-2">
          <div className="text-[var(--accent)]">milestones</div>
          {data.length === 0 ? (
            <div className="text-[var(--dim)]">no milestones</div>
          ) : (
            <div className="space-y-2">
              {data.map((milestone) => (
                <div key={milestone.id} className="space-y-1">
                  <div className="flex items-center justify-between gap-4">
                    <span className="min-w-0 truncate">
                      <span style={{ color: milestoneColor(milestone.status) }}>
                        {milestone.id}
                      </span>{" "}
                      {milestone.title}
                    </span>
                    <span className="shrink-0 text-[var(--dim)]">
                      {milestone.tasksDone}/{milestone.taskCount}
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden bg-[var(--border)]">
                    <div
                      className="h-full bg-[var(--accent)]"
                      style={{ width: `${percent(milestone)}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-[var(--dim)]">{milestone.status}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </StatusPopover>
    </>
  );
}
