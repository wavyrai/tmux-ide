"use client";

import { Folder, LayoutDashboard, Send, Settings, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSessions, fetchSkills, injectIntoProject, type SkillData } from "@/lib/api";
import {
  isOverview,
  isSessions,
  isSettings,
  isSkills,
  setNavigation,
  useNavigation,
} from "@/lib/navigation";
import { useLayoutState } from "@/lib/useLayoutState";
import { useToasts } from "@/lib/useToasts";
import type { SessionOverview } from "@/lib/types";
import { SidebarTree } from "@/components/app-shell/SidebarTree";
import type { SidebarItem, SidebarSection } from "@/components/app-shell/sidebar-types";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * AppSidebar — primary navigation for the shell.
 *
 * Reads NavigationState from `useNavigation()` (single source of truth)
 * and dispatches changes via `setNavigation(...)`. Replaces the old
 * blend of `pathname` + `activitySection` reads that disagreed under
 * load. Workspace tabs are still managed via `useLayoutState` because
 * tab persistence + ordering is orthogonal to NavigationState.
 */
export function AppSidebar() {
  const nav = useNavigation();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [error, setError] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  const { push } = useToasts();
  const { setOpenMobile, isMobile } = useSidebar();
  const { openWorkspaceTab } = useLayoutState();

  // Derive current view from NavigationState — these used to come from
  // pathname + activitySection independently, which is exactly what was
  // causing the layout drift. Now they all key off `nav`.
  const activeProject =
    isSessions(nav) || isSkills(nav) ? (nav.sessionName ?? null) : null;
  const onOverview = isOverview(nav);
  const settingsActive = isSettings(nav);
  const skillsActive = isSkills(nav);
  const sessionsActive = isSessions(nav) || onOverview;

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await fetchSessions();
        if (!active) return;
        setSessions(data);
        setError(false);
        setSessionsLoading(false);
      } catch {
        if (!active) return;
        setError(true);
        setSessionsLoading(false);
      }
    }
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!skillsActive || !activeProject) {
      setSkills([]);
      setSkillsLoading(false);
      setSkillsError(false);
      return;
    }

    const projectName = activeProject;
    let active = true;
    setSkillsLoading(true);
    async function loadSkills() {
      try {
        const data = await fetchSkills(projectName);
        if (!active) return;
        setSkills(data);
        setSkillsError(false);
        setSkillsLoading(false);
      } catch {
        if (!active) return;
        setSkillsError(true);
        setSkillsLoading(false);
      }
    }

    void loadSkills();
    return () => {
      active = false;
    };
  }, [activeProject, skillsActive]);

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const injectSkill = useCallback(
    async (skill: SkillData) => {
      if (!activeProject) return;
      const ok = await injectIntoProject(activeProject, `<load skill: ${skill.name}>`, {
        sendEnter: false,
      });
      push({
        kind: ok ? "success" : "error",
        title: ok ? "Sent to agent" : "Failed to inject",
        body: skill.name,
      });
    },
    [activeProject, push],
  );

  const items = useMemo<SidebarItem[]>(() => {
    if (settingsActive) {
      const settingsSection: SidebarSection = {
        id: "section-settings",
        type: "section",
        label: "settings",
        icon: Settings,
        items: [
          {
            id: "item-settings",
            title: "Settings",
            icon: Settings,
            isActive: true,
            tooltip: "Settings",
            testId: "sidebar-settings",
            onClick: () => {
              openWorkspaceTab("settings", null, "Settings");
              setNavigation({ type: "settings" });
              closeMobile();
            },
          },
        ],
      };
      return [settingsSection];
    }

    if (skillsActive) {
      const skillsSection: SidebarSection = {
        id: "section-skills",
        type: "section",
        label: "skills",
        icon: Sparkles,
        loading: Boolean(activeProject) && skillsLoading,
        loadingState: (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          </SidebarMenu>
        ),
        error: Boolean(activeProject) && skillsError,
        errorState: (
          <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
            skills unavailable
          </div>
        ),
        emptyState: !activeProject ? (
          <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
            open a project to load skills
          </div>
        ) : (
          <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
            no skills
          </div>
        ),
        items:
          activeProject && !skillsLoading && !skillsError
            ? skills.map((skill) => ({
                id: `skill-${skill.name}`,
                title: skill.name,
                icon: Sparkles,
                tooltip: skill.name,
                disabled: !activeProject,
                testId: `sidebar-skill-${skill.name}`,
                subtitle: skill.specialties[0] ? (
                  <span className="text-[var(--cyan)]">{skill.specialties[0]}</span>
                ) : undefined,
                onClick: () => {
                  if (!activeProject) return;
                  openWorkspaceTab("skill", activeProject, `Skill · ${skill.name}`, skill.name);
                  closeMobile();
                },
                action: {
                  icon: Send,
                  label: `Send ${skill.name} to active agent`,
                  testId: `sidebar-skill-inject-${skill.name}`,
                  showOnHover: true,
                  disabled: !activeProject,
                  onClick: () => void injectSkill(skill),
                },
              }))
            : [],
      };
      return [skillsSection];
    }

    // sessions (default)
    const sessionsSection: SidebarSection = {
      id: "section-sessions",
      type: "section",
      label: "sessions",
      icon: Folder,
      error,
      errorState: (
        <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
          api unreachable
        </div>
      ),
      loading: !error && sessionsLoading,
      loadingState: (
        <SidebarMenu>
          {Array.from({ length: 3 }, (_, index) => (
            <SidebarMenuItem key={index}>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      ),
      emptyState: (
        <div className="mx-1 mt-2 rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-3 py-4 text-center text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
          <Folder
            aria-hidden="true"
            size={24}
            strokeWidth={1.5}
            className="mx-auto mb-2 text-[var(--accent)]"
          />
          <div className="text-[var(--fg-secondary)]">No sessions</div>
          <div className="mt-1 leading-5">Run tmux-ide init in a project to create one.</div>
        </div>
      ),
      items:
        !error && !sessionsLoading
          ? sessions.map((session) => ({
              id: `session-${session.name}`,
              title: session.name,
              icon: Folder,
              isActive: activeProject === session.name,
              tooltip: session.name,
              testId: `sidebar-session-${session.name}`,
              badge:
                session.stats && session.stats.totalTasks > 0
                  ? `${session.stats.doneTasks}/${session.stats.totalTasks}`
                  : undefined,
              subtitle: session.mission?.title ? session.mission.title : undefined,
              onClick: () => {
                openWorkspaceTab("project", session.name, session.name);
                setNavigation({ type: "sessions", sessionName: session.name });
                closeMobile();
              },
            }))
          : [],
    };

    return [sessionsSection];
  }, [
    activeProject,
    closeMobile,
    error,
    injectSkill,
    sessionsLoading,
    sessions,
    settingsActive,
    skills,
    skillsActive,
    skillsError,
    skillsLoading,
    openWorkspaceTab,
  ]);

  return (
    <Sidebar data-testid="app-sidebar" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              isActive={onOverview}
              tooltip="Overview"
              onClick={() => {
                setNavigation({ type: "overview" });
                closeMobile();
              }}
            >
              <LayoutDashboard aria-hidden="true" />
              <span>tmux-ide</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              isActive={sessionsActive && !settingsActive && !skillsActive}
              tooltip="Sessions"
              data-testid="sidebar-mode-sessions"
              onClick={() => {
                if (activeProject) {
                  setNavigation({ type: "sessions", sessionName: activeProject });
                } else {
                  setNavigation({ type: "overview" });
                }
                closeMobile();
              }}
            >
              <Folder aria-hidden="true" />
              <span>Sessions</span>
            </SidebarMenuButton>
            <SidebarMenuBadge>{sessions.length}</SidebarMenuBadge>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              isActive={skillsActive}
              tooltip="Skills"
              data-testid="sidebar-mode-skills"
              onClick={() => {
                const next: Parameters<typeof setNavigation>[0] = activeProject
                  ? { type: "skills", sessionName: activeProject }
                  : { type: "skills" };
                setNavigation(next);
                closeMobile();
              }}
            >
              <Sparkles aria-hidden="true" />
              <span>Skills</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              isActive={settingsActive}
              tooltip="Settings"
              data-testid="sidebar-mode-settings"
              onClick={() => {
                openWorkspaceTab("settings", null, "Settings");
                setNavigation({ type: "settings" });
                closeMobile();
              }}
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarTree items={items} />
      </SidebarContent>

      <SidebarFooter>
        <div className="min-w-0 text-[10px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
          <div className="truncate">theme follows system setting</div>
          <div className="mt-0.5 truncate tabular-nums">
            v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
