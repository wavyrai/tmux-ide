"use client";

import { useCallback } from "react";
import { fetchProject } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { AgentCard } from "@/components/AgentCard";
import type { ProjectDetail } from "@/lib/types";

interface AgentsViewProps {
  sessionName: string;
}

export function AgentsView({ sessionName }: AgentsViewProps) {
  const fetcher = useCallback(() => fetchProject(sessionName), [sessionName]);
  const { data: project, error } = usePolling<ProjectDetail | null>(fetcher, 2000);

  if (error) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] text-[var(--red)] overflow-hidden">
        failed to load agents
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex flex-1 min-h-0 flex-col items-center justify-center bg-[var(--bg)] text-[var(--dim)] overflow-hidden">
        loading agents...
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)] overflow-hidden">
      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {project.agents.map((agent, index) => (
            <AgentCard key={`${agent.paneTitle}-${index}`} agent={agent} />
          ))}
        </div>
        {project.agents.length === 0 && (
          <div className="flex h-32 items-center justify-center text-[var(--dim)]">
            no agents in this session
          </div>
        )}
      </div>
    </div>
  );
}
