"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessions, fetchSkills, injectIntoProject, type SkillData } from "@/lib/api";
import { useLayoutState } from "@/lib/useLayoutState";
import { useToasts } from "@/lib/useToasts";
import type { SessionOverview } from "@/lib/types";

interface SidebarProps {
  className?: string;
  testId?: string;
  onNavigate?: () => void;
}

export function Sidebar({ className = "", testId = "sidebar", onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [error, setError] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  const { push } = useToasts();
  const {
    activitySection,
    activeWorkspaceTabId,
    workspaceTabs,
    openWorkspaceTab,
    setActivitySection,
  } = useLayoutState();

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
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
  const settingsActive = activeWorkspaceTab?.kind === "settings";

  useEffect(() => {
    if (activitySection !== "skills" || !activeProject) {
      setSkills([]);
      setSkillsError(false);
      return;
    }

    const projectName = activeProject;
    let active = true;
    async function loadSkills() {
      try {
        const data = await fetchSkills(projectName);
        if (!active) return;
        setSkills(data);
        setSkillsError(false);
      } catch {
        if (active) setSkillsError(true);
      }
    }

    void loadSkills();
    return () => {
      active = false;
    };
  }, [activeProject, activitySection]);

  async function injectSkill(skill: SkillData) {
    if (!activeProject) return;
    const ok = await injectIntoProject(activeProject, `<load skill: ${skill.name}>`, {
      sendEnter: false,
    });
    push({
      kind: ok ? "success" : "error",
      title: ok ? "Sent to agent" : "Failed to inject",
      body: skill.name,
    });
  }

  return (
    <aside
      data-testid={testId}
      className={`w-56 shrink-0 border-r border-[var(--border-weak)] bg-[var(--bg-strong)] flex flex-col text-[12px] ${className}`}
    >
      <Link
        href="/"
        onClick={() => {
          setActivitySection("sessions");
          onNavigate?.();
        }}
        data-active={onOverview || undefined}
        className={`h-8 px-3 flex items-center gap-2 border-b border-[var(--border-weak)] tracking-[0.02em] ${
          onOverview ? "text-[var(--accent)]" : "text-[var(--fg-secondary)] hover:text-[var(--fg)]"
        }`}
      >
        <span>overview</span>
      </Link>

      {activitySection === "settings" ? (
        <>
          <div className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
            settings
          </div>
          <button
            type="button"
            data-testid="sidebar-settings"
            data-active={settingsActive ? "true" : undefined}
            onClick={() => {
              openWorkspaceTab("settings", null, "Settings");
              setActivitySection("settings");
              router.push("/");
              onNavigate?.();
            }}
            className={`mx-0 block px-3 py-1.5 text-left transition-colors ${
              settingsActive
                ? "border-l-2 border-[var(--accent)] bg-[var(--surface-active)] text-[var(--accent)]"
                : "border-l-2 border-transparent text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
            }`}
          >
            Settings
          </button>
        </>
      ) : activitySection === "skills" ? (
        <>
          <div className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
            skills
          </div>

          {!activeProject && (
            <div className="px-3 py-2 text-[var(--dim)] text-[11px]">
              open a project to load skills
            </div>
          )}

          {activeProject && skillsError && (
            <div className="px-3 py-2 text-[var(--red)] text-[11px]">skills unavailable</div>
          )}

          {activeProject && !skillsError && skills.length === 0 && (
            <div className="px-3 py-2 text-[var(--dim)] text-[11px]">no skills</div>
          )}

          <nav className="flex-1 overflow-y-auto pb-2">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className="group flex items-stretch border-l-2 border-transparent transition-colors hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]"
              >
                <button
                  type="button"
                  data-testid={`sidebar-skill-${skill.name}`}
                  onClick={() => {
                    if (!activeProject) return;
                    openWorkspaceTab("skill", activeProject, `Skill · ${skill.name}`, skill.name);
                    onNavigate?.();
                  }}
                  className="min-w-0 flex-1 px-3 py-2 text-left text-[var(--fg-secondary)] transition-colors hover:text-[var(--fg)]"
                  title={`Open ${skill.name}`}
                  disabled={!activeProject}
                >
                  <span className="block truncate text-[12px]">{skill.name}</span>
                  {skill.specialties[0] && (
                    <span className="mt-1 inline-block max-w-full truncate rounded-sm border border-[var(--border-weak)] bg-[var(--surface)] px-1 text-[10px] text-[var(--cyan)]">
                      {skill.specialties[0]}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  data-testid={`sidebar-skill-inject-${skill.name}`}
                  onClick={() => void injectSkill(skill)}
                  className="flex w-7 shrink-0 items-center justify-center text-[var(--dim)] opacity-0 transition-opacity hover:text-[var(--accent)] group-hover:opacity-100"
                  title={`Send ${skill.name} to active agent`}
                  aria-label={`Send ${skill.name} to active agent`}
                  disabled={!activeProject}
                >
                  →
                </button>
              </div>
            ))}
          </nav>
        </>
      ) : (
        <>
          <div className="px-3 pt-3 pb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
            sessions
          </div>

          {error && <div className="px-3 py-2 text-[var(--red)] text-[11px]">api unreachable</div>}

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
                  onClick={() => {
                    openWorkspaceTab("project", session.name, session.name);
                    setActivitySection("sessions");
                    onNavigate?.();
                  }}
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
        </>
      )}
    </aside>
  );
}
