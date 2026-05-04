"use client";

import { KanbanBoard } from "./KanbanBoard";
import { Panel } from "@/components/ui";
import { useSessionStream } from "@/lib/useSessionStream";

interface KanbanViewProps {
  sessionName: string;
}

export function KanbanView({ sessionName }: KanbanViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const project = snapshot?.project ?? null;

  if (!project) {
    return (
      <Panel testId="kanban-view-loading" className="items-center justify-center text-[var(--dim)]">
        Loading…
      </Panel>
    );
  }

  return (
    <KanbanBoard
      sessionName={project.session}
      tasks={project.tasks}
      goals={project.goals}
      agents={project.agents}
      events={snapshot?.events ?? []}
    />
  );
}
