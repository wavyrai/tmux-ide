"use client";

import { useSessionStream } from "@/lib/useSessionStream";
import { KanbanBoard } from "@/components/KanbanBoard";

interface KanbanViewProps {
  sessionName: string;
}

export function KanbanView({ sessionName }: KanbanViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const project = snapshot?.project ?? null;

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
        events={snapshot?.events ?? []}
        onRefresh={() => undefined}
      />
    </div>
  );
}
