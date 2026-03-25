"use client";

import { useState, useEffect, useRef } from "react";
import type { ProjectDetail } from "@/lib/types";

interface StatusBarProps {
  project: ProjectDetail;
  lastUpdate?: number;
  stale?: boolean;
}

export function StatusBar({ project, lastUpdate, stale = false }: StatusBarProps) {
  const [now, setNow] = useState(Date.now());
  const [flash, setFlash] = useState(false);
  const prevUpdateRef = useRef(lastUpdate);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Flash the dot when data refreshes
  useEffect(() => {
    if (lastUpdate && lastUpdate !== prevUpdateRef.current) {
      prevUpdateRef.current = lastUpdate;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 300);
      return () => clearTimeout(id);
    }
  }, [lastUpdate]);

  const doneTasks = project.tasks.filter((t) => t.status === "done").length;
  const activeAgents = project.agents.filter((a) => a.isBusy).length;

  const ago = lastUpdate ? Math.max(0, Math.floor((now - lastUpdate) / 1000)) : 0;

  const time = new Date(now).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="fixed bottom-0 left-0 right-0 h-6 bg-[var(--bg-weak)] border-t flex items-center px-3 text-[11px] z-20">
      {/* Left: session name */}
      <span className="text-[var(--accent)] font-medium">{project.session}</span>

      {/* Center: stats */}
      <span className="mx-2 text-[var(--dim)] opacity-30">│</span>
      <span className="text-[var(--dim)]">
        <span style={{ color: activeAgents > 0 ? "var(--yellow)" : undefined }}>
          {activeAgents}
        </span>
        /{project.agents.length} agents
      </span>
      <span className="mx-2 text-[var(--dim)] opacity-30">│</span>
      <span className="text-[var(--dim)]">
        <span style={{ color: doneTasks > 0 ? "var(--green)" : undefined }}>{doneTasks}</span>/
        {project.tasks.length} tasks
      </span>
      <span className="mx-2 text-[var(--dim)] opacity-30">│</span>
      <span className="text-[var(--dim)]">updated {ago}s ago</span>

      <span className="flex-1" />

      {/* Right: live indicator + clock */}
      <span
        className="transition-opacity duration-300"
        style={{
          color: stale ? "var(--red)" : "var(--green)",
          opacity: flash ? 1 : 0.6,
        }}
      >
        ●
      </span>
      <span className="text-[var(--dim)] ml-1.5">{stale ? "stale" : "live"}</span>
      <span className="mx-2 text-[var(--dim)] opacity-30">│</span>
      <span className="text-[var(--dim)]">{time}</span>
    </div>
  );
}
