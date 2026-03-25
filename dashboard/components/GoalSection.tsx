"use client";

import { useState } from "react";
import { ProgressBar } from "./ProgressBar";
import { TaskRow } from "./TaskRow";
import type { Goal, Task } from "@/lib/types";

interface GoalSectionProps {
  goal: Goal;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
}

export function GoalSection({ goal, tasks, selectedTaskId, onSelectTask }: GoalSectionProps) {
  const [collapsed, setCollapsed] = useState(false);

  const done = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <div>
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 h-6 px-2 text-left group hover:bg-[var(--surface-hover)]"
      >
        <span className="text-[var(--dim)] w-3 shrink-0 text-center">{collapsed ? "▸" : "▾"}</span>
        <span className="flex-1 truncate text-[var(--fg)] group-hover:text-[var(--accent)] transition-colors">
          {goal.title}
        </span>
        <span className="text-[var(--dim)] shrink-0">
          {done}/{tasks.length}
        </span>
      </button>
      <div className="ml-5 mb-1">
        <ProgressBar percent={pct} />
      </div>
      {!collapsed && tasks.length > 0 && (
        <div className="ml-3">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              selected={t.id === selectedTaskId}
              onSelect={() => onSelectTask(t.id === selectedTaskId ? null : t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
