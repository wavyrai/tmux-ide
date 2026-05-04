"use client";

import { Target } from "lucide-react";
import { useState } from "react";
import type { MissionDetail } from "@/lib/api";
import type { SessionSnapshot } from "@/lib/useSessionStream";
import { StatusPopover } from "./StatusPopover";

function statusColor(status: string): string {
  if (status === "complete") return "var(--green)";
  if (status === "active") return "var(--accent)";
  return "var(--yellow)";
}

function validationText(summary: MissionDetail["validationSummary"]): string {
  if (summary.total === 0) return "no assertions";
  const failing = summary.failing > 0 ? `, ${summary.failing} failing` : "";
  return `${summary.passing}/${summary.total} passing${failing}`;
}

export function MissionStatusSegment({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const data = snapshot?.mission ?? null;

  if (!data) return null;

  const label = `${data.mission.title} - ${data.mission.status}`;

  return (
    <>
      <span className="mx-2 opacity-30">│</span>
      <StatusPopover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            data-testid="status-segment-mission"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex max-w-64 items-center gap-1.5 truncate text-left text-[var(--dim)] transition-colors motion-safe:active:scale-[0.98] hover:text-[var(--fg)]"
            title={label}
          >
            <Target aria-hidden="true" size={12} className="shrink-0" />
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: statusColor(data.mission.status) }}
            />
            <span className="truncate">{label}</span>
          </button>
        }
      >
        <div className="space-y-2">
          <div>
            <div className="text-[var(--accent)]">{data.mission.title}</div>
            <div className="mt-1 max-w-sm whitespace-pre-wrap text-[var(--dim)]">
              {data.mission.description || "no description"}
            </div>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <span className="text-[var(--dim)]">status</span>
            <span style={{ color: statusColor(data.mission.status) }}>{data.mission.status}</span>
            <span className="text-[var(--dim)]">validation</span>
            <span>{validationText(data.validationSummary)}</span>
            {data.mission.branch && (
              <>
                <span className="text-[var(--dim)]">branch</span>
                <span className="truncate">{data.mission.branch}</span>
              </>
            )}
          </div>
        </div>
      </StatusPopover>
    </>
  );
}
