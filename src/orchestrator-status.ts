import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionName, readConfig } from "./lib/yaml-io.ts";
import { getSessionState } from "./lib/tmux.ts";
import { loadTasks, loadMission } from "./lib/task-store.ts";
import { readEvents } from "./lib/event-log.ts";
import { listSessionPanes } from "./widgets/lib/pane-comms.ts";
import { isAgentPane, isAgentBusy, agentIdentifier } from "./lib/orchestrator.ts";

function formatElapsed(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${(ms / 3600000).toFixed(1)}h ago`;
}

export async function orchestratorStatus(
  targetDir: string | undefined,
  { json }: { json?: boolean } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");
  const { name: session } = getSessionName(dir);

  // Read config
  let orchConfig: {
    autoDispatch: boolean;
    dispatchMode: string;
    pollInterval: number;
    stallTimeout: number;
    maxConcurrentAgents: number;
    worktreeRoot: string;
    masterPane: string | null;
    cleanupOnDone: boolean;
  } | null = null;

  try {
    const { config } = readConfig(dir);
    const orch = config.orchestrator;
    if (orch) {
      orchConfig = {
        autoDispatch: orch.auto_dispatch ?? true,
        dispatchMode: orch.dispatch_mode ?? "tasks",
        pollInterval: orch.poll_interval ?? 5000,
        stallTimeout: orch.stall_timeout ?? 300000,
        maxConcurrentAgents: orch.max_concurrent_agents ?? 10,
        worktreeRoot: orch.worktree_root ?? ".worktrees/",
        masterPane: orch.master_pane ?? null,
        cleanupOnDone: orch.cleanup_on_done ?? false,
      };
    }
  } catch {
    // No config or unreadable
  }

  // Check if session is running
  const state = getSessionState(session);
  const running = state.running && orchConfig?.autoDispatch !== undefined;

  // Read persisted orchestrator state
  const statePath = join(dir, ".tasks", "orchestrator-state.json");
  let claimedTasks: string[] = [];
  let taskClaimTimes: Record<string, number> = {};

  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, "utf-8"));
      claimedTasks = data.claimedTasks ?? [];
      taskClaimTimes = data.taskClaimTimes ?? {};
    } catch {
      // Corrupted state
    }
  }

  // Load tasks, panes
  const tasks = loadTasks(dir);
  const mission = loadMission(dir);

  // Agent info from tmux panes
  const agents: Array<{
    name: string;
    paneId: string;
    state: "busy" | "idle";
    currentTask: { id: string; title: string; elapsed: string } | null;
  }> = [];

  if (state.running) {
    const panes = listSessionPanes(session);
    const agentPanes = panes.filter((p) => isAgentPane(p));

    for (const pane of agentPanes) {
      const name = agentIdentifier(pane);
      const busy = isAgentBusy(pane);
      const assignedTask = tasks.find((t) => t.status === "in-progress" && t.assignee === name);

      let currentTask: { id: string; title: string; elapsed: string } | null = null;
      if (assignedTask) {
        const claimTime = taskClaimTimes[assignedTask.id];
        const elapsed = claimTime
          ? formatElapsed(Date.now() - claimTime)
          : formatElapsed(Date.now() - new Date(assignedTask.updated).getTime());
        currentTask = { id: assignedTask.id, title: assignedTask.title, elapsed };
      }

      agents.push({
        name,
        paneId: pane.id,
        state: busy ? "busy" : "idle",
        currentTask,
      });
    }
  }

  // Categorize tasks
  const inProgressTasks = tasks
    .filter((t) => t.status === "in-progress")
    .map((t) => {
      const claimTime = taskClaimTimes[t.id];
      const elapsed = claimTime
        ? formatElapsed(Date.now() - claimTime)
        : formatElapsed(Date.now() - new Date(t.updated).getTime());
      return { id: t.id, title: t.title, assignee: t.assignee ?? "unassigned", elapsed };
    });

  const doneTaskIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const pendingTasks = tasks
    .filter((t) => t.status === "todo")
    .sort((a, b) => a.priority - b.priority)
    .map((t) => {
      const blockedBy = t.depends_on.filter((dep) => !doneTaskIds.has(dep));
      return {
        id: t.id,
        title: t.title,
        priority: t.priority,
        blocked: blockedBy.length > 0,
        blockedBy: blockedBy.length > 0 ? blockedBy : undefined,
      };
    });

  const recentlyDone = tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
    .slice(0, 5)
    .map((t) => ({ id: t.id, title: t.title, completedAt: t.updated }));

  // Recent events
  const allEvents = readEvents(dir);
  const recentEvents = allEvents.slice(-10).reverse();

  const data = {
    running,
    config: orchConfig,
    agents,
    tasks: { inProgress: inProgressTasks, pending: pendingTasks, recentlyDone },
    claims: { count: claimedTasks.length, taskIds: claimedTasks },
    recentEvents,
  };

  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Human-readable output
  const noColor = "NO_COLOR" in process.env;
  const bold = (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
  const dim = (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);
  const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[39m`);
  const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[39m`);

  console.log(`${bold("Orchestrator:")} ${running ? green("running") : dim("stopped")}`);

  if (orchConfig) {
    const stallMin = Math.round(orchConfig.stallTimeout / 60000);
    console.log(
      `  Poll: ${orchConfig.pollInterval}ms | Stall: ${stallMin}m | Mode: ${orchConfig.dispatchMode} | Auto-dispatch: ${orchConfig.autoDispatch ? "on" : "off"}`,
    );
    console.log(
      `  Max concurrent: ${orchConfig.maxConcurrentAgents} | Cleanup: ${orchConfig.cleanupOnDone ? "on" : "off"}`,
    );
  }

  if (mission) {
    console.log(`\n${bold("Mission:")} ${mission.title}`);
  }

  // Agents
  const busyCount = agents.filter((a) => a.state === "busy").length;
  console.log(`\n${bold("Agents")} (${busyCount} busy / ${agents.length} total):`);
  if (agents.length === 0) {
    console.log(`  ${dim("No agents detected")}`);
  }
  for (const agent of agents) {
    const stateLabel = agent.state === "busy" ? yellow("busy") : green("idle");
    const taskLabel = agent.currentTask
      ? ` -> ${agent.currentTask.id} "${agent.currentTask.title}" (${agent.currentTask.elapsed})`
      : "";
    console.log(`  ${agent.name.padEnd(12)} ${agent.paneId.padEnd(5)} ${stateLabel}${taskLabel}`);
  }

  // In-progress
  if (inProgressTasks.length > 0) {
    console.log(`\n${bold("In-progress")} (${inProgressTasks.length}):`);
    for (const t of inProgressTasks) {
      console.log(`  ${t.id}  "${t.title}"  @${t.assignee}  ${dim(t.elapsed)}`);
    }
  }

  // Pending
  if (pendingTasks.length > 0) {
    console.log(`\n${bold("Pending")} (${pendingTasks.length}):`);
    for (const t of pendingTasks.slice(0, 10)) {
      const blocked = t.blocked ? dim(` (blocked by ${t.blockedBy!.join(", ")})`) : "";
      console.log(`  ${t.id}  "${t.title}"  P${t.priority}${blocked}`);
    }
    if (pendingTasks.length > 10) {
      console.log(`  ${dim(`... and ${pendingTasks.length - 10} more`)}`);
    }
  }

  // Recent events
  if (recentEvents.length > 0) {
    console.log(`\n${bold("Recent Events")}:`);
    for (const evt of recentEvents) {
      console.log(`  ${dim(formatRelative(evt.timestamp))}  ${evt.type.padEnd(15)} ${evt.message}`);
    }
  }
}
