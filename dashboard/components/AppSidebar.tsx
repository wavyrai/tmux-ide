"use client";

import { Folder, LayoutDashboard, Send, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchSessions, fetchSkills, injectIntoProject, type SkillData } from "@/lib/api";
import { useLayoutState } from "@/lib/useLayoutState";
import { useToasts } from "@/lib/useToasts";
import type { SessionOverview } from "@/lib/types";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [error, setError] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState(false);
  const { push } = useToasts();
  const { setOpenMobile, isMobile } = useSidebar();
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

  const activeProject = pathname.startsWith("/project/")
    ? decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""))
    : null;
  const onOverview = pathname === "/" || pathname === "";
  const activeWorkspaceTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId);
  const settingsActive = activeWorkspaceTab?.kind === "settings";

  useEffect(() => {
    if (activitySection !== "skills" || !activeProject) {
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
  }, [activeProject, activitySection]);

  function closeMobile() {
    if (isMobile) setOpenMobile(false);
  }

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
    <Sidebar data-testid="app-sidebar" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={
                <Link
                  href="/"
                  onClick={() => {
                    setActivitySection("sessions");
                    closeMobile();
                  }}
                />
              }
              isActive={onOverview}
              tooltip="Overview"
            >
              <LayoutDashboard aria-hidden="true" />
              <span>tmux-ide</span>
            </SidebarMenuButton>
            <SidebarMenuBadge>{sessions.length}</SidebarMenuBadge>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {activitySection === "settings" ? (
          <SettingsSection
            active={Boolean(settingsActive)}
            onOpen={() => {
              openWorkspaceTab("settings", null, "Settings");
              setActivitySection("settings");
              router.push("/");
              closeMobile();
            }}
          />
        ) : activitySection === "skills" ? (
          <SkillsSection
            activeProject={activeProject}
            skills={skills}
            loading={skillsLoading}
            error={skillsError}
            onOpen={(skill) => {
              if (!activeProject) return;
              openWorkspaceTab("skill", activeProject, `Skill · ${skill.name}`, skill.name);
              closeMobile();
            }}
            onInject={(skill) => void injectSkill(skill)}
          />
        ) : (
          <SessionsSection
            activeProject={activeProject}
            sessions={sessions}
            loading={sessionsLoading}
            error={error}
            onOpen={(session) => {
              openWorkspaceTab("project", session.name, session.name);
              setActivitySection("sessions");
              closeMobile();
            }}
          />
        )}
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

function SettingsSection({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <Settings aria-hidden="true" size={11} />
        settings
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              data-testid="sidebar-settings"
              isActive={active}
              onClick={onOpen}
              tooltip="Settings"
            >
              <Settings aria-hidden="true" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SkillsSection({
  activeProject,
  skills,
  loading,
  error,
  onOpen,
  onInject,
}: {
  activeProject: string | null;
  skills: SkillData[];
  loading: boolean;
  error: boolean;
  onOpen: (skill: SkillData) => void;
  onInject: (skill: SkillData) => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <Sparkles aria-hidden="true" size={11} />
        skills
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {!activeProject && (
          <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
            open a project to load skills
          </div>
        )}
        {activeProject && error && (
          <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
            skills unavailable
          </div>
        )}
        {activeProject && loading && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuSkeleton showIcon />
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        {activeProject && !loading && !error && skills.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
            no skills
          </div>
        )}
        <SidebarMenu>
          {skills.map((skill) => (
            <SidebarMenuItem key={skill.name}>
              <SidebarMenuButton
                type="button"
                data-testid={`sidebar-skill-${skill.name}`}
                onClick={() => onOpen(skill)}
                disabled={!activeProject}
                tooltip={skill.name}
              >
                <Sparkles aria-hidden="true" />
                <span>{skill.name}</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                type="button"
                data-testid={`sidebar-skill-inject-${skill.name}`}
                onClick={() => onInject(skill)}
                disabled={!activeProject}
                showOnHover
                aria-label={`Send ${skill.name} to active agent`}
                title={`Send ${skill.name} to active agent`}
              >
                <Send aria-hidden="true" size={13} />
              </SidebarMenuAction>
              {skill.specialties[0] && (
                <div className="ml-8 mt-0.5 truncate text-[10px] text-[var(--cyan)] group-data-[collapsible=icon]:hidden">
                  {skill.specialties[0]}
                </div>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SessionsSection({
  activeProject,
  sessions,
  loading,
  error,
  onOpen,
}: {
  activeProject: string | null;
  sessions: SessionOverview[];
  loading: boolean;
  error: boolean;
  onOpen: (session: SessionOverview) => void;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        <Folder aria-hidden="true" size={11} />
        sessions
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {error && (
          <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
            api unreachable
          </div>
        )}
        {!error && loading && (
          <SidebarMenu>
            {Array.from({ length: 3 }, (_, index) => (
              <SidebarMenuItem key={index}>
                <SidebarMenuSkeleton showIcon />
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
        {!error && !loading && sessions.length === 0 && (
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
        )}
        <SidebarMenu>
          {sessions.map((session) => {
            const isActive = activeProject === session.name;
            return (
              <SidebarMenuItem key={session.name}>
                <SidebarMenuButton
                  render={
                    <Link
                      href={`/project/${encodeURIComponent(session.name)}`}
                      onClick={() => onOpen(session)}
                    />
                  }
                  isActive={isActive}
                  tooltip={session.name}
                  data-testid={`sidebar-session-${session.name}`}
                >
                  <Folder aria-hidden="true" />
                  <span>{session.name}</span>
                </SidebarMenuButton>
                {session.stats && session.stats.totalTasks > 0 && (
                  <SidebarMenuBadge>
                    {session.stats.doneTasks}/{session.stats.totalTasks}
                  </SidebarMenuBadge>
                )}
                {session.mission?.title && (
                  <div className="ml-8 mt-0.5 truncate text-[10px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
                    {session.mission.title}
                  </div>
                )}
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
