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
          <Link
            href="/"
            className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors"
          >
            {"< esc"}
          </Link>
          <span className="text-[var(--border)]">│</span>
          <span className="text-[var(--accent)]">{project.session}</span>
        </div>
        <div className="flex items-center gap-4 text-[var(--dim)]">
          <span>
            <span className="text-[var(--green)]">{activeAgents}</span>/{project.agents.length} agents
          </span>
          <span>
            <span className="text-[var(--green)]">{doneTasks}</span>/{totalTasks} tasks
          </span>
          <ProgressBar percent={pct} width={10} />
        </div>
      </div>

      {/* Mission banner */}
      {project.mission && (
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="text-[var(--fg)]">{project.mission.title}</div>
          {project.mission.description && (
            <div className="text-[var(--dim)]">{project.mission.description}</div>
          )}
        </div>
      )}

      {/* Main content: 2-pane layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left pane: Goals + Agents */}
        <div className="w-[40%] shrink-0 border-r border-[var(--border)] flex flex-col min-h-0">
          {/* Goals section */}
          {project.goals.length > 0 && (
            <div className="border-b border-[var(--border)]">
              <div className="px-4 h-6 flex items-center bg-[var(--surface)] text-[var(--dim)] border-b border-[var(--border)]">
                goals
              </div>
              <div className="p-2">
                {project.goals.map((g) => {
                  const goalTasks = project.tasks.filter(
                    (t) => t.goal === g.id,
                  );
                  const goalDone = goalTasks.filter(
                    (t) => t.status === "done",
                  ).length;
                  const goalPct =
                    goalTasks.length > 0
                      ? Math.round((goalDone / goalTasks.length) * 100)
                      : 0;
                  return (
                    <div
                      key={g.id}
                      className="flex items-center h-6 px-2 hover:bg-[rgba(255,255,255,0.02)]"
                    >
                      <span className="flex-1 truncate text-[var(--fg)]">
                        {g.title}
                      </span>
                      <span className="shrink-0">
                        <ProgressBar percent={goalPct} width={6} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Agents section */}
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="px-4 h-6 flex items-center bg-[var(--surface)] text-[var(--dim)] border-b border-[var(--border)]">
              agents
            </div>
            <div className="flex-1 overflow-auto p-2">
              {project.agents.length === 0 ? (
                <div className="px-2 text-[var(--dim)]">no agents</div>
              ) : (
                project.agents.map((a, i) => (
                  <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right pane: Tasks */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 h-6 flex items-center bg-[var(--surface)] text-[var(--dim)] border-b border-[var(--border)]">
            tasks
          </div>
          {/* Task column headers */}
          <div className="flex items-center h-6 px-2 text-[var(--dim)] border-b border-[var(--border)]">
            <span className="w-3" />
            <span className="w-[4ch]">id</span>
            <span className="w-[7ch]">status</span>
            <span className="flex-1">title</span>
            <span className="shrink-0 pl-2">assignee</span>
          </div>
          <div className="flex-1 overflow-auto">
            {project.tasks.length === 0 ? (
              <div className="px-4 py-2 text-[var(--dim)]">no tasks</div>
            ) : (
              project.tasks.map((t) => <TaskRow key={t.id} task={t} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
