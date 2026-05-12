"use client";

/**
 * React → Solid bridge for the KanbanBoard widget.
 *
 * Mirrors tasks-view-bridge / mission-control-bridge pattern:
 *   - Mount once on `useEffect([])`, never on prop change.
 *   - Push prop updates (tasks) through `handle.setOptions({ ... })`.
 *   - The widget owns filter / group / search / optimistic-status state.
 *   - Status-cycle mutations leave the widget via onTaskStatusChange; the
 *     bridge issues the API call and lets the next snapshot land back in
 *     via setOptions.
 *
 * ADR-0001 §1.4 Rule 4: this is the *only* `*Bridge.tsx` allowed to
 * call mount() for the KanbanBoard widget.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { updateTask } from "@/lib/api";
import { CreateTaskDialog } from "@/components/kanban/CreateTaskDialog";
import { useToasts } from "@/lib/useToasts";
import type { Goal, Task } from "@/lib/types";

interface KanbanBoardBridgeProps {
  sessionName: string;
  tasks: ReadonlyArray<Task>;
  goals: ReadonlyArray<Goal>;
}

interface BridgeTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  assignee?: string | null;
  goal?: string | null;
  milestone?: string | null;
  depends_on?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  description?: string | null;
  created?: string;
  updated?: string;
}

type KanbanTaskStatus = "todo" | "in-progress" | "review" | "done";

interface KanbanBoardMountHandle {
  unmount(): void;
  setOptions(next: {
    tasks?: ReadonlyArray<BridgeTask>;
    onTaskClick?: (taskId: string) => void;
    onTaskStatusChange?: (taskId: string, nextStatus: KanbanTaskStatus) => void;
    onCreateTask?: () => void;
  }): void;
}

function normalizeTasks(tasks: ReadonlyArray<Task>): BridgeTask[] {
  return tasks.map((t) => {
    const out: BridgeTask = {
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
    };
    if (t.assignee !== undefined) out.assignee = t.assignee;
    if (t.goal !== undefined) out.goal = t.goal;
    if ((t as { milestone?: string | null }).milestone !== undefined) {
      out.milestone = (t as { milestone?: string | null }).milestone;
    }
    if ((t as { depends_on?: string[] }).depends_on) {
      out.depends_on = (t as { depends_on: string[] }).depends_on;
    }
    if (t.tags) out.tags = t.tags;
    if (t.description !== undefined) out.description = t.description;
    if (t.created !== undefined) out.created = t.created;
    if (t.updated !== undefined) out.updated = t.updated;
    return out;
  });
}

export function KanbanBoardBridge({
  sessionName,
  tasks,
  goals,
}: KanbanBoardBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<KanbanBoardMountHandle | null>(null);
  const { push } = useToasts();
  const [createOpen, setCreateOpen] = useState(false);

  const handleTaskStatusChange = useCallback(
    async (taskId: string, nextStatus: KanbanTaskStatus) => {
      const updated = await updateTask(sessionName, taskId, { status: nextStatus });
      if (!updated) {
        push({
          kind: "error",
          title: "Failed to update task status",
          body: taskId,
          scope: { project: sessionName },
        });
      }
    },
    [sessionName, push],
  );

  const handleTaskClick = useCallback((taskId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "kanban");
    url.searchParams.set("task", taskId);
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  // (1) Mount once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountKanbanBoard(el, {
        tasks: normalizeTasks(tasks),
        onTaskClick: handleTaskClick,
        onTaskStatusChange: handleTaskStatusChange,
        onCreateTask: () => setCreateOpen(true),
      });
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (2) Push tasks updates through the setter.
  useEffect(() => {
    handleRef.current?.setOptions({ tasks: normalizeTasks(tasks) });
  }, [tasks]);

  // Keep the status-change handler current (it closes over sessionName).
  useEffect(() => {
    handleRef.current?.setOptions({ onTaskStatusChange: handleTaskStatusChange });
  }, [handleTaskStatusChange]);

  return (
    <>
      <div
        ref={containerRef}
        data-testid="kanban-board-bridge"
        data-project-name={sessionName}
        style={{ display: "flex", flex: "1 1 0%", minHeight: 0, minWidth: 0, width: "100%" }}
      />
      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sessionName={sessionName}
        goals={goals}
      />
    </>
  );
}
