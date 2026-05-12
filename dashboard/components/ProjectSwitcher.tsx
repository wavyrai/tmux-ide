"use client";

import { Popover } from "@base-ui/react/popover";
import { ChevronDown, Folder, LayoutDashboard, Plus, Settings, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSessions } from "@/lib/api";
import { openAddProjectDialog } from "@/lib/addProjectDialogStore";
import { isSessions, isSettings, isSkills, setNavigation, useNavigation } from "@/lib/navigation";
import { useKeybind } from "@/lib/useKeybinds";
import type { SessionOverview } from "@/lib/types";

const POLL_INTERVAL_MS = 3000;

/**
 * ProjectSwitcher — TopBar control that surfaces the active session and lets
 * the user jump to other sessions, Skills, Settings, or the Overview.
 *
 * Reads NavigationState directly (single source of truth) — the active
 * session label comes from `nav.sessionName` when on a sessions/skills view,
 * otherwise falls back to "Overview" / "tmux-ide".
 *
 * Sessions are polled from the same `fetchSessions()` API the AppSidebar
 * uses, on the same 3s interval so both UIs stay in lockstep.
 *
 * Cmd-P opens the picker (`useKeybind("Mod+p", ...)`). The popover is
 * controlled so the keybind can drive it programmatically.
 */
export function ProjectSwitcher() {
  const nav = useNavigation();
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Active session is whatever the navigation state points at — when the
  // user is on a session or its skills sub-view we show the session name;
  // overview/settings/skills-without-session show a generic label.
  const activeSession = isSessions(nav) || isSkills(nav) ? (nav.sessionName ?? null) : null;

  const label = useMemo(() => {
    if (activeSession) return activeSession;
    if (isSettings(nav)) return "Settings";
    if (isSkills(nav)) return "Skills";
    return "tmux-ide";
  }, [activeSession, nav]);

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
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const openSwitcher = useCallback(() => {
    setOpen(true);
  }, []);

  // Cmd-P / Ctrl-P opens the switcher. allowInput so it works from inputs
  // too (the user might be typing somewhere and want to jump projects).
  useKeybind("Mod+p", openSwitcher, { allowInput: true });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={triggerRef}
        type="button"
        data-testid="project-switcher-button"
        aria-label="Switch project"
        title="Switch project (⌘P)"
        className="mr-2 inline-flex h-5 max-w-[240px] items-center gap-1 rounded-md px-2 text-[10px] text-[var(--fg)] transition-colors motion-safe:transition-transform motion-safe:duration-75 motion-safe:active:scale-[0.98] hover:bg-[var(--surface-hover)] data-[popup-open]:bg-[var(--surface-active)]"
      >
        <Folder aria-hidden="true" size={12} className="text-[var(--accent)]" />
        <span className="truncate font-medium">{label}</span>
        <ChevronDown aria-hidden="true" size={11} className="text-[var(--dim)]" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start" className="z-[80]">
          <Popover.Popup
            data-testid="project-switcher-popover"
            className="z-[80] max-h-[60vh] min-w-[260px] max-w-[360px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-strong)] p-1 text-[11px] text-[var(--fg)] shadow-2xl outline-none transition-[transform,opacity] duration-150 ease-smooth data-closed:opacity-0 data-open:opacity-100 motion-reduce:transition-none"
          >
            <div className="px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-[var(--dim)]">
              sessions
            </div>
            {error ? (
              <div className="px-2 py-2 text-[var(--red)]">api unreachable</div>
            ) : loading ? (
              <div className="px-2 py-2 text-[var(--dim)]">loading…</div>
            ) : sessions.length === 0 ? (
              <div className="px-2 py-2 text-[var(--dim)]">no sessions</div>
            ) : (
              <ul className="flex flex-col">
                {sessions.map((session) => {
                  const isActive = activeSession === session.name;
                  const taskBadge =
                    session.stats && session.stats.totalTasks > 0
                      ? `${session.stats.doneTasks}/${session.stats.totalTasks}`
                      : null;
                  return (
                    <li key={session.name}>
                      <button
                        type="button"
                        data-testid={`project-switcher-item-${session.name}`}
                        data-active={isActive ? "true" : "false"}
                        onClick={() => {
                          setNavigation({
                            type: "sessions",
                            sessionName: session.name,
                            tab: "kanban",
                          });
                          setOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)] ${
                          isActive
                            ? "bg-[var(--surface-active)] text-[var(--accent)]"
                            : "text-[var(--fg)]"
                        }`}
                      >
                        <Folder
                          aria-hidden="true"
                          size={12}
                          className={isActive ? "text-[var(--accent)]" : "text-[var(--dim)]"}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{session.name}</span>
                          {session.mission?.title && (
                            <span className="truncate text-[10px] text-[var(--dim)]">
                              {session.mission.title}
                            </span>
                          )}
                        </span>
                        {taskBadge && (
                          <span className="shrink-0 rounded-sm border border-[var(--border-weak)] px-1 text-[10px] text-[var(--dim)]">
                            {taskBadge}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="my-1 border-t border-[var(--border-weak)]" />

            <ul className="flex flex-col">
              <li>
                <button
                  type="button"
                  data-testid="project-switcher-item-overview"
                  onClick={() => {
                    setNavigation({ type: "overview" });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <LayoutDashboard aria-hidden="true" size={12} className="text-[var(--dim)]" />
                  <span>Overview</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="project-switcher-item-skills"
                  onClick={() => {
                    const next: Parameters<typeof setNavigation>[0] = activeSession
                      ? { type: "skills", sessionName: activeSession }
                      : { type: "skills" };
                    setNavigation(next);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <Sparkles aria-hidden="true" size={12} className="text-[var(--dim)]" />
                  <span>Skills</span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  data-testid="project-switcher-item-settings"
                  onClick={() => {
                    setNavigation({ type: "settings" });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <Settings aria-hidden="true" size={12} className="text-[var(--dim)]" />
                  <span>Settings</span>
                </button>
              </li>
            </ul>

            <div className="my-1 border-t border-[var(--border-weak)]" />

            <ul className="flex flex-col">
              <li>
                <button
                  type="button"
                  data-testid="project-switcher-item-add-project"
                  onClick={() => {
                    openAddProjectDialog();
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[var(--accent)] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  <Plus aria-hidden="true" size={12} />
                  <span>Add project…</span>
                </button>
              </li>
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
