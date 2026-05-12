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
import { Plus } from "lucide-react";
import { openCommandPalette } from "@/components/CommandPalette";
import { MainTabItem } from "./MainTabItem";
import { activateTab, closeTab, reorderTabs, useNavigation } from "@/lib/navigation";

/**
 * MainTabsBar — single unified row of tabs at the top of the main
 * content area. Tabs are heterogeneous (`view` / `file` / `skill` /
 * `settings`) and persist per-session via NavigationState. Drag-to-
 * reorder is handled by @dnd-kit; the "+" button opens the command
 * palette so the user can pick what to open next.
 *
 * Replaces the old WorkspaceTabsBar + ProjectViewTabs pair.
 */
export function MainTabsBar() {
  const { openTabs, activeTabId } = useNavigation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const tabIds = useMemo(() => openTabs.map((tab) => tab.id), [openTabs]);

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
    reorderTabs(next);
  }

  if (openTabs.length === 0) return null;

  return (
    <div
      data-testid="main-tabs-bar"
      className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-weak)] bg-[var(--surface)]"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div className="flex min-w-0 flex-1 touch-pan-x overflow-x-auto">
            {openTabs.map((tab) => (
              <MainTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                onActivate={() => activateTab(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <button
        type="button"
        data-testid="main-tabs-add"
        aria-label="Open command palette"
        title="Open command palette (⌘K)"
        onClick={openCommandPalette}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
      >
        <Plus aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
