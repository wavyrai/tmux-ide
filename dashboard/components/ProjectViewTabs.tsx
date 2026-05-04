"use client";

import { PROJECT_TABS as PROJECT_TAB_IDS, type ProjectTab } from "@/lib/navigation";

export type { ProjectTab };

// Pre-built label list. The shape matches the legacy export so call sites
// consuming `PROJECT_TABS.map(({ id, label }) => ...)` keep working.
export const PROJECT_TABS: { id: ProjectTab; label: string }[] = PROJECT_TAB_IDS.map((id) => ({
  id,
  label: id,
}));

interface ProjectViewTabsProps {
  active: ProjectTab;
  onChange: (tab: ProjectTab) => void;
}

export function ProjectViewTabs({ active, onChange }: ProjectViewTabsProps) {
  return (
    <div
      data-testid="project-view-tabs"
      className="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--surface)]"
    >
      {PROJECT_TABS.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`h-7 px-4 transition-colors ${
            active === tab.id
              ? "border-b-2 border-[var(--accent)] text-[var(--accent)]"
              : "text-[var(--dim)] hover:text-[var(--fg)]"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
