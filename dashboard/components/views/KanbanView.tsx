"use client";

import { useCallback } from "react";
import { fetchProject } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { KanbanBoard } from "@/components/KanbanBoard";
import type { ProjectDetail } from "@/lib/types";

interface KanbanViewProps {
  sessionName: string;
}

export function KanbanView({ sessionName }: KanbanViewProps) {
  const fetcher = useCallback(() => fetchProject(sessionName), [sessionName]);
  const { data: project, error, refresh } = usePolling<ProjectDetail | null>(fetcher, 2000);

  if (error) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] text-[var(--red)] overflow-hidden">
        failed to load project
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] text-[var(--dim)] overflow-hidden">
        loading...
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <KanbanBoard
        tasks={project.tasks}
        sessionName={project.session}
        agents={project.agents}
        goals={project.goals}
        onRefresh={refresh}
      />
    </div>
  );
}
