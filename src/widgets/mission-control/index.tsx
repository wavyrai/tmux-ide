import "@opentui/solid/runtime-plugin-support";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { createSignal, createMemo, createEffect, onCleanup, Show, For } from "solid-js";
import { createTheme, type RGBA as RGBAType, type WidgetTheme } from "../lib/theme.ts";
import { listSessionPanes, sendCommand, type PaneInfo } from "../lib/pane-comms.ts";
import {
  loadMission,
  loadGoals,
  loadTasks,
  type Mission,
  type Goal,
  type Task,
} from "../../lib/task-store.ts";
import { readEvents, type OrchestratorEvent } from "../../lib/event-log.ts";

const { values } = parseArgs({
  options: { session: { type: "string" }, dir: { type: "string" }, theme: { type: "string" } },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

// --- Helpers ---

const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒✳|/\\-] /;

function isAgentPane(pane: PaneInfo): boolean {
  const cmd = pane.currentCommand?.toLowerCase() ?? "";
  return (
    cmd === "claude" ||
    cmd === "codex" ||
    pane.role === "lead" ||
    pane.role === "teammate" ||
    pane.title.includes("Claude Code") ||
    /^\d+\.\d+/.test(cmd)
  );
}

function fmtElapsed(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

interface AgentRow {
  name: string;
  paneId: string;
  busy: boolean;
  taskId: string | null;
  taskTitle: string | null;
  elapsed: string;
}

function buildAgents(panes: PaneInfo[], tasks: Task[]): AgentRow[] {
  return panes.filter(isAgentPane).map((pane) => {
    const name = pane.name ?? pane.title.replace(SPINNERS, "").trim();
    const task = tasks.find((t) => t.assignee === name && t.status === "in-progress");
    return {
      name: name.slice(0, 14),
      paneId: pane.id,
      busy: SPINNERS.test(pane.title),
      taskId: task?.id ?? null,
      taskTitle: task?.title ?? null,
      elapsed: task ? fmtElapsed(task.updated) : "",
    };
  });
}

const AGENT_TYPES = [
  { id: "claude", label: "Claude Code", command: "claude --dangerously-skip-permissions" },
  { id: "codex", label: "Codex CLI", command: "codex --full-auto" },
  { id: "cursor", label: "Cursor Agent", command: "cursor-agent" },
  { id: "shell", label: "Shell", command: "" },
];

type Tab = "agents" | "tasks" | "goals" | "activity";
const TABS: { id: Tab; key: string; label: string }[] = [
  { id: "agents", key: "1", label: "Agents" },
  { id: "tasks", key: "2", label: "Tasks" },
  { id: "goals", key: "3", label: "Goals" },
  { id: "activity", key: "4", label: "Activity" },
];

render(
  () => {
    const theme = createTheme(themeConfig);
    const dims = useTerminalDimensions();

    const [mission, setMission] = createSignal<Mission | null>(loadMission(dir));
    const [goals, setGoals] = createSignal<Goal[]>(loadGoals(dir));
    const [tasks, setTasks] = createSignal<Task[]>(loadTasks(dir));
    const [panes, setPanes] = createSignal<PaneInfo[]>(session ? listSessionPanes(session) : []);
    const [events, setEvents] = createSignal<OrchestratorEvent[]>([]);
    const [tab, setTab] = createSignal<Tab>("agents");
    const [sel, setSel] = createSignal(0);
    const [cmdMode, setCmdMode] = createSignal(false);
    const [cmdInput, setCmdInput] = createSignal("");
    const [addMenu, setAddMenu] = createSignal(false);
    const [addIdx, setAddIdx] = createSignal(0);
    let cmdInputRef: InputRenderable | undefined;

    // Auto-focus the command input when cmdMode activates
    createEffect(() => {
      if (cmdMode()) {
        setTimeout(() => cmdInputRef?.focus(), 50);
      }
    });

    const agents = createMemo(() => buildAgents(panes(), tasks()));
    const wipTasks = createMemo(() => tasks().filter((t) => t.status === "in-progress"));
    const todoTasks = createMemo(() =>
      tasks()
        .filter((t) => t.status === "todo")
        .sort((a, b) => a.priority - b.priority),
    );
    const recentDone = createMemo(() =>
      tasks()
        .filter((t) => t.status === "done")
        .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime())
        .slice(0, 10),
    );
    const busyCount = createMemo(() => agents().filter((a) => a.busy).length);
    const totalDone = createMemo(() => tasks().filter((t) => t.status === "done").length);

    const goalRows = createMemo(() =>
      goals().map((g) => {
        const gt = tasks().filter((t) => t.goal === g.id);
        const done = gt.filter((t) => t.status === "done").length;
        const wip = gt.filter((t) => t.status === "in-progress").length;
        const todo = gt.filter((t) => t.status === "todo").length;
        return { ...g, done, wip, todo, total: gt.length };
      }),
    );

    // Poll
    const poll = setInterval(() => {
      setMission(loadMission(dir));
      setGoals(loadGoals(dir));
      setTasks(loadTasks(dir));
      if (session) setPanes(listSessionPanes(session));
      setEvents(readEvents(dir).slice(-20).reverse());
    }, 2000);
    onCleanup(() => clearInterval(poll));

    // Actions
    function focusPane(paneId: string) {
      try {
        execFileSync("tmux", ["select-pane", "-t", paneId], { stdio: "ignore" });
      } catch {}
    }

    function addAgent(idx: number) {
      const type = AGENT_TYPES[idx];
      if (!type || !session) return;
      const n = `Agent ${agents().length + 1}`;
      try {
        const first = panes().find(isAgentPane);
        if (!first) return;
        const id = execFileSync(
          "tmux",
          ["split-window", "-h", "-t", first.id, "-P", "-F", "#{pane_id}"],
          { encoding: "utf-8", cwd: dir },
        ).trim();
        execFileSync("tmux", ["select-pane", "-t", id, "-T", n]);
        execFileSync("tmux", ["set-option", "-pqt", id, "@ide_role", "teammate"]);
        execFileSync("tmux", ["set-option", "-pqt", id, "@ide_name", n]);
        if (type.command) {
          execFileSync("tmux", [
            "send-keys",
            "-t",
            id,
            "-l",
            "--",
            type.command + ` --name "${n}"`,
          ]);
          execFileSync("tmux", ["send-keys", "-t", id, "Enter"]);
        }
      } catch {}
      setAddMenu(false);
    }

    function runCmd(input: string) {
      const parts = input.trim().split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);
      try {
        if ((cmd === "t" || cmd === "task") && args[0] === "create") {
          const title = args.slice(1).join(" ").trim();
          if (!title) return; // Don't submit without a title
          execFileSync("tmux-ide", ["task", "create", title], { cwd: dir });
        } else if ((cmd === "s" || cmd === "send") && args.length >= 2) {
          const p = panes().find(
            (p) => p.name === args[0] || p.title.toLowerCase().includes(args[0]!.toLowerCase()),
          );
          if (p) sendCommand(session, p.id, args.slice(1).join(" "));
        } else if (cmd === "a" || cmd === "add") {
          setAddMenu(true);
        } else if (cmd) {
          execFileSync("tmux-ide", [cmd, ...args], { cwd: dir, timeout: 5000 });
        }
      } catch {}
      setCmdInput("");
      setCmdMode(false);
    }

    // Keyboard
    useKeyboard((evt) => {
      if (addMenu()) {
        if (evt.name === "escape") {
          setAddMenu(false);
          evt.preventDefault();
        } else if (evt.name === "k" || evt.name === "up") {
          setAddIdx((i) => Math.max(0, i - 1));
          evt.preventDefault();
        } else if (evt.name === "j" || evt.name === "down") {
          setAddIdx((i) => Math.min(AGENT_TYPES.length - 1, i + 1));
          evt.preventDefault();
        } else if (evt.name === "return") {
          addAgent(addIdx());
          evt.preventDefault();
        }
        return;
      }
      if (cmdMode()) {
        if (evt.name === "escape") {
          setCmdMode(false);
          evt.preventDefault();
        } else if (evt.name === "return") {
          runCmd(cmdInput());
          evt.preventDefault();
        }
        return;
      }
      // Tab switching
      if (evt.name === "1") {
        setTab("agents");
        setSel(0);
        evt.preventDefault();
      } else if (evt.name === "2") {
        setTab("tasks");
        setSel(0);
        evt.preventDefault();
      } else if (evt.name === "3") {
        setTab("goals");
        setSel(0);
        evt.preventDefault();
      } else if (evt.name === "4") {
        setTab("activity");
        setSel(0);
        evt.preventDefault();
      } else if (evt.name === "tab") {
        const ids = TABS.map((t) => t.id);
        setTab(ids[(ids.indexOf(tab()) + 1) % ids.length]!);
        setSel(0);
        evt.preventDefault();
      } else if (evt.name === "a") {
        setAddMenu(true);
        evt.preventDefault();
      } else if (evt.name === "/" || evt.name === ":") {
        setCmdMode(true);
        evt.preventDefault();
      } else if (evt.name === "q") {
        process.exit(0);
      }
      // Navigation within tab
      else if (evt.name === "j" || evt.name === "down") {
        setSel((i) => i + 1);
        evt.preventDefault();
      } else if (evt.name === "k" || evt.name === "up") {
        setSel((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "return" && tab() === "agents") {
        const a = agents()[sel()];
        if (a) focusPane(a.paneId);
        evt.preventDefault();
      }
    });

    const w = () => dims().width;

    return (
      <box
        width={w()}
        height={dims().height}
        backgroundColor={toRGBA(theme.bg)}
        flexDirection="column"
      >
        {/* Header */}
        <box
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          flexDirection="row"
          justifyContent="space-between"
        >
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            {mission()?.title ?? "tmux-ide"}
          </text>
          <text fg={toRGBA(theme.fgMuted)}>
            {busyCount()}/{agents().length} busy · {todoTasks().length} todo · {totalDone()} done
          </text>
        </box>

        {/* Tabs */}
        <box flexShrink={0} paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <For each={TABS}>
            {(t) => {
              const active = () => tab() === t.id;
              return (
                <box
                  onMouseDown={() => {
                    setTab(t.id);
                    setSel(0);
                  }}
                >
                  <text
                    fg={toRGBA(active() ? theme.accent : theme.fgMuted)}
                    attributes={active() ? TextAttributes.BOLD | TextAttributes.UNDERLINE : 0}
                  >
                    {t.key}:{t.label}
                  </text>
                </box>
              );
            }}
          </For>
        </box>

        <box flexShrink={0} height={1} paddingLeft={1} paddingRight={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(Math.max(1, w() - 2))}
          </text>
        </box>

        {/* Content area — full width, one tab at a time */}
        <box flexGrow={1} paddingLeft={1} paddingRight={1}>
          {/* AGENTS TAB */}
          <Show when={tab() === "agents"}>
            <For each={agents()}>
              {(agent, i) => {
                const isSel = () => sel() === i();
                return (
                  <box
                    flexShrink={0}
                    backgroundColor={isSel() ? toRGBA(theme.selected) : undefined}
                    onMouseDown={() => {
                      setSel(i());
                      focusPane(agent.paneId);
                    }}
                  >
                    <box flexDirection="row" gap={2}>
                      <text fg={toRGBA(agent.busy ? theme.gitModified : theme.gitAdded)}>
                        {agent.busy ? "●" : "○"}
                      </text>
                      <text
                        fg={toRGBA(isSel() ? theme.accent : theme.fg)}
                        attributes={isSel() ? TextAttributes.BOLD : 0}
                        wrapMode="none"
                      >
                        {agent.name.padEnd(14)}
                      </text>
                      <text fg={toRGBA(agent.busy ? theme.fg : theme.fgMuted)} wrapMode="none">
                        {agent.busy ? "working" : "idle"}
                      </text>
                      <Show when={agent.taskTitle}>
                        <text fg={toRGBA(theme.fg)} wrapMode="none">
                          → {agent.taskId} "{agent.taskTitle!.slice(0, 30)}" ({agent.elapsed})
                        </text>
                      </Show>
                    </box>
                  </box>
                );
              }}
            </For>
            <box flexShrink={0} onMouseUp={() => setAddMenu(true)}>
              <text fg={toRGBA(theme.fgMuted)}>[+add agent]</text>
            </box>
          </Show>

          {/* TASKS TAB */}
          <Show when={tab() === "tasks"}>
            <Show when={wipTasks().length > 0}>
              <text fg={toRGBA(theme.gitModified)} attributes={TextAttributes.BOLD}>
                IN PROGRESS ({wipTasks().length})
              </text>
              <For each={wipTasks()}>
                {(t, i) => {
                  const isSel = () => sel() === i();
                  return (
                    <box
                      flexShrink={0}
                      backgroundColor={isSel() ? toRGBA(theme.selected) : undefined}
                      onMouseDown={() => setSel(i())}
                    >
                      <box flexDirection="row" gap={1}>
                        <text fg={toRGBA(theme.fg)} wrapMode="none">
                          {t.id}
                        </text>
                        <text fg={toRGBA(isSel() ? theme.accent : theme.fg)} wrapMode="none">
                          {t.title.slice(0, 45)}
                        </text>
                        <Show when={t.assignee}>
                          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                            @{t.assignee}
                          </text>
                        </Show>
                        <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                          {fmtElapsed(t.updated)}
                        </text>
                      </box>
                    </box>
                  );
                }}
              </For>
            </Show>
            <Show when={todoTasks().length > 0}>
              <box paddingTop={wipTasks().length > 0 ? 1 : 0}>
                <text fg={toRGBA(theme.fgMuted)} attributes={TextAttributes.BOLD}>
                  TODO ({todoTasks().length})
                </text>
              </box>
              <For each={todoTasks()}>
                {(t, i) => {
                  const idx = () => wipTasks().length + i();
                  const isSel = () => sel() === idx();
                  const blocked = () =>
                    t.depends_on.length > 0 &&
                    t.depends_on.some((d) => {
                      const dep = tasks().find((x) => x.id === d);
                      return dep && dep.status !== "done";
                    });
                  return (
                    <box
                      flexShrink={0}
                      backgroundColor={isSel() ? toRGBA(theme.selected) : undefined}
                      onMouseDown={() => setSel(idx())}
                    >
                      <box flexDirection="row" gap={1}>
                        <text
                          fg={toRGBA(
                            t.priority <= 1
                              ? theme.gitDeleted
                              : t.priority <= 2
                                ? theme.gitModified
                                : theme.fgMuted,
                          )}
                          wrapMode="none"
                        >
                          P{t.priority}
                        </text>
                        <text fg={toRGBA(isSel() ? theme.accent : theme.fg)} wrapMode="none">
                          {t.id}
                        </text>
                        <text fg={toRGBA(blocked() ? theme.fgMuted : theme.fg)} wrapMode="none">
                          {t.title.slice(0, 45)}
                        </text>
                        <Show when={blocked()}>
                          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                            (blocked)
                          </text>
                        </Show>
                      </box>
                    </box>
                  );
                }}
              </For>
            </Show>
            <Show when={recentDone().length > 0}>
              <box paddingTop={1}>
                <text fg={toRGBA(theme.gitAdded)} attributes={TextAttributes.BOLD}>
                  RECENTLY DONE
                </text>
              </box>
              <For each={recentDone()}>
                {(t) => (
                  <box flexShrink={0}>
                    <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                      ✓ {t.id} {t.title.slice(0, 40)} ({fmtElapsed(t.updated)} ago)
                    </text>
                  </box>
                )}
              </For>
            </Show>
            <box
              flexShrink={0}
              onMouseUp={() => {
                setCmdInput("t create ");
                setCmdMode(true);
              }}
              paddingTop={1}
            >
              <text fg={toRGBA(theme.fgMuted)}>[+create task]</text>
            </box>
          </Show>

          {/* GOALS TAB */}
          <Show when={tab() === "goals"}>
            <Show when={goalRows().length === 0}>
              <text fg={toRGBA(theme.fgMuted)}>No goals. Create one: /goal create "title"</text>
            </Show>
            <For each={goalRows()}>
              {(g, i) => {
                const isSel = () => sel() === i();
                const pct = () => (g.total > 0 ? Math.round((g.done / g.total) * 100) : 0);
                const barW = () => Math.max(10, Math.min(30, w() - 40));
                const filled = () => Math.round((pct() / 100) * barW());
                return (
                  <box
                    flexShrink={0}
                    paddingBottom={1}
                    backgroundColor={isSel() ? toRGBA(theme.selected) : undefined}
                    onMouseDown={() => setSel(i())}
                  >
                    <box flexDirection="row" gap={1}>
                      <text
                        fg={toRGBA(isSel() ? theme.accent : theme.fg)}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                      >
                        {g.id}
                      </text>
                      <text fg={toRGBA(isSel() ? theme.accent : theme.fg)} wrapMode="none">
                        {g.title}
                      </text>
                      <text
                        fg={toRGBA(g.status === "done" ? theme.gitAdded : theme.fgMuted)}
                        wrapMode="none"
                      >
                        ({g.status})
                      </text>
                    </box>
                    <box flexDirection="row" gap={1}>
                      <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                        {"  "}
                        {"█".repeat(filled())}
                        {"░".repeat(barW() - filled())} {pct()}%
                      </text>
                      <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                        {g.done}/{g.total} done · {g.wip} wip · {g.todo} todo
                      </text>
                    </box>
                  </box>
                );
              }}
            </For>
          </Show>

          {/* ACTIVITY TAB */}
          <Show when={tab() === "activity"}>
            <Show when={events().length === 0}>
              <text fg={toRGBA(theme.fgMuted)}>No recent events</text>
            </Show>
            <For each={events()}>
              {(evt, i) => {
                const isSel = () => sel() === i();
                const color = () =>
                  evt.type === "completion"
                    ? theme.gitAdded
                    : evt.type === "dispatch"
                      ? theme.accent
                      : evt.type === "error"
                        ? theme.gitDeleted
                        : evt.type === "stall"
                          ? theme.gitModified
                          : theme.fgMuted;
                return (
                  <box
                    flexShrink={0}
                    backgroundColor={isSel() ? toRGBA(theme.selected) : undefined}
                    onMouseDown={() => setSel(i())}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
                        {fmtElapsed(evt.timestamp).padStart(4)}
                      </text>
                      <text fg={toRGBA(color())} wrapMode="none" attributes={TextAttributes.BOLD}>
                        {evt.type.padEnd(12)}
                      </text>
                      <text fg={toRGBA(theme.fg)} wrapMode="none">
                        {evt.message.slice(0, w() - 25)}
                      </text>
                    </box>
                  </box>
                );
              }}
            </For>
          </Show>
        </box>

        {/* Add agent overlay */}
        <Show when={addMenu()}>
          <box flexShrink={0} paddingLeft={1}>
            <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
              Add agent:
            </text>
            <For each={AGENT_TYPES}>
              {(type, i) => (
                <box
                  flexShrink={0}
                  backgroundColor={addIdx() === i() ? toRGBA(theme.selected) : undefined}
                  onMouseDown={() => addAgent(i())}
                >
                  <text fg={toRGBA(addIdx() === i() ? theme.accent : theme.fg)}>
                    {addIdx() === i() ? "▸ " : "  "}
                    {type.label}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>

        {/* Command bar — always visible */}
        <box flexShrink={0} paddingLeft={1} paddingRight={1}>
          <box height={1}>
            <text fg={toRGBA(theme.border)} wrapMode="none">
              {"─".repeat(Math.max(1, w() - 2))}
            </text>
          </box>
          <box flexDirection="row" gap={1}>
            <text
              fg={toRGBA(cmdMode() ? theme.accent : theme.fgMuted)}
              attributes={cmdMode() ? TextAttributes.BOLD : 0}
            >
              {">"}
            </text>
            <input
              value={cmdInput()}
              placeholder="task create Fix bug, send Agent1 hello, goal create Auth..."
              onInput={(v: string) => {
                if (!cmdMode()) setCmdMode(true);
                setCmdInput(v);
              }}
              focusedBackgroundColor={toRGBA(theme.selected)}
              cursorColor={toRGBA(theme.accent)}
              focusedTextColor={toRGBA(theme.fg)}
              onMouseDown={() => setCmdMode(true)}
              ref={(r: InputRenderable) => {
                cmdInputRef = r;
              }}
            />
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={toRGBA(theme.fgMuted)}>Tab:switch 1-4:tabs a:agent Esc:cancel Enter:run</text>
          </box>
        </box>
      </box>
    );
  },
  { targetFps: 30, exitOnCtrlC: true, useKittyKeyboard: {}, autoFocus: false },
);
