"use client";

import { useEffect, useState } from "react";
import { fetchSessions } from "@/lib/api";
import { ProjectRow } from "@/components/ProjectRow";
import type { SessionOverview } from "@/lib/types";

export default function OverviewPage() {
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;

    async function poll() {
      try {
        const data = await fetchSessions();
        if (active) {
          setSessions(data);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 h-7 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <span className="text-[var(--accent)]">tmux-ide command center</span>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-[6px] h-[6px] ${error ? "bg-[var(--red)]" : "bg-[var(--green)]"}`}
          />
          <span className="text-[var(--dim)]">
            {error ? "offline" : `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {error && (
          <div className="px-4 py-3 text-[var(--red)] bg-[var(--surface)] border-b border-[var(--border)]">
            cannot reach api — is{" "}
            <span className="text-[var(--accent)]">tmux-ide command-center</span> running?
          </div>
        )}

        {sessions.length === 0 && !error && (
          <div className="px-4 py-8 text-[var(--dim)]">no tmux-ide sessions running</div>
        )}

        {sessions.length > 0 && (
          <div>
            {/* Column headers */}
            <div className="flex items-center px-4 h-6 text-[var(--dim)] bg-[var(--surface)] border-b border-[var(--border)]">
              <span className="w-3" />
              <span className="w-[20ch] shrink-0">session</span>
              <span className="flex-1">mission</span>
              <span className="w-[14ch] text-right">progress</span>
              <span className="w-[8ch] text-right">agents</span>
              <span className="w-[10ch] text-right">tasks</span>
            </div>

            {sessions.map((s) => (
              <ProjectRow key={s.name} session={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
