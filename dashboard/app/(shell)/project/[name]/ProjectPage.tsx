"use client";

import { usePathname } from "next/navigation";
import { ActivityView } from "@/components/views/ActivityView";
import { DiffsView } from "@/components/views/DiffsView";
import { KanbanView } from "@/components/views/KanbanView";
import { MetricsView } from "@/components/views/MetricsView";
import { MissionView } from "@/components/views/MissionView";
import { PlansView } from "@/components/views/PlansView";
import { ValidationView } from "@/components/views/ValidationView";
import { isSessions, useNavigation, type ProjectTab } from "@/lib/navigation";

interface ProjectPageProps {
  projectName?: string;
}

/**
 * ProjectPage — renders the active project view based on NavigationState.
 *
 * `activeTab` is no longer owned here — it lives in NavigationState. The
 * ProjectViewTabs strip rendered by AppShell dispatches navigation
 * changes; this component just reads `nav.tab` and renders the right
 * view. Same with the project name: when the route matches a project,
 * NavigationState carries the session name and we hand that to each view.
 */
export default function ProjectPage({ projectName }: ProjectPageProps = {}) {
  const pathname = usePathname();
  const nav = useNavigation();
  const fallbackName =
    projectName ??
    decodeURIComponent(pathname.replace(/^\/project\//, "").replace(/\/$/, ""));
  const name = isSessions(nav) && nav.sessionName ? nav.sessionName : fallbackName;
  const activeTab: ProjectTab = isSessions(nav) ? (nav.tab ?? "kanban") : "kanban";

  return (
    <div className="flex flex-1 min-h-0 flex-col bg-[var(--bg)]">
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
