"use client";

import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { EventBridge } from "@/components/EventBridge";
import { FullScreenTerminal } from "@/components/FullScreenTerminal";
import { KeybindRoot } from "@/components/KeybindRoot";
import { ShellStatusBar } from "@/components/StatusBar";
import { ToastStack } from "@/components/ToastStack";
import { WorkspaceTabsBar } from "@/components/WorkspaceTabsBar";
import { WorkspaceTabsManager } from "@/components/WorkspaceTabsManager";
import { WorkspaceUrlSync } from "@/components/WorkspaceUrlSync";
import { ProjectViewTabs } from "@/components/ProjectViewTabs";
import {
  MissionTreeNavigator,
  SessionsNavigator,
  SettingsNavigator,
  SkillsNavigator,
} from "@/components/navigators";
import { SidebarInset } from "@/components/ui/sidebar";
import { NAVIGATOR_WIDTH, PANEL_SPRING } from "@/lib/panel-constants";
import {
  isSessions,
  isSettings,
  isSkills,
  setNavigation,
  useNavigation,
  type NavigationState,
  type SettingsSection,
} from "@/lib/navigation";

const SHELL_CLASS = "flex h-[calc(100vh-1.5rem)] min-h-0 flex-col";

/**
 * AppShell — the single orchestrator that picks sidebar / navigator /
 * secondary-tabs / content based ONLY on `useNavigation()`. Replaces the
 * five-state-source layout that previously coordinated via pathname,
 * ?tab=, activitySection, activeWorkspaceTabId, and module-level portals.
 *
 * Local sub-components (Navigator, SecondaryTabs, Content) switch on
 * `nav.type` and render the appropriate piece. No portals, no module
 * stores — the union drives everything.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const nav = useNavigation();
  return (
    <div className={SHELL_CLASS}>
      <WorkspaceUrlSync />
      <EventBridge />
      <div className="flex min-h-0 flex-1">
        {/* AppSidebar — primary navigation. Stays visible across all
            navigation states; mode buttons drive setNavigation. */}
        <AppSidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspaceTabsBar />
          <SecondaryTabs nav={nav} />
          <div className="flex min-h-0 min-w-0 flex-1">
            <Navigator nav={nav} />
            <SidebarInset>
              <Content nav={nav}>{children}</Content>
              <FullScreenTerminal />
            </SidebarInset>
          </div>
        </div>
      </div>
      <ShellStatusBar />
      <CommandPalette />
      <ToastStack />
      <KeybindRoot />
    </div>
  );
}

// ---------- Local components ----------

interface NavProps {
  nav: NavigationState;
}

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

/**
 * Renders the navigator column for the active navigation state.
 *
 * The view-specific switch lives here (NOT in the views themselves) so
 * navigator selection is centralized and predictable. Views are rendered
 * unaware that the navigator is being driven by the same state union.
 */
function Navigator({ nav }: NavProps) {
  const isNarrow = useIsNarrow();
  const node = pickNavigator(nav);
  if (!node || isNarrow) return null;
  return (
    <motion.div
      data-testid="navigator-slot"
      data-slot="panel"
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--border-weak)] bg-[var(--bg)]"
      initial={false}
      animate={{ width: NAVIGATOR_WIDTH }}
      transition={PANEL_SPRING}
      style={{ width: NAVIGATOR_WIDTH }}
    >
      {node}
    </motion.div>
  );
}

function pickNavigator(nav: NavigationState): ReactNode {
  if (isSettings(nav)) {
    const active: SettingsSection = nav.section ?? "general";
    return (
      <SettingsNavigator
        active={active}
        onChange={(section) => setNavigation({ type: "settings", section })}
      />
    );
  }
  if (isSkills(nav)) {
    return <SkillsNavigator />;
  }
  if (isSessions(nav)) {
    if (!nav.sessionName) return <SessionsNavigator />;
    const tab = nav.tab ?? "kanban";
    if (tab === "kanban" || tab === "mission") {
      return <MissionTreeNavigator sessionName={nav.sessionName} />;
    }
    // Other project tabs (diffs, plans, validation, metrics, activity) used
    // to register custom rails via NavigatorPortal. Plans/Kanban renderers
    // lift their own rails into the content area now; for the rest we fall
    // back to the sessions list so the column doesn't collapse mid-session.
    return <SessionsNavigator />;
  }
  // overview
  return <SessionsNavigator />;
}

/**
 * Renders the secondary-tabs strip (project view tabs) when the user is in
 * a session. Replaces the SecondaryTabsPortal.
 */
function SecondaryTabs({ nav }: NavProps) {
  if (!isSessions(nav) || !nav.sessionName) return null;
  const active = nav.tab ?? "kanban";
  const sessionName = nav.sessionName;
  return (
    <div data-testid="secondary-tabs-slot" className="shrink-0">
      <ProjectViewTabs
        active={active}
        onChange={(tab) => setNavigation({ type: "sessions", sessionName, tab })}
      />
    </div>
  );
}

/**
 * Renders the active workspace tab in the content area. The
 * WorkspaceTabsManager already chooses which workspace tab is active and
 * renders the right view; we pass the page `children` (Next.js route) so
 * project pages slot in correctly.
 *
 * `nav` is unused at this layer because the WorkspaceTabsManager keys off
 * `useLayoutState`'s workspace tabs and the Next router. We thread it in
 * for future extensibility (e.g., kanban filter rail moving inline).
 */
function Content({ nav: _nav, children }: NavProps & { children?: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkspaceTabsManager>{children}</WorkspaceTabsManager>
    </div>
  );
}

