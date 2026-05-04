"use client";

import { useSecondaryTabsSlot } from "@/lib/useSecondaryTabsSlot";

/**
 * Full-width slot that spans across the navigator + content area, sitting
 * directly under the WorkspaceTabsBar. Project-style sub-tabs (kanban /
 * mission / diffs / etc.) portal in here via SecondaryTabsPortal so they
 * read as a single coherent header strip — not a column-bound widget that
 * collides with the navigator's own header.
 *
 * Renders nothing when no view has registered.
 */
export function SecondaryTabsSlot() {
  const node = useSecondaryTabsSlot();
  if (!node) return null;
  return (
    <div data-testid="secondary-tabs-slot" className="shrink-0">
      {node}
    </div>
  );
}
