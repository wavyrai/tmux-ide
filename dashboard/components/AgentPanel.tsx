"use client";

import { useState } from "react";
import type { AgentDetail, Task } from "@/lib/types";

interface AgentPanelProps {
  agents: AgentDetail[];
  tasks: Task[];
}

export function AgentPanel({ agents, tasks }: AgentPanelProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  if (agents.length === 0) {
    return <div className="text-[var(--dim)] px-2">No agents detected</div>;
  }

  return (
    <div>
      {agents.map((a, i) => {
        const expanded = expandedAgent === a.paneTitle;
        const task = a.taskId ? tasks.find((t) => t.id === a.taskId) : null;

        return (
          <div key={`${a.paneTitle}-${i}`}>
            <div
              className={`flex items-center h-6 px-2 cursor-pointer ${
                expanded ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]"
              }`}
              onClick={() => setExpandedAgent(expanded ? null : a.paneTitle)}
            >
              {/* Status dot with pulse for busy */}
              <span className="w-3 shrink-0 relative">
                <span style={{ color: a.isBusy ? "var(--yellow)" : "var(--dim)" }}>
                  {a.isBusy ? "●" : "○"}
                </span>
                {a.isBusy && (
                  <span
                    className="absolute inset-0 animate-ping opacity-40"
                    style={{ color: "var(--yellow)" }}
                  >
                    ●
                  </span>
                )}
              </span>

              <span className="w-[16ch] shrink-0 text-[var(--fg)] truncate">{a.paneTitle}</span>
              <span
                className={`flex-1 truncate ${a.taskTitle ? "text-[var(--fg-secondary)]" : "text-[var(--dim)]"}`}
              >
                {a.taskTitle ?? (a.isBusy ? "working..." : "idle")}
              </span>
              {a.elapsed && <span className="text-[var(--dim)] shrink-0 pl-2">{a.elapsed}</span>}
            </div>

            {/* Expanded detail */}
            {expanded && task && (
              <div className="pl-[19ch] py-1.5 space-y-1 text-[var(--dim)] border-l border-[var(--surface-active)] ml-[1ch]">
                <div className="text-[var(--fg)]">{task.title}</div>
                {task.description && <div>{task.description}</div>}
                <div className="flex gap-3">
                  <span
                    style={{
                      color:
                        task.status === "in-progress"
                          ? "var(--yellow)"
                          : task.status === "done"
                            ? "var(--green)"
                            : "var(--dim)",
                    }}
                  >
                    {task.status}
                  </span>
                  <span>P{task.priority}</span>
                  {task.branch && <span>⎇ {task.branch}</span>}
                </div>
              </div>
            )}

            {expanded && !task && a.taskTitle && (
              <div className="pl-[19ch] py-1 text-[var(--dim)] border-l border-[var(--surface-active)] ml-[1ch]">
                {a.taskTitle}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
