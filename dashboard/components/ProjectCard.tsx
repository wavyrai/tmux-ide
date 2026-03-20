"use client";

import Link from "next/link";
import type { SessionOverview } from "@/lib/types";
import { ProgressBar } from "./ProgressBar";

interface ProjectCardProps {
  session: SessionOverview;
}

export function ProjectCard({ session: s }: ProjectCardProps) {
  const pct =
    s.stats.totalTasks > 0
      ? Math.round((s.stats.doneTasks / s.stats.totalTasks) * 100)
      : 0;

  return (
    <Link href={`/project/${encodeURIComponent(s.name)}`}>
      <div className="bg-[#1a1717] border border-[rgba(255,255,255,0.06)] rounded-xl p-5 cursor-pointer hover:border-[rgba(255,255,255,0.1)] transition-all">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-medium text-[#e8e4e4]">{s.name}</h2>
            {s.mission ? (
              <p className="text-sm text-[#a09a9a] mt-0.5">
                {s.mission.title}
              </p>
            ) : (
              <p className="text-sm text-[#6b6363] mt-0.5">No mission set</p>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-2xl font-medium text-[#e8e4e4]">
                {s.stats.doneTasks}
                <span className="text-[#6b6363] text-sm font-normal">
                  /{s.stats.totalTasks}
                </span>
              </div>
              <div className="text-xs text-[#6b6363]">tasks</div>
            </div>
            <div className="text-right">
              <div className="text-2xl font-medium text-[#e8e4e4]">
                {s.stats.agents}
              </div>
              <div className="text-xs text-[#6b6363]">agents</div>
            </div>
          </div>
        </div>

        {/* Progress */}
        <ProgressBar percent={pct} className="mb-4" />

        {/* Goals */}
        {s.goals.length > 0 && (
          <div className="space-y-2 pt-3 border-t border-[rgba(255,255,255,0.06)]">
            {s.goals.map((g) => (
              <div key={g.id} className="flex items-center gap-3">
                <span className="text-sm text-[#a09a9a] flex-1 truncate">
                  {g.title}
                </span>
                <ProgressBar percent={g.progress} className="w-24" />
                <span className="text-xs text-[#6b6363] w-8 text-right">
                  {g.progress}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
