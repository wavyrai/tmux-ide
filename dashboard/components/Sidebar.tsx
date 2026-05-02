"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessions } from "@/lib/api";
import type { SessionOverview } from "@/lib/types";

export function Sidebar() {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await fetchSessions();
        if (!active) return;
        setSessions(data);
        setError(false);
      } catch {
        if (active) setError(true);
      }
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const activeProject = pathname.startsWith("/project/")
    ? decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""))
    : null;
  const onOverview = pathname === "/" || pathname === "";

  return (
    <aside
      data-testid="sidebar"
      className="w-56 shrink-0 border-r border-[var(--border-weak)] bg-[var(--bg-strong)] flex flex-col text-[12px]"
    >
      <Link
        href="/"
        data-active={onOverview || undefined}
        className={`h-8 px-3 flex items-center gap-2 border-b border-[var(--border-weak)] tracking-[0.02em] ${
          onOverview
            ? "text-[var(--accent)]"
            : "text-[var(--fg-secondary)] hover:text-[var(--fg)]"
        }`}
      >
        <span>overview</span>
      </Link>

      <div className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
        sessions
      </div>

      {error && (
        <div className="px-3 py-2 text-[var(--red)] text-[11px]">api unreachable</div>
      )}

      {!error && sessions.length === 0 && (
        <div className="px-3 py-2 text-[var(--dim)] text-[11px]">no sessions</div>
      )}

      <nav className="flex-1 overflow-y-auto pb-2">
        {sessions.map((session) => {
          const isActive = activeProject === session.name;
          return (
            <Link
              key={session.name}
              href={`/project/${encodeURIComponent(session.name)}`}
              data-testid={`sidebar-session-${session.name}`}
              data-active={isActive || undefined}
              className={`group block px-3 py-1.5 transition-colors ${
                isActive
                  ? "bg-[var(--surface-active)] text-[var(--accent)] border-l-2 border-[var(--accent)]"
                  : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] border-l-2 border-transparent"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate flex-1">{session.name}</span>
                {session.stats && session.stats.totalTasks > 0 && (
                  <span className="text-[10px] tabular-nums text-[var(--dim)] group-hover:text-[var(--fg-secondary)]">
                    {session.stats.doneTasks}/{session.stats.totalTasks}
                  </span>
                )}
              </div>
              {session.mission?.title && (
                <div className="text-[10px] text-[var(--dim)] truncate mt-0.5">
                  {session.mission.title}
                </div>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
