"use client";

import { Folder } from "lucide-react";
import { ActivityView } from "@/components/views/ActivityView";
import { DiffsView } from "@/components/views/DiffsView";
import { KanbanView } from "@/components/views/KanbanView";
import { MetricsView } from "@/components/views/MetricsView";
import { MissionView } from "@/components/views/MissionView";
import { PlansView } from "@/components/views/PlansView";
import { SettingsView } from "@/components/views/SettingsView";
import { SkillView } from "@/components/views/SkillView";
import { ValidationView } from "@/components/views/ValidationView";
import { useNavigation, type ProjectTab, type Tab } from "@/lib/navigation";

/**
 * MainTabContent — switches on the active tab kind and renders the
 * matching view component. Inactive tabs are unmounted; per-view state
 * persistence is each view's responsibility (via the `Persist`
 * primitive). The `<section key={tab.id}>` causes React to remount on
 * tab switch which retriggers the fade-in animation.
 */
export function MainTabContent() {
  const { openTabs, activeTabId, sessionName } = useNavigation();
  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;

  if (!activeTab) {
    return (
      <div
        data-testid="main-tab-empty"
        className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--dim)]"
      >
        <Folder aria-hidden="true" size={28} strokeWidth={1.5} />
        <span>
          {sessionName
            ? "no tab open — pick a section in the sidebar"
            : "select a session from the sidebar"}
        </span>
      </div>
    );
  }

  // Terminal tabs are rendered by `TerminalsHost`, a sibling overlay
  // mounted at the AppShell level. Returning null here lets the host's
  // absolute-positioned panel paint above this slot.
  if (activeTab.kind === "terminal") {
    return (
      <div
        data-testid="main-tab-panel"
        data-active="true"
        data-tab-id={activeTab.id}
        data-tab-kind="terminal"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      />
    );
  }

  return (
    <section
      key={activeTab.id}
      data-testid="main-tab-panel"
      data-active="true"
      data-tab-id={activeTab.id}
      data-tab-kind={activeTab.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-[workspace-panel-fade_150ms_ease-out]"
    >
      {renderTab(activeTab)}
    </section>
  );
}

function renderTab(tab: Tab) {
  switch (tab.kind) {
    case "view":
      return renderView(tab.sessionName, tab.view);
    case "skill":
      return <SkillView sessionName={tab.sessionName} skillName={tab.skillName} />;
    case "settings":
      return <SettingsView />;
    case "file":
      return <FilePlaceholder path={tab.path} />;
    case "terminal":
      // Rendered by TerminalsHost; the early return in MainTabContent
      // means we never hit this branch in practice. Kept for exhaustive
      // switch checking.
      return null;
  }
}

function renderView(sessionName: string, view: ProjectTab) {
  switch (view) {
    case "kanban":
      return <KanbanView sessionName={sessionName} />;
    case "mission":
      return <MissionView sessionName={sessionName} />;
    case "diffs":
      return <DiffsView sessionName={sessionName} />;
    case "plans":
      return <PlansView sessionName={sessionName} />;
    case "validation":
      return <ValidationView sessionName={sessionName} />;
    case "metrics":
      return <MetricsView sessionName={sessionName} />;
    case "activity":
      return <ActivityView sessionName={sessionName} />;
  }
}

function FilePlaceholder({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--dim)]">
      <span className="text-[12px]">file editor coming soon</span>
      <code className="rounded-md border border-[var(--border-weak)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg)]">
        {path}
      </code>
    </div>
  );
}
