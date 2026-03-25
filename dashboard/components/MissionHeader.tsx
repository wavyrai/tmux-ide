import { ProgressBar } from "./ProgressBar";
import type { Goal, Task } from "@/lib/types";

interface MissionHeaderProps {
  sessionName: string;
  mission: { title: string; description: string } | null;
  goals: Goal[];
  tasks: Task[];
}

export function MissionHeader({ sessionName, mission, goals, tasks }: MissionHeaderProps) {
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <div className="border-b py-3 px-4 bg-[var(--surface)]">
      {/* Top row: mission + progress */}
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <span className="text-[var(--fg)] font-medium">{sessionName}</span>
          {mission && <span className="text-[var(--dim)] ml-2">— {mission.title}</span>}
          {mission?.description && (
            <span className="text-[var(--dim)] ml-1 opacity-60">({mission.description})</span>
          )}
        </div>
        <ProgressBar percent={pct} width={16} />
      </div>

      {/* Goal pills */}
      {goals.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {goals.map((g) => {
            const goalTasks = tasks.filter((t) => t.goal === g.id);
            const goalDone = goalTasks.filter((t) => t.status === "done").length;
            const goalPct =
              goalTasks.length > 0 ? Math.round((goalDone / goalTasks.length) * 100) : 0;
            const color =
              goalPct === 100 ? "var(--green)" : goalPct > 0 ? "var(--accent)" : "var(--dim)";

            return (
              <span
                key={g.id}
                className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 border rounded"
                style={{ borderColor: color, color }}
              >
                {g.title}
                <span className="opacity-60">{goalPct}%</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
