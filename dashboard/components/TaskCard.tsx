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

  const testsPass = t.proof?.tests && t.proof.tests.passed === t.proof.tests.total;

  return (
    <div
      onClick={onClick}
      className={`cursor-pointer px-2 py-1.5 mb-px transition-colors ${
        selected
          ? "bg-[var(--surface-active)]"
          : "bg-[var(--surface)] hover:bg-[var(--surface-hover)]"
      }`}
      style={{ borderLeft: `2px solid ${selected ? "var(--accent)" : borderColor}` }}
    >
      <div className="flex items-center gap-1.5">
        <span style={{ color: prio.color }} className="shrink-0 text-[11px]">
          {prio.text}
        </span>
        <span className="text-[var(--dim)] shrink-0">{t.id}</span>
        <span className="flex-1" />
        {/* Badges */}
        {testsPass && (
          <span
            className="text-[var(--green)] text-[10px]"
            title={`${t.proof!.tests!.passed}/${t.proof!.tests!.total} tests`}
          >
            ✓
          </span>
        )}
        {t.proof?.pr && (
          <span className="text-[var(--cyan)] text-[10px]">PR#{t.proof.pr.number}</span>
        )}
        {t.depends_on?.length > 0 && (
          <span
            className="text-[var(--dim)] text-[10px]"
            title={`depends: ${t.depends_on.join(", ")}`}
          >
            ⇅{t.depends_on.length}
          </span>
        )}
      </div>
      <div className="truncate text-[var(--fg)] mt-0.5">{t.title}</div>
      {t.assignee && (
        <div className="text-[var(--cyan)] mt-0.5 truncate text-[11px]">@{t.assignee}</div>
      )}
    </div>
  );
}
