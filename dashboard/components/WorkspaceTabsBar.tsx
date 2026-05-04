"use client";

import { useMemo } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { WorkspaceTabItem } from "@/components/WorkspaceTabItem";
import { setNavigation, type NavigationState } from "@/lib/navigation";
import { useLayoutState, type WorkspaceTab } from "@/lib/useLayoutState";

/**
 * Translate a workspace tab back into a NavigationState. Workspace tabs
 * are an in-memory cache of recently opened views; activating one is
 * equivalent to dispatching the corresponding `setNavigation(...)`.
 */
function navForTab(tab: WorkspaceTab | null | undefined): NavigationState {
  if (!tab) return { type: "overview" };
  if (tab.kind === "settings") return { type: "settings" };
  if (tab.kind === "notifications") return { type: "overview" };
  if (tab.kind === "skill" && tab.projectName) {
    const next: Extract<NavigationState, { type: "skills" }> = {
      type: "skills",
      sessionName: tab.projectName,
    };
    if (tab.ref) next.skillName = tab.ref;
    return next;
  }
  if (tab.kind === "project" && tab.projectName) {
    return { type: "sessions", sessionName: tab.projectName };
  }
  return { type: "overview" };
}

export function WorkspaceTabsBar() {
  const {
    workspaceTabs,
    activeWorkspaceTabId,
    setActiveWorkspaceTab,
    closeWorkspaceTab,
    reorderWorkspaceTabs,
  } = useLayoutState();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const tabIds = useMemo(() => workspaceTabs.map((tab) => tab.id), [workspaceTabs]);

  function activate(id: string) {
    const tab = workspaceTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setActiveWorkspaceTab(id);
    setNavigation(navForTab(tab));
  }

  function close(id: string) {
    const index = workspaceTabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const remaining = workspaceTabs.filter((tab) => tab.id !== id);
    const nextTab = remaining[index - 1] ?? remaining[index] ?? null;
    const closingActive = activeWorkspaceTabId === id;
    closeWorkspaceTab(id);

    if (closingActive) {
      setNavigation(navForTab(nextTab));
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = tabIds.indexOf(String(active.id));
    const to = tabIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;

    const next = [...tabIds];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    reorderWorkspaceTabs(next);
  }

  if (workspaceTabs.length === 0) return null;

  return (
    <div
      data-testid="workspace-tabs-bar"
      className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-weak)] bg-[var(--surface)]"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div className="flex min-w-0 flex-1 touch-pan-x overflow-x-auto">
            {workspaceTabs.map((tab) => (
              <WorkspaceTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeWorkspaceTabId}
                onActivate={() => activate(tab.id)}
                onClose={() => close(tab.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
