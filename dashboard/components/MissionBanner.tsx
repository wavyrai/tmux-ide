import { ProgressBar } from "./ProgressBar";

interface MissionBannerProps {
  sessionName: string;
  mission: { title: string; description: string } | null;
  totalTasks: number;
  doneTasks: number;
  activeAgents: number;
  totalAgents: number;
}

export function MissionBanner({
  sessionName,
  mission,
  totalTasks,
  doneTasks,
  activeAgents,
  totalAgents,
}: MissionBannerProps) {
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return (
    <div className="border-b pb-4 mb-4">
      <div className="flex items-start justify-between mb-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-medium text-[var(--fg)]">{sessionName}</h1>
          {mission ? (
            <p className="text-[var(--dim)] mt-0.5">{mission.title}</p>
          ) : (
            <p className="text-[var(--dim)] mt-0.5">No mission set</p>
          )}
        </div>
        <div className="flex gap-4 shrink-0 ml-4 text-[var(--dim)]">
          <span>
            {doneTasks}/{totalTasks} tasks
          </span>
          <span>
            {activeAgents}/{totalAgents} agents
          </span>
          <span className="text-[var(--accent)]">{pct}%</span>
        </div>
      </div>
      <ProgressBar percent={pct} />
    </div>
  );
}
