"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { fetchProject, fetchEvents, fetchPanes, type EventData, type PaneData } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { ProgressBar } from "@/components/ProgressBar";
import { AgentCard } from "@/components/AgentCard";
import { KanbanBoard } from "@/components/KanbanBoard";
import { DiffPanel } from "@/components/DiffPanel";
import { ActivityFeed } from "@/components/ActivityFeed";
import { PlansPanel } from "@/components/PlansPanel";
import { StatusBar } from "@/components/StatusBar";
import type { ProjectDetail } from "@/lib/types";

// Lazy-load terminal component to avoid SSR issues with ghostty-web WASM
const MirrorTerminal = dynamic(
  () => import("@/components/MirrorTerminal").then((m) => ({ default: m.MirrorTerminal })),
  { ssr: false },
);

// Responsive pane mirror view — grid on desktop, single pane + selector on mobile
function PaneMirrorView({
  items,
  sessionName,
  emptyMessage,
}: {
  items: { id: string; name: string }[];
  sessionName: string;
  emptyMessage: string;
}) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--dim)]">
        {emptyMessage}
      </div>
    );
  }

  const selected = items[selectedIdx] ?? items[0]!;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Pane selector — always visible, essential for mobile */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
        {items.map((item, i) => (
          <button
            key={item.id}
            onClick={() => setSelectedIdx(i)}
            className={`px-2 py-0.5 text-xs whitespace-nowrap transition-colors rounded ${
              i === selectedIdx
                ? "bg-[var(--accent)] text-[var(--bg)]"
                : "text-[var(--dim)] hover:text-[var(--fg)]"
            }`}
          >
            {item.name}
          </button>
        ))}
      </div>

      {/* Single terminal — full height */}
      <div className="flex-1 min-h-0">
        <MirrorTerminal
          key={selected.id}
          sessionName={sessionName}
          paneId={selected.id}
          paneName={selected.name}
          className="flex flex-col h-full"
        />
      </div>
    </div>
  );
}

type Tab = "kanban" | "agents" | "all-panes" | "diffs" | "plans" | "activity";

const TABS: { id: Tab; label: string }[] = [
  { id: "kanban", label: "kanban" },
  { id: "agents", label: "agents" },
  { id: "all-panes", label: "all panes" },
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

  const panesFetcher = useCallback(() => fetchPanes(name), [name]);
  const { data: panes } = usePolling<PaneData[]>(panesFetcher, 3000);

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
        <PaneMirrorView
          items={project.agents.map((a) => ({ id: a.paneId, name: a.paneTitle }))}
          sessionName={project.session}
          emptyMessage="no agents in this session"
        />
      )}

      {activeTab === "all-panes" && (
        <PaneMirrorView
          items={(panes ?? []).map((p) => ({
            id: p.id,
            name: p.name || p.title || `pane ${p.index}`,
          }))}
          sessionName={project.session}
          emptyMessage="no panes found"
        />
      )}

      <StatusBar project={project} lastUpdate={lastUpdate} stale={stale} />
    </div>
  );
}
