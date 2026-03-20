"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchProject } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { MissionBanner } from "@/components/MissionBanner";
import { GoalSection } from "@/components/GoalSection";
import { AgentCard } from "@/components/AgentCard";
import { TaskRow } from "@/components/TaskRow";
import { ActivityFeed } from "@/components/ActivityFeed";
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
  const { data: project, error } = usePolling<ProjectDetail | null>(fetcher, 2000);

  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  const allTasks = useMemo(() => {
    if (!project) return [];
    const order: Record<string, number> = {
      "in-progress": 0,
      todo: 1,
      review: 2,
      done: 3,
    };
    return [...project.tasks].sort((a, b) => {
      const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      return d !== 0 ? d : a.priority - b.priority;
    });
  }, [project]);

  // Keyboard navigation
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      switch (e.key) {
        case "Escape":
          router.push("/");
          e.preventDefault();
          break;
        case "j":
        case "ArrowDown":
          setSelectedIdx((i) => Math.min(allTasks.length - 1, i + 1));
          e.preventDefault();
          break;
        case "k":
        case "ArrowUp":
          setSelectedIdx((i) => Math.max(-1, i - 1));
          e.preventDefault();
          break;
        case "Enter":
          if (selectedIdx >= 0 && selectedIdx < allTasks.length) {
            const id = allTasks[selectedIdx]!.id;
            setExpandedTaskId((prev) => (prev === id ? null : id));
            e.preventDefault();
          }
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allTasks, selectedIdx, router]);

  if (error) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-center text-[var(--red)] py-20">
          Failed to load project
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-center text-[var(--dim)] py-20">Loading…</div>
      </main>
    );
  }

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const ungroupedTasks = allTasks.filter(
    (t) => !t.goal || !project.goals.some((g) => g.id === t.goal),
  );

  return (
    <>
      <main className="max-w-4xl mx-auto px-6 py-4 pb-10">
        {/* Back — also Esc */}
        <button
          onClick={() => router.push("/")}
          className="text-[var(--dim)] hover:text-[var(--fg)] transition-colors mb-4"
        >
          ← back
        </button>

        <MissionBanner
          sessionName={project.session}
          mission={project.mission}
          totalTasks={project.tasks.length}
          doneTasks={doneTasks}
          activeAgents={project.agents.filter((a) => a.isBusy).length}
          totalAgents={project.agents.length}
        />

        <div className="grid grid-cols-[280px_1fr] gap-6">
          {/* Left: agents + activity */}
          <div className="space-y-4 min-w-0">
            {project.agents.length > 0 && (
              <section>
                <h3 className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                  Agents
                </h3>
                {project.agents.map((a, i) => (
                  <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
                ))}
              </section>
            )}

            <section>
              <h3 className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                Activity
              </h3>
              <ActivityFeed tasks={project.tasks} />
            </section>
          </div>

          {/* Right: goals + tasks */}
          <div className="min-w-0">
            {project.goals.length > 0 && (
              <div className="mb-3">
                <h3 className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                  Goals
                </h3>
                {project.goals.map((g) => {
                  const goalTasks = allTasks.filter((t) => t.goal === g.id);
                  return (
                    <GoalSection
                      key={g.id}
                      goal={g}
                      tasks={goalTasks}
                      selectedTaskId={expandedTaskId}
                      onSelectTask={setExpandedTaskId}
                    />
                  );
                })}
              </div>
            )}

            {ungroupedTasks.length > 0 && (
              <div>
                <h3 className="text-[var(--dim)] text-[10px] uppercase tracking-wider mb-1">
                  {project.goals.length > 0 ? "Other Tasks" : "Tasks"}
                </h3>
                {ungroupedTasks.map((t) => {
                  const absIdx = allTasks.indexOf(t);
                  return (
                    <TaskRow
                      key={t.id}
                      task={t}
                      selected={absIdx === selectedIdx || expandedTaskId === t.id}
                      onSelect={() =>
                        setExpandedTaskId(expandedTaskId === t.id ? null : t.id)
                      }
                    />
                  );
                })}
              </div>
            )}

            {allTasks.length === 0 && (
              <div className="text-[var(--dim)] py-8 text-center">No tasks</div>
            )}
          </div>
        </div>

        <div className="text-[10px] text-[var(--dim)] mt-6 text-center">
          j/k navigate · enter expand · esc back
        </div>
      </main>

      <StatusBar project={project} />
    </>
  );
}
