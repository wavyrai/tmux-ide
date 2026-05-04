"use client";

import { Folder } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessions } from "@/lib/api";
import type { SessionOverview } from "@/lib/types";
import { useLayoutState } from "@/lib/useLayoutState";
import { useSidebar } from "@/components/ui/sidebar";
import { NavigatorShell } from "@/components/navigators/NavigatorShell";

/**
 * Lists discovered tmux-ide sessions. Default navigator on the overview
 * route and whenever the sidebar mode is "sessions".
 */
export function SessionsNavigator() {
  const pathname = usePathname();
  const { openWorkspaceTab, setActivitySection } = useLayoutState();
  const { setOpenMobile, isMobile } = useSidebar();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await fetchSessions();
        if (!active) return;
        setSessions(data);
        setError(false);
        setLoading(false);
      } catch {
        if (!active) return;
        setError(true);
        setLoading(false);
      }
    }
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const activeProject = pathname.startsWith("/project/")
    ? decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""))
    : null;

  function closeMobile() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <NavigatorShell
      title="Sessions"
      badge={
        <span className="rounded-md bg-[var(--surface)] px-1.5 text-[10px] tabular-nums text-[var(--dim)]">
          {sessions.length}
        </span>
      }
      testId="sessions-navigator"
    >
      {error ? (
        <div className="px-3 py-3 text-[11px] text-[var(--red)]">
          api unreachable — is{" "}
          <span className="text-[var(--accent)]">tmux-ide command-center</span> running?
        </div>
      ) : loading ? (
        <div className="space-y-1 p-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="h-9 animate-pulse rounded-md bg-[var(--surface)]"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="m-2 rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-3 py-4 text-center text-[11px] text-[var(--dim)]">
          <Folder
            aria-hidden="true"
            size={24}
            strokeWidth={1.5}
            className="mx-auto mb-2 text-[var(--accent)]"
          />
          <div className="text-[var(--fg-secondary)]">No sessions</div>
          <div className="mt-1 leading-5">Run tmux-ide init in a project to create one.</div>
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {sessions.map((session) => {
            const selected = activeProject === session.name;
            const stats = session.stats;
            const progress =
              stats && stats.totalTasks > 0 ? `${stats.doneTasks}/${stats.totalTasks}` : null;
            return (
              <li key={session.name}>
                <Link
                  href={`/project/${encodeURIComponent(session.name)}`}
                  data-testid={`navigator-session-${session.name}`}
                  data-active={selected ? "true" : "false"}
                  onClick={() => {
                    openWorkspaceTab("project", session.name, session.name);
                    setActivitySection("sessions");
                    closeMobile();
                  }}
                  className={`block px-3 py-2 transition-colors ${
                    selected
                      ? "bg-[var(--surface-active)]"
                      : "hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Folder
                      aria-hidden="true"
                      size={13}
                      strokeWidth={1.6}
                      className="shrink-0 text-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--fg)]">
                      {session.name}
                    </span>
                    {progress && (
                      <span className="shrink-0 rounded-md bg-[var(--surface)] px-1.5 text-[10px] tabular-nums text-[var(--dim)]">
                        {progress}
                      </span>
                    )}
                  </div>
                  {session.mission?.title && (
                    <div className="ml-5 mt-0.5 truncate text-[10px] text-[var(--dim)]">
                      {session.mission.title}
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </NavigatorShell>
  );
}
