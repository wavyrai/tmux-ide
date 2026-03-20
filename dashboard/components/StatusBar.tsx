"use client";

import { useState, useEffect } from "react";
import type { ProjectDetail } from "@/lib/types";

interface StatusBarProps {
  project: ProjectDetail;
}

export function StatusBar({ project }: StatusBarProps) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const activeAgents = project.agents.filter((a) => a.isBusy).length;

  const time = new Date(now).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="fixed bottom-0 left-0 right-0 h-6 bg-[var(--surface)] border-t flex items-center px-3 text-[11px] text-[var(--dim)] z-20">
      <span className="text-[var(--accent)]">{project.session}</span>
      <span className="mx-2 text-[var(--border)]">│</span>
      <span>{activeAgents}/{project.agents.length} agents</span>
      <span className="mx-2 text-[var(--border)]">│</span>
      <span>{doneTasks}/{project.tasks.length} tasks</span>
      <span className="flex-1" />
      <span>{time}</span>
    </div>
  );
}
