"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
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
import { useLayoutState, type WorkspaceTab } from "@/lib/useLayoutState";

function hrefForWorkspaceTab(tab: WorkspaceTab | null | undefined): string {
  if (!tab || tab.kind === "settings" || tab.kind === "notifications" || !tab.projectName) {
    return "/";
  }
  return `/project/${encodeURIComponent(tab.projectName)}`;
}

function activityForTab(tab: WorkspaceTab | null | undefined): "sessions" | "settings" {
  return tab?.kind === "settings" ? "settings" : "sessions";
}

export function WorkspaceTabsBar() {
  const router = useRouter();
  const {
    workspaceTabs,
    activeWorkspaceTabId,
    setActiveWorkspaceTab,
    closeWorkspaceTab,
    reorderWorkspaceTabs,
    setActivitySection,
  } = useLayoutState();

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const tabIds = useMemo(() => workspaceTabs.map((tab) => tab.id), [workspaceTabs]);

  function activate(id: string) {
    const tab = workspaceTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setActiveWorkspaceTab(id);
    setActivitySection(activityForTab(tab));
    router.push(hrefForWorkspaceTab(tab));
  }

  function close(id: string) {
    const index = workspaceTabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const remaining = workspaceTabs.filter((tab) => tab.id !== id);
    const nextTab = remaining[index - 1] ?? remaining[index] ?? null;
    const closingActive = activeWorkspaceTabId === id;
    closeWorkspaceTab(id);

    if (closingActive) {
      if (nextTab) setActivitySection(activityForTab(nextTab));
      router.push(hrefForWorkspaceTab(nextTab));
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
