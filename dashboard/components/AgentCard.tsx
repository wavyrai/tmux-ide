import type { AgentDetail } from "@/lib/types";

interface AgentCardProps {
  agent: AgentDetail;
}

export function AgentCard({ agent: a }: AgentCardProps) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${
          a.isBusy ? "bg-[#e8c95a]" : "bg-[#6b6363]"
        }`}
      />
      <span className="text-sm text-[#e8e4e4] flex-1">{a.paneTitle}</span>
      {a.taskTitle ? (
        <span className="text-sm text-[#a09a9a] truncate max-w-48">
          {a.taskTitle}
        </span>
      ) : (
        <span className="text-xs text-[#6b6363]">idle</span>
      )}
      {a.elapsed && (
        <span className="text-xs text-[#6b6363]">{a.elapsed}</span>
      )}
    </div>
  );
}
