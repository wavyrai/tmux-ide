"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { KeyboardEvent, MouseEvent } from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types";
import { TaskCard } from "./TaskCard";
import {
  isBlocked,
  type ColumnDef,
  type Density,
  type TaskStatus,
} from "./kanban-types";

interface KanbanColumnProps {
  column: ColumnDef;
  tasks: Task[];
  allTasks: Task[];
  density: Density;
  selectedIds: Set<string>;
  onOpenTask: (taskId: string) => void;
  onSelectTask: (taskId: string, event: MouseEvent | KeyboardEvent) => void;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onAddTask?: () => void;
}

export function KanbanColumn({
  column,
  tasks,
  allTasks,
  density,
  selectedIds,
  onOpenTask,
  onSelectTask,
  onStatusChange,
  onAddTask,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: column.id,
    data: { type: "column", columnId: column.id, status: column.status },
  });

  return (
    <div
      data-testid={`kanban-column-${column.id}`}
      data-column-id={column.id}
      className="flex h-full w-[320px] shrink-0 flex-col"
    >
      <header className="mb-2 flex h-7 shrink-0 items-center gap-2 px-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full"
          style={{ background: column.color }}
        />
        <span className="text-[12px] font-medium text-[var(--fg)]">{column.label}</span>
        <span className="rounded-md bg-[var(--surface)] px-1.5 text-[10px] tabular-nums text-[var(--dim)]">
          {tasks.length}
        </span>
        <span className="flex-1" />
        {onAddTask && (
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onAddTask}
            data-testid={`kanban-column-add-${column.id}`}
            aria-label={`Add task to ${column.label}`}
          >
            <Plus aria-hidden="true" size={13} />
          </Button>
        )}
      </header>

      <div
        ref={setNodeRef}
        data-testid={`kanban-column-body-${column.id}`}
        data-over={isOver ? "true" : "false"}
        className={cn(
          "flex min-h-0 flex-1 flex-col rounded-md border border-transparent bg-[var(--bg-weak)] transition-colors",
          isOver && "border-[var(--accent)] bg-[var(--surface-hover)]",
        )}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1.5 overflow-y-auto p-2">
            <AnimatePresence initial={false}>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  density={density}
                  selected={selectedIds.has(task.id)}
                  blocked={isBlocked(task, allTasks)}
                  onOpen={() => onOpenTask(task.id)}
                  onSelect={(event) => onSelectTask(task.id, event)}
                  onStatusChange={(status) => onStatusChange(task.id, status)}
                />
              ))}
            </AnimatePresence>
            {tasks.length === 0 && (
              <motion.div
                layout
                data-testid={`kanban-column-empty-${column.id}`}
                className="rounded-md border border-dashed border-[var(--border-weak)] px-3 py-6 text-center text-[11px] text-[var(--dim)]"
              >
                No tasks here yet
              </motion.div>
            )}
          </div>
        </SortableContext>
      </div>
    </div>
  );
}
