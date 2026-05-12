"use client";

import { CheckCircle2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import {
  AgentActivityRail,
  AgentDetailDialog,
  EventStream,
  HeroStrip,
  KpiStrip,
  type MissionKpis,
  MilestoneLadder,
  MissionEditDialog,
} from "./index";
import { parseElapsed, percent } from "./utils";
import { MissionTreeNavigator } from "./MissionTreeNavigator";
import {
  Button,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  SkeletonCard,
  SkeletonText,
  SurfaceCard,
} from "@/components/ui";
import { MissionControlBridge } from "@/components/mission-control-bridge";
import { clearMission, planComplete, setMission } from "@/lib/api";
import { NavigatorPortal } from "@/lib/useNavigatorSlot";
import { useSessionStream } from "@/lib/useSessionStream";
import { useToasts } from "@/lib/useToasts";
import type { AgentDetail, Task } from "@/lib/types";

interface MissionViewProps {
  sessionName: string;
}

export function MissionView({ sessionName }: MissionViewProps) {
  // Feature flag: `?missionControl=solid` swaps the React composite for
  // the Solid widget. Identical data flow (useSessionStream → snapshot)
  // and identical handlers (route to kanban / activity); the widget side
  // is a pure renderer. Default keeps the React tree for fallback.
  const searchParams = useSearchParams();
  if (searchParams?.get("missionControl") === "solid") {
    return (
      <Panel variant="grow" testId="mission-view">
        <MissionControlBridge sessionName={sessionName} />
      </Panel>
    );
  }
  return <MissionViewReact sessionName={sessionName} />;
}

function MissionViewReact({ sessionName }: MissionViewProps) {
  const { snapshot } = useSessionStream(sessionName);
  const { push } = useToasts();
  const [editOpen, setEditOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [agentDialog, setAgentDialog] = useState<AgentDetail | null>(null);
  const [planning, setPlanning] = useState(false);

  const mission = snapshot?.mission ?? null;
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot?.agents]);
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot?.tasks]);
  const events = snapshot?.events ?? [];
  const milestones = useMemo(() => {
    const rows = snapshot?.milestones ?? mission?.mission.milestones ?? [];
    return [...rows].sort((a, b) => a.order - b.order);
  }, [snapshot?.milestones, mission?.mission.milestones]);

  const tasksByMilestone = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      const id = task.milestone;
      if (!id) continue;
      const list = map.get(id) ?? [];
      list.push(task);
      map.set(id, list);
    }
    return map;
  }, [tasks]);

  const kpis = useMemo<MissionKpis>(() => {
    const agentsTotal = agents.length;
    const agentsActive = agents.filter((a) => a.isBusy).length;
    const tasksTotal = tasks.length;
    const tasksDone = tasks.filter((t) => t.status === "done").length;
    const runtimeMs = agents.reduce((sum, a) => sum + parseElapsed(a.elapsed), 0);

    let estimatedCompletion: string | null = null;
    if (tasksTotal > 0 && tasksDone > 0 && tasksDone < tasksTotal && runtimeMs > 0) {
      const remaining = tasksTotal - tasksDone;
      const avg = runtimeMs / tasksDone;
      const eta = remaining * avg;
      const date = new Date(Date.now() + eta);
      estimatedCompletion = date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } else if (tasksTotal > 0 && tasksDone === tasksTotal) {
      estimatedCompletion = "complete";
    }

    return { agentsActive, agentsTotal, tasksDone, tasksTotal, runtimeMs, estimatedCompletion };
  }, [agents, tasks]);

  const validationByMilestone = useMemo(() => {
    const map = new Map<string, { passed: boolean }>();
    for (const m of milestones) {
      map.set(m.id, { passed: m.status !== "validating" });
    }
    return map;
  }, [milestones]);

  const handleTaskClick = useCallback((task: Task) => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", "kanban");
    url.searchParams.set("task", task.id);
    window.history.replaceState(null, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const handleEditSubmit = useCallback(
    async (fields: { title: string; description: string; branch: string | null }) => {
      const result = await setMission(sessionName, fields);
      if (!result.ok) {
        push({
          kind: "error",
          title: "Failed to save mission",
          body: result.error ?? "Unknown error",
        });
      } else {
        push({ kind: "success", title: "Mission updated", durationMs: 1600 });
      }
    },
    [push, sessionName],
  );

  const handleTitleSave = useCallback(
    async (title: string) => {
      if (!mission) return;
      const result = await setMission(sessionName, {
        title,
        description: mission.mission.description,
        branch: mission.mission.branch,
      });
      if (!result.ok) {
        push({
          kind: "error",
          title: "Failed to rename",
          body: result.error ?? "Unknown error",
        });
      }
    },
    [mission, push, sessionName],
  );

  const handlePlanComplete = useCallback(async () => {
    setPlanning(true);
    const result = await planComplete(sessionName);
    setPlanning(false);
    if (!result.ok) {
      push({
        kind: "error",
        title: "Plan complete failed",
        body: result.error ?? "Unknown error",
      });
    } else {
      push({ kind: "success", title: "Mission moved to active", durationMs: 1600 });
    }
  }, [push, sessionName]);

  const handleClear = useCallback(async () => {
    setMoreOpen(false);
    const result = await clearMission(sessionName);
    if (!result.ok) {
      push({
        kind: "error",
        title: "Failed to clear mission",
        body: result.error ?? "Unknown error",
      });
    } else {
      push({ kind: "success", title: "Mission cleared", durationMs: 1600 });
    }
  }, [push, sessionName]);

  // Phase Z: NavigatorPortal is a no-op shim now. Mission navigation
  // lives in AppSidebar's project tree (Mission section with milestones).
  // If we ever bring back an inline mission tree column, render it as
  // an aside next to the main content here.
  const navigator: ReactNode = null;
  void MissionTreeNavigator;
  void NavigatorPortal;

  if (!snapshot) {
    return (
      <Panel testId="mission-view">
        <PanelHeader title="Mission" />
        <PanelBody className="space-y-4 p-4">
          <SkeletonCard />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <SkeletonText lines={4} />
          <Skeleton h="h-32" />
        </PanelBody>
        {navigator}
      </Panel>
    );
  }

  if (!mission) {
    return (
      <Panel testId="mission-view">
        <PanelHeader title="Mission" />
        <PanelBody className="flex items-center justify-center p-8 text-center">
          <SurfaceCard padded="md" className="max-w-md p-5">
            <EmptyState
              title="No active mission"
              body="Set a mission to connect goals, milestones, and validation into one project narrative."
              action={
                <code className="inline-flex rounded-md bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--fg-secondary)]">
                  tmux-ide mission set &lt;title&gt;
                </code>
              }
            />
          </SurfaceCard>
        </PanelBody>
        {navigator}
      </Panel>
    );
  }

  const status = mission.mission.status;
  const validation = mission.validationSummary;
  const validationPercent = percent(validation.passing, validation.total);

  return (
    <Panel variant="grow" testId="mission-view">
      <PanelHeader
        title={mission.mission.title}
        subtitle={`${validation.passing}/${validation.total} validations passing · ${validationPercent}%`}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditOpen(true)}
              data-testid="mission-action-edit"
            >
              <Pencil aria-hidden="true" size={13} /> Edit
            </Button>
            {status === "planning" && (
              <Button
                variant="outline"
                size="sm"
                onClick={handlePlanComplete}
                isPending={planning}
                data-testid="mission-action-plan-complete"
              >
                <CheckCircle2 aria-hidden="true" size={13} /> Plan complete
              </Button>
            )}
            <div className="relative">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
                data-testid="mission-action-more"
              >
                <MoreHorizontal aria-hidden="true" size={14} />
              </Button>
              {moreOpen && (
                <div
                  role="menu"
                  data-testid="mission-action-more-menu"
                  className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--bg-strong)] py-1 shadow-2xl"
                  onMouseLeave={() => setMoreOpen(false)}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleClear}
                    data-testid="mission-action-clear"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[var(--fg-secondary)] hover-only:hover:bg-[var(--surface-hover)] hover-only:hover:text-[var(--red)]"
                  >
                    <Trash2 aria-hidden="true" size={12} /> Clear mission
                  </button>
                </div>
              )}
            </div>
          </>
        }
      />

      <PanelBody className="space-y-4 p-4">
        <HeroStrip
          title={mission.mission.title}
          description={mission.mission.description}
          status={status}
          branch={mission.mission.branch}
          created={(mission.mission as { created?: string | null }).created}
          updated={(mission.mission as { updated?: string | null }).updated}
          onTitleSave={handleTitleSave}
          onEditDescription={() => setEditOpen(true)}
        />

        <KpiStrip kpis={kpis} onAgentsClick={() => agents[0] && setAgentDialog(agents[0])} />

        <MilestoneLadder
          milestones={milestones}
          tasksByMilestone={tasksByMilestone}
          onTaskClick={handleTaskClick}
          validationByMilestone={validationByMilestone}
        />

        <AgentActivityRail agents={agents} onAgentClick={(a) => setAgentDialog(a)} />

        <EventStream
          events={events}
          limit={20}
          onShowAll={() => {
            const url = new URL(window.location.href);
            url.searchParams.set("tab", "activity");
            window.history.replaceState(null, "", url.toString());
            window.dispatchEvent(new PopStateEvent("popstate"));
          }}
        />
      </PanelBody>

      <MissionEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initialTitle={mission.mission.title}
        initialDescription={mission.mission.description}
        initialBranch={mission.mission.branch}
        onSubmit={handleEditSubmit}
      />

      <AgentDetailDialog
        agent={agentDialog}
        onOpenChange={(open) => {
          if (!open) setAgentDialog(null);
        }}
      />

      {navigator}
    </Panel>
  );
}
