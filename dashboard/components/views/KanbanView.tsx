"use client";

import { useSessionStream } from "@/lib/useSessionStream";
import { KanbanBoard } from "@/components/KanbanBoard";
import { Panel } from "@/components/ui";

interface KanbanViewProps {
  sessionName: string;
}

export function KanbanView({ sessionName }: KanbanViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const project = snapshot?.project ?? null;

  if (!project) {
    return (
      <Panel className="items-center justify-center text-[var(--dim)]">loading...</Panel>
    );
  }

  return (
    <Panel>
      <KanbanBoard
        tasks={project.tasks}
        sessionName={project.session}
        agents={project.agents}
        goals={project.goals}
        events={snapshot?.events ?? []}
        onRefresh={() => undefined}
      />
    </Panel>
  );
}
