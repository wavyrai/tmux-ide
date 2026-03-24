import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, onCleanup, For, Show } from "solid-js";
import { createTheme } from "../lib/theme.ts";
import { loadAccounting, formatDuration, type AgentAccounting } from "../../lib/token-tracker.ts";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    theme: { type: "string" },
  },
});

const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface AgentRow {
  name: string;
  data: AgentAccounting;
  avgMs: number;
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();

    const [accounting, setAccounting] = createSignal(loadAccounting(dir));
    const [selectedRow, setSelectedRow] = createSignal(-1);
    const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

    // Poll every 5 seconds
    const interval = setInterval(() => {
      setAccounting(loadAccounting(dir));
    }, 5000);

    onCleanup(() => clearInterval(interval));

    const agentRows = createMemo((): AgentRow[] => {
      const agents = accounting().agents;
      return Object.entries(agents)
        .map(([name, data]) => ({
          name,
          data,
          avgMs: data.taskCount > 0 ? data.totalTimeMs / data.taskCount : 0,
        }))
        .sort((a, b) => b.data.totalTimeMs - a.data.totalTimeMs);
    });

    const totalTime = createMemo(() => agentRows().reduce((sum, r) => sum + r.data.totalTimeMs, 0));

    const totalTasks = createMemo(() => agentRows().reduce((sum, r) => sum + r.data.taskCount, 0));

    const sessionElapsed = createMemo(() => {
      const start = new Date(accounting().sessionStart).getTime();
      return Date.now() - start;
    });

    useKeyboard((evt) => {
      setInputMode("keyboard");
      if (evt.name === "up" || evt.name === "k") {
        setSelectedRow((i) => Math.max(0, i - 1));
        evt.preventDefault();
      } else if (evt.name === "down" || evt.name === "j") {
        setSelectedRow((i) => Math.min(agentRows().length - 1, i + 1));
        evt.preventDefault();
      } else if (evt.name === "r") {
        setAccounting(loadAccounting(dir));
        evt.preventDefault();
      } else if (evt.name === "q") {
        process.exit(0);
      }
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        {/* Header */}
        <box flexShrink={0} paddingLeft={1} paddingBottom={1}>
          <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
            Session Costs
          </text>
          <box flexDirection="row" gap={2}>
            <text fg={toRGBA(theme.fgMuted)}>Elapsed: {formatDuration(sessionElapsed())}</text>
            <text fg={toRGBA(theme.fgMuted)}>Agent time: {formatDuration(totalTime())}</text>
            <text fg={toRGBA(theme.fgMuted)}>Tasks: {totalTasks()}</text>
          </box>
        </box>

        {/* Separator */}
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(dimensions().width)}
          </text>
        </box>

        {/* Agent table */}
        <scrollbox flexGrow={1}>
          <Show
            when={agentRows().length > 0}
            fallback={
              <box paddingLeft={1} paddingTop={1}>
                <text fg={toRGBA(theme.fgMuted)}>No task activity recorded yet.</text>
              </box>
            }
          >
            {/* Column headers */}
            <box flexDirection="row" gap={2} paddingLeft={1} paddingTop={1}>
              <text
                fg={toRGBA(theme.fgMuted)}
                attributes={TextAttributes.BOLD}
                width={20}
                wrapMode="none"
              >
                Agent
              </text>
              <text
                fg={toRGBA(theme.fgMuted)}
                attributes={TextAttributes.BOLD}
                width={10}
                wrapMode="none"
              >
                Tasks
              </text>
              <text
                fg={toRGBA(theme.fgMuted)}
                attributes={TextAttributes.BOLD}
                width={12}
                wrapMode="none"
              >
                Total Time
              </text>
              <text
                fg={toRGBA(theme.fgMuted)}
                attributes={TextAttributes.BOLD}
                width={12}
                wrapMode="none"
              >
                Avg/Task
              </text>
            </box>

            {/* Agent rows */}
            <For each={agentRows()}>
              {(row, index) => {
                const isSelected = createMemo(() => index() === selectedRow());
                return (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    backgroundColor={isSelected() ? toRGBA(theme.selected) : undefined}
                    onMouseMove={() => {
                      setInputMode("mouse");
                      setSelectedRow(index());
                    }}
                    onMouseDown={() => setSelectedRow(index())}
                  >
                    <text
                      fg={toRGBA(isSelected() ? theme.selectedText : theme.fg)}
                      width={20}
                      wrapMode="none"
                    >
                      {row.name}
                    </text>
                    <text fg={toRGBA(theme.fgMuted)} width={10} wrapMode="none">
                      {String(row.data.taskCount)}
                    </text>
                    <text fg={toRGBA(theme.gitAdded)} width={12} wrapMode="none">
                      {formatDuration(row.data.totalTimeMs)}
                    </text>
                    <text fg={toRGBA(theme.fgMuted)} width={12} wrapMode="none">
                      {row.data.taskCount > 0 ? formatDuration(row.avgMs) : "-"}
                    </text>
                  </box>
                );
              }}
            </For>
          </Show>
        </scrollbox>

        {/* Footer */}
        <box flexShrink={0} paddingLeft={1} paddingTop={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
            ↑↓:nav
          </text>
          <text
            fg={toRGBA(theme.fgMuted)}
            wrapMode="none"
            onMouseUp={() => setAccounting(loadAccounting(dir))}
          >
            r:refresh
          </text>
          <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
            q:quit
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
