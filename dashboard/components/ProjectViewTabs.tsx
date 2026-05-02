"use client";

export type ProjectTab =
  | "kanban"
  | "agents"
  | "diffs"
  | "plans"
  | "validation"
  | "metrics"
  | "activity";

export const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: "kanban", label: "kanban" },
  { id: "agents", label: "agents" },
  { id: "diffs", label: "diffs" },
  { id: "plans", label: "plans" },
  { id: "validation", label: "validation" },
  { id: "metrics", label: "metrics" },
  { id: "activity", label: "activity" },
];

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
