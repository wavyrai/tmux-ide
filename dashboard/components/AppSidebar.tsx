"use client";

import {
  Activity,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  Map as MapIcon,
  Plus,
  Send,
  Sparkles,
  Target,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchPlans,
  fetchProject,
  fetchSessions,
  fetchSkills,
  injectIntoProject,
  type PlanSummary,
  type RegisteredProject,
  type SkillData,
} from "@/lib/api";
import { openAddProjectDialog } from "@/lib/addProjectDialogStore";
import {
  ensureDefaultTerminal,
  isOverview,
  isSessions,
  isSkills,
  setNavigation,
  useNavigation,
  type ProjectTab,
} from "@/lib/navigation";
import { Persist } from "@/lib/persist";
import { useLayoutState } from "@/lib/useLayoutState";
import { useProjects } from "@/lib/projectStore";
import { useSessionStream } from "@/lib/useSessionStream";
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * AppSidebar — project-scoped tree navigation.
 *
 * Phase Z replaces the old four-button mode picker (tmux-ide / Sessions /
 * Skills / Settings) with a single contextual tree. The tree adapts to the
 * active NavigationState:
 *
 *  - On a project (`type: "sessions"` with sessionName) — shows the
 *    project tree: Mission, Plans, Skills, Files (sections) plus Diffs,
 *    Validation, Metrics, Activity (leaves that open project tabs).
 *  - On overview (`type: "overview"` or no sessionName) — shows the
 *    sessions list. Clicking a session navigates into it.
 *
 * The project switcher itself lives in the TopBar (Z1). This sidebar is
 * purely contextual.
 */

type SectionId = "mission" | "plans" | "skills" | "files";

interface SectionState {
  mission: boolean;
  plans: boolean;
  skills: boolean;
  files: boolean;
}

const DEFAULT_SECTION_STATE: SectionState = {
  mission: true,
  plans: true,
  skills: false,
  files: false,
};

const expansionPersist = Persist.global<Record<string, SectionState>>(
  "tmux-ide.sidebar.expanded",
  ["v1"],
  {},
);

function readExpansionMap(): Record<string, SectionState> {
  return expansionPersist.read();
}

function writeExpansionMap(map: Record<string, SectionState>): void {
  expansionPersist.write(map);
}

/**
 * Merged view of a project: it may be registered in the project registry,
 * have a live tmux session, or both. The sidebar lists all of them; the
 * stopped/running indicator is derived from the boolean flags.
 */
export interface MergedProject {
  name: string;
  registered: boolean;
  running: boolean;
  session: SessionOverview | null;
  registeredProject: RegisteredProject | null;
}

export function mergeProjects(
  sessions: ReadonlyArray<SessionOverview>,
  registered: ReadonlyArray<RegisteredProject>,
): MergedProject[] {
  const byName = new Map<string, MergedProject>();
  for (const session of sessions) {
    byName.set(session.name, {
      name: session.name,
      registered: false,
      running: true,
      session,
      registeredProject: null,
    });
  }
  for (const project of registered) {
    const existing = byName.get(project.name);
    if (existing) {
      existing.registered = true;
      existing.registeredProject = project;
    } else {
      byName.set(project.name, {
        name: project.name,
        registered: true,
        running: false,
        session: null,
        registeredProject: project,
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function milestoneStatusGlyph(status: string): string {
  switch (status) {
    case "done":
      return "●";
    case "active":
      return "◐";
    case "validating":
      return "◑";
    default:
      return "○";
  }
}

export function AppSidebar() {
  const nav = useNavigation();
  const { setOpenMobile, isMobile } = useSidebar();
  const { openWorkspaceTab } = useLayoutState();
  const { push } = useToasts();

  // Sessions list (overview + project-name fallback)
  const [sessions, setSessions] = useState<SessionOverview[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(false);

  // Registered project list — projects the user added via AddProjectDialog,
  // including ones whose tmux session isn't currently running.
  const projectsState = useProjects();

  // Active project — derived from NavigationState only
  const activeProject = isSessions(nav) || isSkills(nav) ? (nav.sessionName ?? null) : null;
  const onOverview = isOverview(nav) || (isSessions(nav) && !nav.sessionName);

  // Live snapshot for the active project (mission, milestones, skills, etc.)
  const stream = useSessionStream(activeProject);
  const snapshot = stream.snapshot;

  // Plans — fetched separately because not in stream yet
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState(false);

  // Skills — fetched separately so we don't depend on stream timing for the
  // initial render of the sidebar (and so the skills-panel-only path keeps
  // working when the user explicitly opens a skills view).
  const [skills, setSkills] = useState<SkillData[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState(false);

  // Section expansion state (per-project)
  const [expandedMap, setExpandedMap] = useState<Record<string, SectionState>>(() =>
    readExpansionMap(),
  );

  const projectKey = activeProject ?? "__overview__";
  const expanded = expandedMap[projectKey] ?? DEFAULT_SECTION_STATE;

  const toggleSection = useCallback(
    (id: SectionId) => {
      setExpandedMap((current) => {
        const prev = current[projectKey] ?? DEFAULT_SECTION_STATE;
        const next = { ...prev, [id]: !prev[id] };
        const merged = { ...current, [projectKey]: next };
        writeExpansionMap(merged);
        return merged;
      });
    },
    [projectKey],
  );

  // --- Data loading ---

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const data = await fetchSessions();
        if (!active) return;
        setSessions(data);
        setSessionsError(false);
        setSessionsLoading(false);
      } catch {
        if (!active) return;
        setSessionsError(true);
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
    if (!activeProject) {
      setPlans([]);
      setPlansLoading(false);
      setPlansError(false);
      return;
    }
    const projectName = activeProject;
    let active = true;
    setPlansLoading(true);
    async function load() {
      try {
        const data = await fetchPlans(projectName);
        if (!active) return;
        setPlans(data);
        setPlansError(false);
        setPlansLoading(false);
      } catch {
        if (!active) return;
        setPlansError(true);
        setPlansLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [activeProject]);

  useEffect(() => {
    if (!activeProject) {
      setSkills([]);
      setSkillsLoading(false);
      setSkillsError(false);
      return;
    }
    const projectName = activeProject;
    let active = true;
    setSkillsLoading(true);
    async function load() {
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
    void load();
    return () => {
      active = false;
    };
  }, [activeProject]);

  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  const goToTab = useCallback(
    (sessionName: string, tab: ProjectTab) => {
      setNavigation({ type: "sessions", sessionName, tab });
      closeMobile();
    },
    [closeMobile],
  );

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

  // --- Items ---

  const items = useMemo<SidebarItem[]>(() => {
    if (onOverview || !activeProject) {
      const merged = mergeProjects(sessions, projectsState.projects);
      return buildOverviewItems({
        merged,
        loading: sessionsLoading || projectsState.loading,
        error: sessionsError && projectsState.error,
        onPick: (name) => {
          openWorkspaceTab("project", name, name);
          setNavigation({ type: "sessions", sessionName: name });
          closeMobile();
        },
        onAddProject: () => {
          openAddProjectDialog();
          closeMobile();
        },
      });
    }

    return buildProjectItems({
      activeProject,
      // Look up the project's working dir from the live tmux session list
      // first, then fall back to the registered-projects list. The fallback
      // matters for newly-onboarded projects that don't have a running
      // tmux session yet — without it, the Terminal leaf would spawn in
      // $HOME and `tmux-ide` would error with "No ide.yml found in /Users/thijs".
      activeProjectDir:
        sessions.find((s) => s.name === activeProject)?.dir ??
        projectsState.projects.find((p) => p.name === activeProject)?.dir ??
        null,
      activeTab: isSessions(nav) ? (nav.tab ?? "kanban") : "kanban",
      milestones: snapshot?.milestones ?? [],
      missionTitle: snapshot?.mission?.mission?.title ?? null,
      missionStatus: snapshot?.mission?.mission?.status ?? null,
      plans,
      plansLoading,
      plansError,
      skills,
      skillsLoading,
      skillsError,
      expanded,
      toggleSection,
      goToTab,
      injectSkill,
    });
  }, [
    activeProject,
    closeMobile,
    expanded,
    goToTab,
    injectSkill,
    nav,
    onOverview,
    openWorkspaceTab,
    plans,
    plansError,
    plansLoading,
    projectsState.error,
    projectsState.loading,
    projectsState.projects,
    sessions,
    sessionsError,
    sessionsLoading,
    skills,
    skillsError,
    skillsLoading,
    snapshot?.milestones,
    snapshot?.mission?.mission?.status,
    snapshot?.mission?.mission?.title,
    toggleSection,
  ]);

  return (
    <Sidebar data-testid="app-sidebar" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              tooltip={activeProject ?? "Overview"}
              data-testid="sidebar-project-header"
              onClick={() => {
                if (activeProject) {
                  setNavigation({ type: "sessions", sessionName: activeProject });
                } else {
                  setNavigation({ type: "overview" });
                }
                closeMobile();
              }}
            >
              {activeProject ? (
                <FolderOpen aria-hidden="true" />
              ) : (
                <Folder aria-hidden="true" />
              )}
              <span className="truncate font-medium">{activeProject ?? "Overview"}</span>
              <ChevronDown
                aria-hidden="true"
                size={12}
                className="ml-auto text-[var(--dim)] group-data-[collapsible=icon]:hidden"
              />
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

// ---------- Overview tree ----------

interface OverviewArgs {
  merged: MergedProject[];
  loading: boolean;
  error: boolean;
  onPick: (name: string) => void;
  onAddProject: () => void;
}

function buildOverviewItems(args: OverviewArgs): SidebarItem[] {
  const isEmpty = !args.error && !args.loading && args.merged.length === 0;

  const sessionsSection: SidebarSection = {
    id: "section-sessions",
    type: "section",
    label: "projects",
    icon: Folder,
    error: args.error,
    errorState: (
      <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
        api unreachable
      </div>
    ),
    loading: !args.error && args.loading,
    loadingState: (
      <SidebarMenu>
        {Array.from({ length: 3 }, (_, index) => (
          <SidebarMenuItem key={index}>
            <SidebarMenuSkeleton showIcon />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    ),
    emptyState: isEmpty ? (
      <div
        data-testid="sidebar-empty-state"
        className="mx-1 mt-2 rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-3 py-4 text-center text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden"
      >
        <Folder
          aria-hidden="true"
          size={24}
          strokeWidth={1.5}
          className="mx-auto mb-2 text-[var(--accent)]"
        />
        <div className="text-[var(--fg-secondary)]">No projects yet</div>
        <button
          type="button"
          data-testid="sidebar-add-first-project"
          onClick={args.onAddProject}
          className="mt-3 inline-flex items-center gap-1 rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
        >
          <Plus aria-hidden="true" size={12} />
          Add your first project
        </button>
      </div>
    ) : undefined,
    // Items: registered + running projects, plus a trailing "Add project…"
    // entry when the list is non-empty. When the list is empty we omit the
    // trailing item entirely so the empty-state CTA can render instead.
    items:
      !args.error && !args.loading && args.merged.length > 0
        ? [
            ...args.merged.map((project) => projectToSidebarLink(project, args.onPick)),
            {
              id: "session-add-project",
              title: "Add project…",
              icon: Plus,
              tooltip: "Add a project",
              testId: "sidebar-add-project",
              onClick: args.onAddProject,
            },
          ]
        : [],
  };

  return [sessionsSection];
}

function projectToSidebarLink(
  project: MergedProject,
  onPick: (name: string) => void,
): SidebarItem {
  const session = project.session;
  const badge =
    session && session.stats && session.stats.totalTasks > 0
      ? `${session.stats.doneTasks}/${session.stats.totalTasks}`
      : undefined;
  const status = project.running ? "running" : "stopped";
  const subtitle = session?.mission?.title
    ? session.mission.title
    : !project.running
      ? "stopped"
      : undefined;
  return {
    id: `session-${project.name}`,
    title: project.name,
    icon: Folder,
    tooltip: `${project.name} (${status})`,
    testId: `sidebar-session-${project.name}`,
    ...(badge !== undefined ? { badge } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    onClick: () => onPick(project.name),
  };
}

// ---------- Project tree ----------

interface ProjectArgs {
  activeProject: string;
  activeProjectDir: string | null;
  activeTab: ProjectTab;
  milestones: { id: string; title: string; status: string; taskCount: number; tasksDone: number }[];
  missionTitle: string | null;
  missionStatus: string | null;
  plans: PlanSummary[];
  plansLoading: boolean;
  plansError: boolean;
  skills: SkillData[];
  skillsLoading: boolean;
  skillsError: boolean;
  expanded: SectionState;
  toggleSection: (id: SectionId) => void;
  goToTab: (sessionName: string, tab: ProjectTab) => void;
  injectSkill: (skill: SkillData) => void;
}

function buildProjectItems(args: ProjectArgs): SidebarItem[] {
  const {
    activeProject,
    activeProjectDir,
    activeTab,
    milestones,
    missionTitle,
    plans,
    plansLoading,
    plansError,
    skills,
    skillsLoading,
    skillsError,
    expanded,
    toggleSection,
    goToTab,
    injectSkill,
  } = args;

  // ----- Mission section -----
  const missionItems: SidebarItem[] = [
    {
      id: "mission-overview",
      title: missionTitle ?? "Open mission view",
      icon: Target,
      isActive: activeTab === "mission",
      tooltip: missionTitle ?? "Mission",
      testId: "sidebar-mission-overview",
      onClick: () => goToTab(activeProject, "mission"),
    },
    ...milestones.map((m) => ({
      id: `milestone-${m.id}`,
      title: `${milestoneStatusGlyph(m.status)} ${m.title}`,
      icon: MapIcon,
      tooltip: `${m.title} (${m.tasksDone}/${m.taskCount})`,
      testId: `sidebar-milestone-${m.id}`,
      badge: m.taskCount > 0 ? `${m.tasksDone}/${m.taskCount}` : undefined,
      onClick: () => goToTab(activeProject, "mission"),
    })),
  ];

  const missionSection: SidebarSection = {
    id: "section-mission",
    type: "section",
    label: "mission",
    icon: Target,
    collapsible: true,
    expanded: expanded.mission,
    onToggle: () => toggleSection("mission"),
    testId: "sidebar-section-mission",
    items: missionItems,
    emptyState: missionTitle ? undefined : (
      <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
        no mission yet
      </div>
    ),
  };

  // ----- Plans section -----
  const planItems: SidebarItem[] = plans.map((plan) => ({
    id: `plan-${plan.name}`,
    title: plan.title || plan.name,
    icon: FileText,
    tooltip: plan.title || plan.name,
    testId: `sidebar-plan-${plan.name}`,
    subtitle: plan.status !== "pending" ? plan.status : undefined,
    onClick: () => goToTab(activeProject, "plans"),
  }));

  const plansSection: SidebarSection = {
    id: "section-plans",
    type: "section",
    label: "plans",
    icon: FileText,
    collapsible: true,
    expanded: expanded.plans,
    onToggle: () => toggleSection("plans"),
    testId: "sidebar-section-plans",
    badge: plans.length > 0 ? plans.length : undefined,
    loading: plansLoading,
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
    error: plansError,
    errorState: (
      <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
        plans unavailable
      </div>
    ),
    emptyState: (
      <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
        no plans
      </div>
    ),
    items: planItems,
  };

  // ----- Skills section -----
  const skillItems: SidebarItem[] = skills.map((skill) => ({
    id: `skill-${skill.name}`,
    title: skill.name,
    icon: Sparkles,
    tooltip: skill.name,
    testId: `sidebar-skill-${skill.name}`,
    subtitle: skill.specialties[0] ? (
      <span className="text-[var(--cyan)]">{skill.specialties[0]}</span>
    ) : undefined,
    onClick: () => {
      setNavigation({ type: "skills", sessionName: activeProject, skillName: skill.name });
    },
    action: {
      icon: Send,
      label: `Send ${skill.name} to active agent`,
      testId: `sidebar-skill-inject-${skill.name}`,
      showOnHover: true,
      onClick: () => injectSkill(skill),
    },
  }));

  const skillsSection: SidebarSection = {
    id: "section-skills",
    type: "section",
    label: "skills",
    icon: Sparkles,
    collapsible: true,
    expanded: expanded.skills,
    onToggle: () => toggleSection("skills"),
    testId: "sidebar-section-skills",
    badge: skills.length > 0 ? skills.length : undefined,
    loading: skillsLoading,
    loadingState: (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    ),
    error: skillsError,
    errorState: (
      <div className="px-2 py-2 text-[11px] text-[var(--red)] group-data-[collapsible=icon]:hidden">
        skills unavailable
      </div>
    ),
    emptyState: (
      <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
        no skills
      </div>
    ),
    items: skillItems,
  };

  // ----- Files section (placeholder) -----
  const filesSection: SidebarSection = {
    id: "section-files",
    type: "section",
    label: "files",
    icon: FolderOpen,
    collapsible: true,
    expanded: expanded.files,
    onToggle: () => toggleSection("files"),
    testId: "sidebar-section-files",
    items: [],
    emptyState: (
      <div className="px-2 py-2 text-[11px] text-[var(--dim)] group-data-[collapsible=icon]:hidden">
        coming soon
      </div>
    ),
  };

  // ----- View leaves -----
  const leafGroup: SidebarSection = {
    id: "section-views",
    type: "section",
    label: "views",
    items: [
      {
        id: "view-terminal",
        title: "Terminal",
        icon: TerminalSquare,
        tooltip: "Open the project's default terminal",
        testId: "sidebar-view-terminal",
        onClick: () => {
          if (!activeProject) return;
          // If the polled sessions cache already has the dir, open
          // immediately. Otherwise fetch the project to resolve dir,
          // then open. The PTY bridge is keyed on the tab's stable id,
          // so we must spawn the FIRST connection with the right cwd —
          // a "fix the cwd later" approach won't repath an already-
          // running shell.
          if (activeProjectDir) {
            ensureDefaultTerminal(activeProject, activeProjectDir);
            return;
          }
          void fetchProject(activeProject)
            .then((project) => {
              ensureDefaultTerminal(activeProject, project?.dir);
            })
            .catch(() => {
              ensureDefaultTerminal(activeProject);
            });
        },
      },
      {
        id: "view-diffs",
        title: "Diffs",
        icon: GitCompare,
        tooltip: "Diffs",
        testId: "sidebar-view-diffs",
        isActive: activeTab === "diffs",
        onClick: () => goToTab(activeProject, "diffs"),
      },
      {
        id: "view-validation",
        title: "Validation",
        icon: CheckCircle2,
        tooltip: "Validation",
        testId: "sidebar-view-validation",
        isActive: activeTab === "validation",
        onClick: () => goToTab(activeProject, "validation"),
      },
      {
        id: "view-metrics",
        title: "Metrics",
        icon: BarChart3,
        tooltip: "Metrics",
        testId: "sidebar-view-metrics",
        isActive: activeTab === "metrics",
        onClick: () => goToTab(activeProject, "metrics"),
      },
      {
        id: "view-activity",
        title: "Activity",
        icon: Activity,
        tooltip: "Activity",
        testId: "sidebar-view-activity",
        isActive: activeTab === "activity",
        onClick: () => goToTab(activeProject, "activity"),
      },
    ],
  };

  return [
    missionSection,
    plansSection,
    skillsSection,
    filesSection,
    { id: "sep-views", type: "separator" },
    leafGroup,
  ];
}
