"use client";

import { useState } from "react";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import type { Task, AgentDetail } from "@/lib/types";

interface KanbanBoardProps {
  tasks: Task[];
  sessionName: string;
  agents: AgentDetail[];
  onRefresh: () => void;
}

type ColumnStatus = Task["status"];

const COLUMNS: { status: ColumnStatus; label: string; color: string }[] = [
  { status: "todo", label: "TODO", color: "var(--dim)" },
  { status: "in-progress", label: "DOING", color: "var(--yellow)" },
  { status: "review", label: "REVIEW", color: "var(--magenta)" },
  { status: "done", label: "DONE", color: "var(--green)" },
];

export function KanbanBoard({
  tasks,
  sessionName,
  agents,
  onRefresh,
}: KanbanBoardProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const selectedTask = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId) ?? null
    : null;

  return (
    <>
      <div className="grid grid-cols-4 gap-px flex-1 min-h-0 bg-[var(--border)]">
        {COLUMNS.map((col) => {
          const colTasks = tasks
            .filter((t) => t.status === col.status)
            .sort((a, b) => a.priority - b.priority);

          return (
            <div
              key={col.status}
              className="bg-[var(--bg)] flex flex-col min-h-0"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-2 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
                <span style={{ color: col.color }}>{col.label}</span>
                <span className="text-[var(--dim)]">{colTasks.length}</span>
              </div>

              {/* Cards */}
              <div className="flex-1 overflow-auto p-px">
                {colTasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    selected={t.id === selectedTaskId}
                    onClick={() =>
                      setSelectedTaskId(
                        selectedTaskId === t.id ? null : t.id,
                      )
                    }
                  />
                ))}
                {colTasks.length === 0 && (
                  <div className="text-[var(--dim)] text-center py-4 text-[11px]">
                    —
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Task detail panel */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          sessionName={sessionName}
          agents={agents}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={onRefresh}
        />
      )}
    </>
  );
}
