import type { Task } from "@/lib/types";

interface TaskRowProps {
  task: Task;
  selected?: boolean;
  onSelect?: () => void;
}

const STATUS_COLORS: Record<Task["status"], string> = {
  "in-progress": "var(--yellow)",
  todo: "var(--dim)",
  review: "var(--magenta)",
  done: "var(--green)",
};

const STATUS_LABELS: Record<Task["status"], string> = {
  "in-progress": "DOING",
  todo: "TODO",
  review: "REVIEW",
  done: "DONE",
};

export function TaskRow({ task: t, selected = false, onSelect }: TaskRowProps) {
  const bg = selected ? "bg-[var(--surface-active)]" : "hover:bg-[var(--surface-hover)]";

  return (
    <div>
      <div className={`flex items-center h-6 px-2 cursor-pointer ${bg}`} onClick={onSelect}>
        <span className="w-3 shrink-0" style={{ color: STATUS_COLORS[t.status] }}>
          ●
        </span>
        <span className="w-[4ch] shrink-0 text-[var(--dim)]">{t.id}</span>
        <span className="w-[7ch] shrink-0" style={{ color: STATUS_COLORS[t.status] }}>
          {STATUS_LABELS[t.status]}
        </span>
        <span className="flex-1 truncate text-[var(--fg)]">{t.title}</span>
        {t.assignee && <span className="shrink-0 pl-2 text-[var(--cyan)]">@{t.assignee}</span>}
      </div>
      {selected && (
        <div className="pl-[14ch] py-1 space-y-0.5 text-[var(--dim)]">
          {t.description && <div className="text-[var(--fg)]">{t.description}</div>}
          <div className="flex gap-3">
            <span>P{t.priority}</span>
            {t.branch && <span>⎇ {t.branch}</span>}
            {t.tags.length > 0 && <span>{t.tags.join(", ")}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
