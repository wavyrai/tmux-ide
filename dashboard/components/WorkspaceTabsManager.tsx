"use client";

import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { NotificationsView } from "@/components/views/NotificationsView";
import { SettingsView } from "@/components/views/SettingsView";
import { SkillView } from "@/components/views/SkillView";
import { isSessions, isSettings, isSkills, useNavigation } from "@/lib/navigation";
import { useLayoutState } from "@/lib/useLayoutState";

interface WorkspaceTabsManagerProps {
  children?: ReactNode;
}

// Renders ONLY the active workspace tab in normal flow. Inactive tabs are
// unmounted — per-view state persistence (scroll, form state) is the view's
// responsibility via persist primitives. The `<section key={tab.id}>` causes
// React to re-mount on tab switch, which retriggers the fade-in animation.
//
// Routing is now keyed off NavigationState rather than pathname directly:
// the active workspace tab matches the current `nav` when it points at the
// same project / settings / skill, and falls back to the workspace tab's
// own kind otherwise.
export function WorkspaceTabsManager({ children }: WorkspaceTabsManagerProps) {
  const nav = useNavigation();
  const { workspaceTabs, activeWorkspaceTabId } = useLayoutState();

  // NavigationState wins over workspace tabs: settings/skills targets in
  // the URL render those views regardless of the workspace-tab cache.
  if (isSettings(nav)) {
    return (
      <section
        key="nav:settings"
        data-testid="workspace-tab-panel"
        data-active="true"
        data-tab-id="settings:"
        className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-[workspace-panel-fade_150ms_ease-out]"
      >
        <SettingsView />
      </section>
    );
  }

  if (isSkills(nav) && nav.sessionName && nav.skillName) {
    return (
      <section
        key={`nav:skill:${nav.sessionName}:${nav.skillName}`}
        data-testid="workspace-tab-panel"
        data-active="true"
        data-tab-id={`skill:${nav.sessionName}:${nav.skillName}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-[workspace-panel-fade_150ms_ease-out]"
      >
        <SkillView sessionName={nav.sessionName} skillName={nav.skillName} />
      </section>
    );
  }

  if (workspaceTabs.length === 0) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--dim)]">
        <Folder aria-hidden="true" size={28} strokeWidth={1.5} />
        <span>select a session from the sidebar</span>
      </div>
    );
  }

  const activeTab =
    workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];

  if (!activeTab) return null;

  // For project tabs we render the Next.js page tree (children) iff the
  // active workspace tab points at the same project NavigationState does.
  // Diverging case: workspace tab opened, but the URL is still on overview.
  const projectMatches =
    activeTab.kind === "project" &&
    isSessions(nav) &&
    nav.sessionName === activeTab.projectName;

  return (
    <section
      key={activeTab.id}
      data-testid="workspace-tab-panel"
      data-active="true"
      data-tab-id={activeTab.id}
      className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-[workspace-panel-fade_150ms_ease-out]"
    >
      {activeTab.kind === "notifications" ? (
        <NotificationsView />
      ) : activeTab.kind === "settings" ? (
        <SettingsView />
      ) : activeTab.kind === "skill" && activeTab.projectName && activeTab.ref ? (
        <SkillView sessionName={activeTab.projectName} skillName={activeTab.ref} />
      ) : projectMatches ? (
        children
      ) : (
        <div className="flex h-full flex-1 items-center justify-center text-[var(--dim)]">
          {activeTab.title}
        </div>
      )}
    </section>
  );
}
