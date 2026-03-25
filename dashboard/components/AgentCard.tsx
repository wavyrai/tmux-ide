import type { AgentDetail } from "@/lib/types";

interface AgentCardProps {
  agent: AgentDetail;
}

export function AgentCard({ agent: a }: AgentCardProps) {
  return (
    <div className="flex items-center h-6 px-2 hover:bg-[var(--surface-hover)]">
      <span className="w-3 shrink-0" style={{ color: a.isBusy ? "var(--yellow)" : "var(--dim)" }}>
        {a.isBusy ? "●" : "○"}
      </span>
      <span className="w-[16ch] shrink-0 text-[var(--fg)] truncate">{a.paneTitle}</span>
      <span
        className={`flex-1 truncate ${a.taskTitle ? "text-[var(--fg-secondary)]" : "text-[var(--dim)]"}`}
      >
        {a.taskTitle ?? (a.isBusy ? "working..." : "idle")}
      </span>
      {a.elapsed && <span className="text-[var(--dim)] shrink-0 pl-2">{a.elapsed}</span>}
    </div>
  );
}
