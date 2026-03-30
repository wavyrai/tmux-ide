"use client";

import Link from "next/link";
import type { SessionOverview } from "@/lib/types";
import { ProgressBar } from "./ProgressBar";

interface ProjectRowProps {
  session: SessionOverview;
}

export function ProjectRow({ session: s }: ProjectRowProps) {
  const pct =
    s.stats.totalTasks > 0 ? Math.round((s.stats.doneTasks / s.stats.totalTasks) * 100) : 0;

  const missionText = s.mission?.title ?? "—";

  return (
    <Link href={`/project/${encodeURIComponent(s.name)}`}>
      <div className="flex items-center px-4 h-7 hover:bg-[var(--surface)] cursor-pointer border-b border-[var(--border)] transition-colors">
        <span className="w-3 shrink-0">
          <span
            className={`inline-block w-[6px] h-[6px] ${
              s.stats.activeAgents > 0 ? "bg-[var(--green)]" : "bg-[var(--dim)]"
            }`}
          />
        </span>
        <span className="w-[20ch] shrink-0 text-[var(--fg)] truncate">{s.name}</span>
        <span className="flex-1 text-[var(--dim)] truncate pr-4">{missionText}</span>
        <span className="w-[14ch] text-right shrink-0">
          <ProgressBar percent={pct} width={8} />
        </span>
        <span className="w-[8ch] text-right shrink-0 text-[var(--dim)]">
          {s.stats.activeAgents}/{s.stats.agents}
        </span>
        <span className="w-[10ch] text-right shrink-0">
          <span className="text-[var(--green)]">{s.stats.doneTasks}</span>
          <span className="text-[var(--dim)]">/{s.stats.totalTasks}</span>
        </span>
      </div>
    </Link>
  );
}
