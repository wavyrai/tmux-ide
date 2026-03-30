"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";
import { CreateTaskModal } from "./CreateTaskModal";
import { updateTask } from "@/lib/api";
import type { Task, AgentDetail, Goal } from "@/lib/types";

interface KanbanBoardProps {
  tasks: Task[];
  sessionName: string;
  agents: AgentDetail[];
  goals?: Goal[];
  onRefresh: () => void;
}

type ColumnStatus = Task["status"];

const COLUMNS: { status: ColumnStatus; label: string; color: string }[] = [
  { status: "todo", label: "TODO", color: "var(--dim)" },
  { status: "in-progress", label: "DOING", color: "var(--yellow)" },
  { status: "review", label: "REVIEW", color: "var(--magenta)" },
  { status: "done", label: "DONE", color: "var(--green)" },
];

// --- Droppable column ---
function DroppableColumn({
  status,
  label,
  color,
  children,
  isOver,
  count,
  onAction,
}: {
  status: string;
  label: string;
  color: string;
  children: React.ReactNode;
  isOver: boolean;
  count: number;
  onAction?: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={`bg-[var(--bg)] flex flex-col min-h-0 transition-colors duration-150 ${
        isOver ? "bg-[var(--surface-hover)]" : ""
      }`}
    >
      <div className="flex items-center justify-between px-2 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <span style={{ color }}>{label}</span>
        <div className="flex items-center gap-2">
          {onAction && (
            <button
              onClick={onAction}
              className="text-[var(--dim)] hover:text-[var(--accent)] transition-colors text-[13px] leading-none"
            >
              +
            </button>
          )}
          <span className="text-[var(--dim)]">{count}</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-px">{children}</div>
    </div>
  );
}

// --- Draggable card wrapper ---
function DraggableCard({
  task,
  selected,
  onClick,
}: {
  task: Task;
  selected: boolean;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : 1,
    transition: isDragging ? "none" : "opacity 150ms ease",
  };

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <TaskCard task={task} selected={selected} onClick={onClick} />
    </div>
  );
}

export function KanbanBoard({
  tasks,
  sessionName,
  agents,
  goals = [],
  onRefresh,
}: KanbanBoardProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const selectedTask = selectedTaskId ? (tasks.find((t) => t.id === selectedTaskId) ?? null) : null;

  const activeTask = activeId ? (tasks.find((t) => t.id === activeId) ?? null) : null;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent) {
    const overId = event.over?.id;
    if (overId && typeof overId === "string") {
      // overId is a column status
      const isColumn = COLUMNS.some((c) => c.status === overId);
      setOverColumn(isColumn ? overId : null);
    } else {
      setOverColumn(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    setOverColumn(null);

    if (!over) return;

    const taskId = String(active.id);
    const newStatus = String(over.id) as ColumnStatus;
    const task = tasks.find((t) => t.id === taskId);

    if (!task || task.status === newStatus) return;
    if (!COLUMNS.some((c) => c.status === newStatus)) return;

    await updateTask(sessionName, taskId, { status: newStatus });
    onRefresh();
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-4 gap-px flex-1 min-h-0 bg-[var(--border)]">
          {COLUMNS.map((col) => {
            const colTasks = tasks
              .filter((t) => t.status === col.status)
              .sort((a, b) => a.priority - b.priority);

            return (
              <DroppableColumn
                key={col.status}
                status={col.status}
                label={col.label}
                color={col.color}
                count={colTasks.length}
                isOver={overColumn === col.status}
                onAction={col.status === "todo" ? () => setShowCreate(true) : undefined}
              >
                {colTasks.map((t) => (
                  <DraggableCard
                    key={t.id}
                    task={t}
                    selected={t.id === selectedTaskId}
                    onClick={() => setSelectedTaskId(selectedTaskId === t.id ? null : t.id)}
                  />
                ))}
                {colTasks.length === 0 && (
                  <div className="text-[var(--dim)] text-center py-4 text-[11px]">—</div>
                )}
              </DroppableColumn>
            );
          })}
        </div>

        {/* Drag overlay — shows the card being dragged */}
        <DragOverlay dropAnimation={null}>
          {activeTask && (
            <div className="opacity-90 shadow-lg pointer-events-none">
              <TaskCard task={activeTask} selected={false} onClick={() => {}} />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          sessionName={sessionName}
          agents={agents}
          allTasks={tasks}
          onClose={() => setSelectedTaskId(null)}
          onUpdated={onRefresh}
        />
      )}

      {showCreate && (
        <CreateTaskModal
          sessionName={sessionName}
          goals={goals}
          onClose={() => setShowCreate(false)}
          onCreated={onRefresh}
        />
      )}
    </>
  );
}
