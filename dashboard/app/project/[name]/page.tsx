"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchProject } from "@/lib/api";
import { ProgressBar } from "@/components/ProgressBar";
import { AgentCard } from "@/components/AgentCard";
import { TaskRow } from "@/components/TaskRow";
import type { ProjectDetail } from "@/lib/types";

export default function ProjectPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const data = await fetchProject(name);
        if (active) {
          setProject(data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [name]);

  if (error) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-center text-[#e87d7d] py-20">
          Failed to load project
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-center text-[#6b6363] py-20">Loading...</div>
      </main>
    );
  }

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const pct =
    project.tasks.length > 0
      ? Math.round((doneTasks / project.tasks.length) * 100)
      : 0;

  return (
    <main className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      {/* Back */}
      <Link
        href="/"
        className="text-sm text-[#a09a9a] hover:text-[#e8e4e4] transition-colors"
      >
        &larr; All projects
      </Link>

      {/* Mission header */}
      <div className="bg-[#1a1717] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-medium text-[#e8e4e4]">
              {project.session}
            </h1>
            {project.mission && (
              <p className="text-sm text-[#a09a9a] mt-1">
                {project.mission.title}
              </p>
            )}
          </div>
          <div className="flex gap-4">
            <div className="text-center">
              <div className="text-2xl font-medium">{project.tasks.length}</div>
              <div className="text-xs text-[#6b6363]">tasks</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-medium">
                {project.agents.filter((a) => a.isBusy).length}
              </div>
              <div className="text-xs text-[#6b6363]">active</div>
            </div>
          </div>
        </div>
        <ProgressBar percent={pct} />
      </div>

      {/* Goals */}
      {project.goals.length > 0 && (
        <div className="bg-[#1a1717] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
          <h3 className="text-sm font-medium text-[#a09a9a] mb-3">Goals</h3>
          <div className="space-y-3">
            {project.goals.map((g) => {
              const goalTasks = project.tasks.filter((t) => t.goal === g.id);
              const goalDone = goalTasks.filter(
                (t) => t.status === "done",
              ).length;
              const goalPct =
                goalTasks.length > 0
                  ? Math.round((goalDone / goalTasks.length) * 100)
                  : 0;
              return (
                <div key={g.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-[#e8e4e4]">{g.title}</span>
                    <span className="text-xs text-[#6b6363]">{goalPct}%</span>
                  </div>
                  <ProgressBar percent={goalPct} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Agents */}
      {project.agents.length > 0 && (
        <div className="bg-[#1a1717] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
          <h3 className="text-sm font-medium text-[#a09a9a] mb-3">Agents</h3>
          <div className="space-y-1">
            {project.agents.map((a) => (
              <AgentCard key={a.paneTitle} agent={a} />
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      <div className="bg-[#1a1717] border border-[rgba(255,255,255,0.06)] rounded-xl p-5">
        <h3 className="text-sm font-medium text-[#a09a9a] mb-3">Tasks</h3>
        {project.tasks.length === 0 ? (
          <p className="text-sm text-[#6b6363]">No tasks</p>
        ) : (
          <div className="space-y-0.5">
            {project.tasks.map((t) => (
              <TaskRow key={t.id} task={t} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
