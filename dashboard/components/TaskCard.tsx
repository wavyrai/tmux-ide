import type { Task } from "@/lib/types";

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  selected?: boolean;
}

const BORDER_COLORS: Record<Task["status"], string> = {
  "in-progress": "var(--yellow)",
  todo: "var(--dim)",
  review: "var(--magenta)",
  done: "var(--green)",
};

function priorityDots(p: number): { text: string; color: string } {
  switch (p) {
    case 1:
      return { text: "***", color: "var(--red)" };
    case 2:
      return { text: "**", color: "var(--yellow)" };
    default:
      return { text: "*", color: "var(--accent)" };
  }
}

export function TaskCard({ task: t, onClick, selected = false }: TaskCardProps) {
  const prio = priorityDots(t.priority);
  const borderColor = BORDER_COLORS[t.status];

  return (
    <div
      onClick={onClick}
      className={`cursor-pointer px-2 py-1.5 mb-px transition-colors ${
        selected
          ? "bg-[rgba(255,255,255,0.06)]"
          : "bg-[var(--surface)] hover:bg-[rgba(255,255,255,0.03)]"
      }`}
      style={{ borderLeft: `2px solid ${selected ? "var(--accent)" : borderColor}` }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: prio.color }} className="shrink-0 text-[11px]">
          {prio.text}
        </span>
        <span className="text-[var(--dim)] shrink-0">{t.id}</span>
      </div>
      <div className="truncate text-[var(--fg)] mt-0.5">{t.title}</div>
      {t.assignee && (
        <div className="text-[var(--cyan)] mt-0.5 truncate text-[11px]">
          @{t.assignee}
        </div>
      )}
    </div>
  );
}
