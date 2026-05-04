"use client";

import { Users } from "lucide-react";
import { useState } from "react";
import type { SessionSnapshot } from "@/lib/useSessionStream";
import { StatusPopover } from "./StatusPopover";

export function AgentsSegment({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const [open, setOpen] = useState(false);
  const agents = snapshot?.agents ?? [];

  if (agents.length === 0) return null;

  const busy = agents.filter((agent) => agent.isBusy).length;

  return (
    <>
      <span className="mx-2 opacity-30">│</span>
      <StatusPopover
        open={open}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            data-testid="status-segment-agents"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1 text-left text-[var(--dim)] transition-colors motion-safe:active:scale-[0.98] hover:text-[var(--fg)]"
          >
            <Users aria-hidden="true" size={12} />
            <span className="text-[var(--green)]">{busy}</span>
            <span>/{agents.length} agents</span>
          </button>
        }
      >
        <div className="space-y-2">
          <div className="text-[var(--accent)]">agents</div>
          <div className="space-y-1.5">
            {agents.map((agent) => (
              <div
                key={agent.paneId}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-2"
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: agent.isBusy ? "var(--green)" : "var(--dim)" }}
                />
                <span className="min-w-0 truncate">
                  <span className="text-[var(--fg)]">{agent.paneTitle}</span>
                  {agent.taskTitle && (
                    <span className="text-[var(--dim)]"> · {agent.taskTitle}</span>
                  )}
                </span>
                <span className="text-[var(--dim)]">{agent.elapsed}</span>
              </div>
            ))}
          </div>
        </div>
      </StatusPopover>
    </>
  );
}
