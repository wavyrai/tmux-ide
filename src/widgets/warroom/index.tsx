import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, onCleanup, For } from "solid-js";
import { createTheme } from "../lib/theme.ts";
import { listSessionPanes, type PaneInfo } from "../lib/pane-comms.ts";
import { MissionHeader } from "./mission-header.tsx";
import { GoalSection } from "./goal-section.tsx";
import { type AgentInfo } from "./agent-card.tsx";
import { ActivityFeed, formatElapsedShort, type ActivityEntry } from "./activity-feed.tsx";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

// --- Data loaders ---

interface Mission {
  title: string;
  description: string;
}

interface Goal {
  id: string;
  title: string;
  status: string;
  priority: number;
}

interface Task {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  goal: string | null;
  priority: number;
  updated: string;
}

function loadMission(): Mission | null {
  const path = join(dir, ".tasks", "mission.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function loadGoals(): Goal[] {
  const goalsDir = join(dir, ".tasks", "goals");
  if (!existsSync(goalsDir)) return [];
  return readdirSync(goalsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(goalsDir, f), "utf-8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Goal[];
}

function loadTasks(): Task[] {
  // Try nested .tasks/tasks/ first (CLI format), fall back to flat .tasks/ (widget format)
  const nestedDir = join(dir, ".tasks", "tasks");
  const flatDir = join(dir, ".tasks");
  const tasksDir = existsSync(nestedDir) ? nestedDir : flatDir;
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json") && f !== "mission.json")
    .sort()
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(tasksDir, f), "utf-8"));
        if (data.id && data.title && data.status) return data;
        return null;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Task[];
}

// --- Agent matching ---

function formatElapsed(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function buildAgentInfos(panes: PaneInfo[], tasks: Task[]): AgentInfo[] {
  const agentPanes = panes.filter(
    (p) =>
      p.currentCommand === "claude" ||
      p.currentCommand === "codex" ||
      p.title.toLowerCase().includes("claude") ||
      p.title.toLowerCase().includes("agent"),
  );

  return agentPanes.map((pane) => {
    const assignedTask = tasks.find((t) => t.assignee === pane.title && t.status === "in-progress");
    return {
      paneTitle: pane.title,
      isBusy: pane.currentCommand === "claude" || pane.currentCommand === "codex",
      taskTitle: assignedTask?.title ?? null,
      elapsed: assignedTask ? formatElapsed(assignedTask.updated) : "",
    };
  });
}

// --- Activity detection ---

function detectChanges(prevTasks: Task[], currTasks: Task[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const now = Date.now();
  const prevMap = new Map(prevTasks.map((t) => [t.id, t]));
  const currMap = new Map(currTasks.map((t) => [t.id, t]));

  for (const [id, curr] of currMap) {
    const prev = prevMap.get(id);
    if (!prev) {
      entries.push({ time: "now", message: `New task: ${curr.title}`, timestamp: now });
    } else if (prev.status !== curr.status) {
      entries.push({
        time: "now",
        message: `Task ${id} → ${curr.status}`,
        timestamp: now,
      });
    } else if (prev.assignee !== curr.assignee && curr.assignee) {
      entries.push({
        time: "now",
        message: `${curr.assignee} claimed ${id}`,
        timestamp: now,
      });
    }
  }

  for (const [id] of prevMap) {
    if (!currMap.has(id)) {
      entries.push({ time: "now", message: `Task ${id} removed`, timestamp: now });
    }
  }

  return entries;
}

// --- Render ---

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();

    const [mission, setMission] = createSignal(loadMission());
    const [goals, setGoals] = createSignal(loadGoals());
    const [tasks, setTasks] = createSignal(loadTasks());
    const [panes, setPanes] = createSignal<PaneInfo[]>(session ? listSessionPanes(session) : []);
    const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
    const [selectedAgent, setSelectedAgent] = createSignal(0);

    // Poll every 2 seconds
    const interval = setInterval(() => {
      const prevTasks = tasks();
      setMission(loadMission());
      setGoals(loadGoals());
      const newTasks = loadTasks();
      setTasks(newTasks);
      if (session) setPanes(listSessionPanes(session));

      // Detect changes for activity feed
      const newEntries = detectChanges(prevTasks, newTasks);
      if (newEntries.length > 0) {
        setActivity((prev) => [...newEntries, ...prev].slice(0, 20));
      }

      // Update elapsed times on existing entries
      setActivity((prev) =>
        prev.map((e) => ({
          ...e,
          time: formatElapsedShort(e.timestamp),
        })),
      );
    }, 2000);

    onCleanup(() => clearInterval(interval));

    // Derived data
    const allAgents = createMemo(() => buildAgentInfos(panes(), tasks()));
    const doneTasks = createMemo(() => tasks().filter((t) => t.status === "done").length);

    // Group agents by goal
    const goalSections = createMemo(() => {
      const g = goals();
      const t = tasks();
      const agents = allAgents();

      return g.map((goal) => {
        const goalTasks = t.filter((tk) => tk.goal === goal.id);
        const goalAgents = agents.filter((a) =>
          goalTasks.some((tk) => tk.assignee === a.paneTitle && tk.status === "in-progress"),
        );
        return {
          goal,
          tasks: goalTasks,
          agents: goalAgents,
        };
      });
    });

    // Unassigned agents (not working on any goal's tasks)
    const unassignedAgents = createMemo(() => {
      const assigned = new Set(goalSections().flatMap((gs) => gs.agents.map((a) => a.paneTitle)));
      return allAgents().filter((a) => !assigned.has(a.paneTitle));
    });

    // Keyboard
    useKeyboard((evt) => {
      const totalAgents = allAgents().length;

      if (evt.name === "j" || evt.name === "down") {
        setSelectedAgent((i) => Math.min(totalAgents - 1, i + 1));
        evt.preventDefault();
      } else if (evt.name === "k" || evt.name === "up") {
        setSelectedAgent((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "return") {
        // Focus the selected agent's tmux pane
        const agent = allAgents()[selectedAgent()];
        if (agent && session) {
          const pane = panes().find((p) => p.title === agent.paneTitle);
          if (pane) {
            try {
              execFileSync("tmux", ["select-pane", "-t", pane.id], { stdio: "ignore" });
            } catch {
              /* ignore */
            }
          }
        }
        evt.preventDefault();
      } else if (evt.name === "r") {
        setMission(loadMission());
        setGoals(loadGoals());
        setTasks(loadTasks());
        if (session) setPanes(listSessionPanes(session));
        evt.preventDefault();
      } else if (evt.name === "q") {
        process.exit(0);
      }
    });

    // Track agent index across goal sections
    let agentGlobalIndex = 0;

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <MissionHeader
          title={mission()?.title ?? null}
          totalTasks={tasks().length}
          doneTasks={doneTasks()}
          agentCount={allAgents().length}
          theme={theme}
        />

        {/* Separator */}
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(dimensions().width)}
          </text>
        </box>

        {/* Goals + agents */}
        <scrollbox flexGrow={1}>
          <For each={goalSections()}>
            {(section) => {
              const startIdx = agentGlobalIndex;
              agentGlobalIndex += section.agents.length;
              return (
                <GoalSection
                  title={section.goal.title}
                  priority={section.goal.priority}
                  totalTasks={section.tasks.length}
                  doneTasks={section.tasks.filter((t) => t.status === "done").length}
                  agents={section.agents}
                  theme={theme}
                  selectedAgent={selectedAgent()}
                  agentStartIndex={startIdx}
                />
              );
            }}
          </For>

          {/* Unassigned agents */}
          <For each={unassignedAgents()}>
            {(agent) => {
              const idx = agentGlobalIndex++;
              return (
                <box paddingLeft={1} paddingTop={1}>
                  <box
                    flexDirection="row"
                    gap={1}
                    backgroundColor={
                      idx === selectedAgent() ? toRGBA(theme.selected) : RGBA.fromInts(0, 0, 0, 0)
                    }
                  >
                    <text fg={toRGBA(agent.isBusy ? theme.gitModified : theme.fgMuted)}>
                      {agent.isBusy ? "*" : "o"}
                    </text>
                    <text fg={toRGBA(idx === selectedAgent() ? theme.selectedText : theme.fg)}>
                      {agent.paneTitle}
                    </text>
                    <text fg={toRGBA(theme.fgMuted)}>{agent.taskTitle ?? "idle"}</text>
                  </box>
                </box>
              );
            }}
          </For>
        </scrollbox>

        {/* Separator */}
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(dimensions().width)}
          </text>
        </box>

        {/* Activity feed */}
        <ActivityFeed entries={activity()} theme={theme} />

        {/* Footer */}
        <box flexShrink={0} paddingLeft={1} paddingTop={1}>
          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
            ↑↓:agents ⏎:focus r:refresh q:quit
          </text>
        </box>
      </box>
    );
  },
  {
    targetFps: 30,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
