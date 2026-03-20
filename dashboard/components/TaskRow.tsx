import type { Task } from "@/lib/types";

interface TaskRowProps {
  task: Task;
}

const STATUS_COLORS: Record<Task["status"], string> = {
  "in-progress": "bg-[#e8c95a]",
  todo: "bg-[#6b6363]",
  review: "bg-[#7db4e8]",
  done: "bg-[#7dd87d]",
};

const STATUS_LABELS: Record<Task["status"], string> = {
  "in-progress": "DOING",
  todo: "TODO",
  review: "REVIEW",
  done: "DONE",
};

export function TaskRow({ task: t }: TaskRowProps) {
  return (
    <div className="flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-[#1f1c1c] transition-colors">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[t.status]}`}
      />
      <span className="text-xs text-[#6b6363] w-8">{t.id}</span>
      <span className="text-sm text-[#e8e4e4] flex-1 truncate">{t.title}</span>
      {t.assignee && (
        <span className="text-xs text-[#a09a9a]">@{t.assignee}</span>
      )}
      <span className="text-xs text-[#6b6363]">{STATUS_LABELS[t.status]}</span>
    </div>
  );
}
