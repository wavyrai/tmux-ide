"use client";

import { useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchProject } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";
import { AgentCard } from "@/components/AgentCard";
import { KanbanBoard } from "@/components/KanbanBoard";
import { StatusBar } from "@/components/StatusBar";
import type { ProjectDetail } from "@/lib/types";

export default function ProjectPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = decodeURIComponent(params.name);

  const fetcher = useCallback(
    () => fetchProject(name) as Promise<ProjectDetail | null>,
    [name],
  );
  const { data: project, error, stale, lastUpdate, refresh } = usePolling<ProjectDetail | null>(fetcher, 2000);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--red)]">
        failed to load project
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--dim)]">
        loading...
      </div>
    );
  }

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const totalTasks = project.tasks.length;
  const pct = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;
  const activeAgents = project.agents.filter((a) => a.isBusy).length;

  return (
    <div className="h-screen flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 h-7 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            {"< esc"}
          </button>
          <span className="text-[var(--border)]">│</span>
          <span className="text-[var(--accent)]">{project.session}</span>
          {project.mission && (
            <>
              <span className="text-[var(--border)]">│</span>
              <span className="text-[var(--dim)] truncate">
                {project.mission.title}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4 text-[var(--dim)]">
          <span>
            <span className="text-[var(--green)]">{activeAgents}</span>
            /{project.agents.length} agents
          </span>
          <span>
            <span className="text-[var(--green)]">{doneTasks}</span>
            /{totalTasks} tasks
          </span>
          <ProgressBar percent={pct} width={10} />
        </div>
      </div>

      {/* Agents bar (if any) */}
      {project.agents.length > 0 && (
        <div className="flex items-center px-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.agents.map((a, i) => (
            <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
          ))}
        </div>
      )}

      {/* Goals bar (if any) */}
      {project.goals.length > 0 && (
        <div className="flex items-center gap-4 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.goals.map((g) => {
            const goalTasks = project.tasks.filter((t) => t.goal === g.id);
            const goalDone = goalTasks.filter((t) => t.status === "done").length;
            const goalPct =
              goalTasks.length > 0
                ? Math.round((goalDone / goalTasks.length) * 100)
                : 0;
            return (
              <span key={g.id} className="flex items-center gap-1.5 shrink-0">
                <span className="text-[var(--fg)] truncate max-w-[20ch]">{g.title}</span>
                <ProgressBar percent={goalPct} width={4} />
              </span>
            );
          })}
        </div>
      )}

      {/* Kanban board */}
      <KanbanBoard
        tasks={project.tasks}
        sessionName={project.session}
        agents={project.agents}
        onRefresh={refresh}
      />

      <StatusBar project={project} lastUpdate={lastUpdate} stale={stale} />
    </div>
  );
}
