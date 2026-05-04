"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  Button,
  Panel,
  PanelBody,
  PanelHeader,
} from "@/components/ui";
import { NavigatorPortal } from "@/lib/useNavigatorSlot";
import {
  deleteTaskApi,
  updateTask,
  type EventData,
} from "@/lib/api";
import type { AgentDetail, Goal, Task } from "@/lib/types";
import { useToasts } from "@/lib/useToasts";
import { BulkActionsBar } from "./BulkActionsBar";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { DensityToggle } from "./DensityToggle";
import { FilterBar } from "./FilterBar";
import { GroupByToggle } from "./GroupByToggle";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanNavigator } from "./KanbanNavigator";
import { TaskCard } from "./TaskCard";
import { TaskDetailPanel } from "./TaskDetailPanel";
import {
  buildColumns,
  columnIdForTask,
  isBlocked,
  taskMatchesFilters,
  type GroupBy,
  type KanbanFilters,
  type TaskStatus,
} from "./kanban-types";
import { useKanbanState } from "./useKanbanState";

interface KanbanBoardProps {
  sessionName: string;
  tasks: Task[];
  agents: AgentDetail[];
  goals: Goal[];
  events: EventData[];
}

interface OptimisticPatch {
  taskId: string;
  fields: Partial<Task>;
}

function applyPatches(tasks: Task[], patches: OptimisticPatch[]): Task[] {
  if (patches.length === 0) return tasks;
  const map = new Map(patches.map((p) => [p.taskId, p.fields]));
  return tasks.map((task) => {
    const fields = map.get(task.id);
    return fields ? { ...task, ...fields } : task;
  });
}

export function KanbanBoard({
  sessionName,
  tasks: tasksProp,
  agents,
  goals,
  events,
}: KanbanBoardProps) {
  const { push } = useToasts();
  const {
    filters,
    setFilters,
    groupBy,
    setGroupBy,
    density,
    setDensity,
    clearFilters,
    hasActiveFilters,
  } = useKanbanState();

  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticPatch[]>([]);
  const focusTaskRef = useRef<string | null>(null);

  // Combine prop tasks with any pending optimistic patches.
  const tasks = useMemo(() => applyPatches(tasksProp, optimistic), [tasksProp, optimistic]);

  // Filtered tasks for display.
  const visibleTasks = useMemo(
    () => tasks.filter((t) => taskMatchesFilters(t, filters)),
    [tasks, filters],
  );

  const columns = useMemo(() => buildColumns(visibleTasks, groupBy), [visibleTasks, groupBy]);
  const tasksByColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const col of columns) map.set(col.id, []);
    for (const task of visibleTasks) {
      const colId = columnIdForTask(task, groupBy);
      const list = map.get(colId);
      if (list) list.push(task);
    }
    // Sort by priority then by created.
    for (const [, list] of map) {
      list.sort((a, b) => a.priority - b.priority || a.created.localeCompare(b.created));
    }
    return map;
  }, [columns, visibleTasks, groupBy]);

  const flatVisibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const col of columns) {
      for (const task of tasksByColumn.get(col.id) ?? []) {
        ids.push(task.id);
      }
    }
    return ids;
  }, [columns, tasksByColumn]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ------------------------------------------------------------------
  // Optimistic mutation helpers
  // ------------------------------------------------------------------

  const stageOptimistic = useCallback((taskId: string, fields: Partial<Task>) => {
    setOptimistic((prev) => [...prev, { taskId, fields }]);
  }, []);

  const clearOptimistic = useCallback((taskId: string) => {
    setOptimistic((prev) => prev.filter((p) => p.taskId !== taskId));
  }, []);

  const persistStatus = useCallback(
    async (taskId: string, status: TaskStatus, prevStatus: TaskStatus) => {
      stageOptimistic(taskId, { status });
      const updated = await updateTask(sessionName, taskId, { status });
      if (!updated) {
        // Roll back: keep an inverse patch until next prop refresh wipes everything.
        stageOptimistic(taskId, { status: prevStatus });
        push({
          kind: "error",
          title: "Failed to update task status",
          body: taskId,
          scope: { project: sessionName },
        });
        return false;
      }
      // Once successful, drop our optimistic patch — the next snapshot will carry
      // the canonical value.
      clearOptimistic(taskId);
      return true;
    },
    [sessionName, push, stageOptimistic, clearOptimistic],
  );

  // ------------------------------------------------------------------
  // Drag handlers
  // ------------------------------------------------------------------

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDragId(null);
    if (!over) return;

    const taskId = String(active.id);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const overData = over.data.current as { type?: string; columnId?: string; status?: TaskStatus } | undefined;
    let targetColumnId: string | null = null;
    if (overData?.type === "column" && overData.columnId) {
      targetColumnId = overData.columnId;
    } else if (overData?.type === "task") {
      const overTaskId = String(over.id);
      const overTask = tasks.find((t) => t.id === overTaskId);
      if (overTask) targetColumnId = columnIdForTask(overTask, groupBy);
    } else {
      // Default — the over.id might already be a column id.
      const colMatch = columns.find((c) => c.id === String(over.id));
      if (colMatch) targetColumnId = colMatch.id;
    }
    if (!targetColumnId) return;
    const sourceColumnId = columnIdForTask(task, groupBy);
    if (sourceColumnId === targetColumnId) return;

    if (groupBy === "status") {
      const targetCol = columns.find((c) => c.id === targetColumnId);
      const newStatus = targetCol?.status;
      if (!newStatus) return;
      await persistStatus(taskId, newStatus, task.status);
    } else if (groupBy === "milestone") {
      const newMilestone = targetColumnId === "__no-milestone" ? null : targetColumnId;
      stageOptimistic(taskId, { milestone: newMilestone });
      const updated = await updateTask(sessionName, taskId, {});
      // The API doesn't currently expose milestone updates from the dashboard;
      // surface a toast and roll back if the request returned null.
      if (!updated) {
        stageOptimistic(taskId, { milestone: task.milestone });
        push({ kind: "info", title: "Cannot reassign milestone here", body: taskId });
      } else {
        clearOptimistic(taskId);
      }
    } else if (groupBy === "agent") {
      const newAssignee = targetColumnId === "__unassigned" ? null : targetColumnId;
      stageOptimistic(taskId, { assignee: newAssignee });
      const updated = await updateTask(sessionName, taskId, {
        assignee: newAssignee ?? undefined,
      });
      if (!updated) {
        stageOptimistic(taskId, { assignee: task.assignee });
        push({ kind: "error", title: "Failed to reassign", body: taskId });
      } else {
        clearOptimistic(taskId);
      }
    } else if (groupBy === "priority") {
      const map: Record<string, number> = { p1: 1, p2: 2, p3: 3, p4: 4 };
      const newPriority = map[targetColumnId] ?? task.priority;
      stageOptimistic(taskId, { priority: newPriority });
      const updated = await updateTask(sessionName, taskId, { priority: newPriority });
      if (!updated) {
        stageOptimistic(taskId, { priority: task.priority });
        push({ kind: "error", title: "Failed to set priority", body: taskId });
      } else {
        clearOptimistic(taskId);
      }
    }
  }

  // ------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------

  const handleSelectTask = useCallback(
    (taskId: string, event: MouseEvent | KeyboardEvent) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (event.shiftKey && prev.size > 0) {
          // Range select: from the last selected to this one within flatVisibleIds.
          const last = [...prev].pop();
          if (last) {
            const a = flatVisibleIds.indexOf(last);
            const b = flatVisibleIds.indexOf(taskId);
            if (a >= 0 && b >= 0) {
              const [from, to] = a < b ? [a, b] : [b, a];
              for (let i = from; i <= to; i++) next.add(flatVisibleIds[i]!);
              return next;
            }
          }
        }
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        return next;
      });
    },
    [flatVisibleIds],
  );

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkSetStatus = useCallback(
    async (status: TaskStatus) => {
      const ids = [...selectedIds];
      for (const id of ids) {
        const task = tasks.find((t) => t.id === id);
        if (task) await persistStatus(id, status, task.status);
      }
      clearSelection();
    },
    [selectedIds, tasks, persistStatus, clearSelection],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    for (const id of ids) {
      const ok = await deleteTaskApi(sessionName, id);
      if (!ok) push({ kind: "error", title: "Failed to delete", body: id });
    }
    clearSelection();
  }, [selectedIds, sessionName, push, clearSelection]);

  // ------------------------------------------------------------------
  // Keyboard navigation
  // ------------------------------------------------------------------

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.target && (event.target as HTMLElement).tagName === "INPUT") return;
      if (event.target && (event.target as HTMLElement).tagName === "TEXTAREA") return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(new Set(flatVisibleIds));
        return;
      }
      if (event.key === "Escape") {
        if (openTaskId) {
          setOpenTaskId(null);
        } else if (selectedIds.size > 0) {
          clearSelection();
        }
        return;
      }
      if (!flatVisibleIds.length) return;
      const focusId = focusTaskRef.current ?? [...selectedIds].pop() ?? flatVisibleIds[0]!;
      const idx = flatVisibleIds.indexOf(focusId);
      if (event.key === "j") {
        event.preventDefault();
        const next = flatVisibleIds[Math.min(idx + 1, flatVisibleIds.length - 1)];
        if (next) {
          focusTaskRef.current = next;
          setSelectedIds(new Set([next]));
        }
      } else if (event.key === "k") {
        event.preventDefault();
        const prev = flatVisibleIds[Math.max(idx - 1, 0)];
        if (prev) {
          focusTaskRef.current = prev;
          setSelectedIds(new Set([prev]));
        }
      } else if (event.key === "Enter") {
        if (focusId && flatVisibleIds.includes(focusId)) {
          event.preventDefault();
          setOpenTaskId(focusId);
        }
      } else if (event.key === "x") {
        if (focusId && flatVisibleIds.includes(focusId)) {
          event.preventDefault();
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(focusId)) next.delete(focusId);
            else next.add(focusId);
            return next;
          });
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flatVisibleIds, openTaskId, selectedIds, clearSelection]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const activeTask = activeDragId ? tasks.find((t) => t.id === activeDragId) ?? null : null;
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) ?? null : null;

  // Reset selection / open when a missing task disappears (eg deleted).
  useEffect(() => {
    if (openTaskId && !tasksProp.some((t) => t.id === openTaskId)) setOpenTaskId(null);
    if (selectedIds.size > 0) {
      const next = new Set([...selectedIds].filter((id) => tasksProp.some((t) => t.id === id)));
      if (next.size !== selectedIds.size) setSelectedIds(next);
    }
  }, [tasksProp, openTaskId, selectedIds]);

  const headerActions = (
    <>
      <GroupByToggle value={groupBy} onChange={setGroupBy} />
      <DensityToggle value={density} onChange={setDensity} />
      <Button
        size="sm"
        variant="default"
        data-testid="kanban-add-task"
        onClick={() => setCreateOpen(true)}
      >
        <Plus aria-hidden="true" size={13} />
        New task
      </Button>
    </>
  );

  return (
    <Panel testId="kanban-view">
      <PanelHeader title="Kanban" actions={headerActions} />
      <PanelBody scrollable={false}>
        <FilterBar
          tasks={tasks}
          agents={agents}
          filters={filters}
          onChange={(f: KanbanFilters) => setFilters(f)}
          onClear={clearFilters}
          hasActiveFilters={hasActiveFilters}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div
            data-testid="kanban-columns"
            className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-3"
          >
            <AnimatePresence initial={false}>
              {columns.map((col) => (
                <KanbanColumn
                  key={col.id}
                  column={col}
                  tasks={tasksByColumn.get(col.id) ?? []}
                  allTasks={tasks}
                  density={density}
                  selectedIds={selectedIds}
                  onOpenTask={(id) => setOpenTaskId(id)}
                  onSelectTask={handleSelectTask}
                  onStatusChange={(taskId, status) => {
                    const task = tasks.find((t) => t.id === taskId);
                    if (task) void persistStatus(taskId, status, task.status);
                  }}
                  onAddTask={
                    groupBy === "status" && col.id === "todo"
                      ? () => setCreateOpen(true)
                      : undefined
                  }
                />
              ))}
            </AnimatePresence>
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTask && (
              <TaskCard
                task={activeTask}
                density={density}
                selected={false}
                blocked={isBlocked(activeTask, tasks)}
                overlay
              />
            )}
          </DragOverlay>
        </DndContext>
      </PanelBody>

      <BulkActionsBar
        count={selectedIds.size}
        onClear={clearSelection}
        onSetStatus={(s) => void handleBulkSetStatus(s)}
        onDelete={() => void handleBulkDelete()}
      />

      <TaskDetailPanel
        open={!!openTask}
        task={openTask}
        sessionName={sessionName}
        agents={agents}
        goals={goals}
        events={events}
        allTasks={tasks}
        onOpenChange={(open) => {
          if (!open) setOpenTaskId(null);
        }}
      />

      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sessionName={sessionName}
        goals={goals}
      />

      <NavigatorPortal>
        <KanbanNavigator
          tasks={tasks}
          filters={filters}
          onChangeFilters={(f) => setFilters(f)}
          groupBy={groupBy}
          onChangeGroupBy={(g: GroupBy) => setGroupBy(g)}
          hasActiveFilters={hasActiveFilters}
          onClearFilters={clearFilters}
        />
      </NavigatorPortal>
    </Panel>
  );
}
