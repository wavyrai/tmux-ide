"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { fetchProject, fetchEvents, type EventData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";
import { AgentCard } from "@/components/AgentCard";
import { KanbanBoard } from "@/components/KanbanBoard";
import { DiffPanel } from "@/components/DiffPanel";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PlansPanel } from "@/components/PlansPanel";
import { StatusBar } from "@/components/StatusBar";
import type { ProjectDetail } from "@/lib/types";

type Tab = "kanban" | "agents" | "diffs" | "plans" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "kanban", label: "kanban" },
  { id: "agents", label: "agents" },
  { id: "diffs", label: "diffs" },
  { id: "plans", label: "plans" },
  { id: "activity", label: "activity" },
];

export default function ProjectPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const name = decodeURIComponent(params.name);
  const [activeTab, setActiveTab] = useState<Tab>("kanban");

  const fetcher = useCallback(() => fetchProject(name) as Promise<ProjectDetail | null>, [name]);
  const {
    data: project,
    error,
    stale,
    lastUpdate,
    refresh,
  } = usePolling<ProjectDetail | null>(fetcher, 2000);

  const eventsFetcher = useCallback(() => fetchEvents(name), [name]);
  const { data: events } = usePolling<EventData[]>(eventsFetcher, 3000);


  if (error) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--red)]">
        failed to load project
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--dim)]">loading...</div>
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
              <span className="text-[var(--dim)] truncate">{project.mission.title}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4 text-[var(--dim)]">
          <span>
            <span className="text-[var(--green)]">{activeAgents}</span>/{project.agents.length}{" "}
            agents
          </span>
          <span>
            <span className="text-[var(--green)]">{doneTasks}</span>/{totalTasks} tasks
          </span>
          <ProgressBar percent={pct} width={10} />
        </div>
      </div>

      {/* Agents bar */}
      {project.agents.length > 0 && (
        <div className="flex items-center px-2 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.agents.map((a, i) => (
            <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
          ))}
        </div>
      )}

      {/* Goals bar */}
      {project.goals.length > 0 && (
        <div className="flex items-center gap-4 px-4 h-6 bg-[var(--surface)] border-b border-[var(--border)] shrink-0 overflow-x-auto">
          {project.goals.map((g) => {
            const goalTasks = project.tasks.filter((t) => t.goal === g.id);
            const goalDone = goalTasks.filter((t) => t.status === "done").length;
            const goalPct =
              goalTasks.length > 0 ? Math.round((goalDone / goalTasks.length) * 100) : 0;
            return (
              <span key={g.id} className="flex items-center gap-1.5 shrink-0">
                <span className="text-[var(--fg)] truncate max-w-[20ch]">{g.title}</span>
                <ProgressBar percent={goalPct} width={4} />
              </span>
            );
          })}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)] bg-[var(--surface)] shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 h-7 transition-colors ${
              activeTab === tab.id
                ? "text-[var(--accent)] border-b-2 border-[var(--accent)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "kanban" && (
        <KanbanBoard
          tasks={project.tasks}
          sessionName={project.session}
          agents={project.agents}
          goals={project.goals}
          onRefresh={refresh}
        />
      )}

      {activeTab === "diffs" && <DiffPanel sessionName={project.session} />}

      {activeTab === "plans" && <PlansPanel sessionName={project.session} />}

      {activeTab === "activity" && <ActivityFeed events={events ?? []} />}

      {activeTab === "agents" && (
        <div className="flex-1 p-4 overflow-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {project.agents.map((a, i) => (
              <AgentCard key={`${a.paneTitle}-${i}`} agent={a} />
            ))}
          </div>
          {project.agents.length === 0 && (
            <div className="flex items-center justify-center h-32 text-[var(--dim)]">
              no agents in this session
            </div>
          )}
        </div>
      )}

      <StatusBar project={project} lastUpdate={lastUpdate} stale={stale} />
    </div>
  );
}
