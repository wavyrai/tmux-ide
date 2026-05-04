"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { PROJECT_TABS, ProjectViewTabs, type ProjectTab } from "@/components/ProjectViewTabs";
import { SecondaryTabsPortal } from "@/lib/useSecondaryTabsSlot";
import { ActivityView } from "@/components/views/ActivityView";
import { DiffsView } from "@/components/views/DiffsView";
import { KanbanView } from "@/components/views/KanbanView";
import { MetricsView } from "@/components/views/MetricsView";
import { MissionView } from "@/components/views/MissionView";
import { PlansView } from "@/components/views/PlansView";
import { ValidationView } from "@/components/views/ValidationView";

function isTab(value: string | null): value is ProjectTab {
  return PROJECT_TABS.some((tab) => tab.id === value);
}

interface ProjectPageProps {
  projectName?: string;
}

export default function ProjectPage({ projectName }: ProjectPageProps = {}) {
  const pathname = usePathname();
  const name =
    projectName ?? decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""));
  const [activeTab, setActiveTabState] = useState<ProjectTab>("kanban");

  useEffect(() => {
    function syncTabFromUrl() {
      const tabParam = new URLSearchParams(window.location.search).get("tab");
      setActiveTabState(isTab(tabParam) ? tabParam : "kanban");
    }

    syncTabFromUrl();
    window.addEventListener("popstate", syncTabFromUrl);
    return () => window.removeEventListener("popstate", syncTabFromUrl);
  }, []);

  const setActiveTab = useCallback((tab: ProjectTab) => {
    setActiveTabState(tab);
    const url = new URL(window.location.href);
    if (tab === "kanban") url.searchParams.delete("tab");
    else url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString());
  }, []);

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)]">
      <SecondaryTabsPortal>
        <ProjectViewTabs active={activeTab} onChange={setActiveTab} />
      </SecondaryTabsPortal>
      {activeTab === "kanban" && <KanbanView sessionName={name} />}
      {activeTab === "mission" && <MissionView sessionName={name} />}
      {activeTab === "diffs" && <DiffsView sessionName={name} />}
      {activeTab === "plans" && <PlansView sessionName={name} />}
      {activeTab === "validation" && <ValidationView sessionName={name} />}
      {activeTab === "metrics" && <MetricsView sessionName={name} />}
      {activeTab === "activity" && <ActivityView sessionName={name} />}
    </div>
  );
}
