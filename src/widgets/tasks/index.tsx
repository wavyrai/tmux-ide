import "@opentui/solid/runtime-plugin-support";
import { parseArgs } from "node:util";
import { render, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, onMount, onCleanup, Switch, Match } from "solid-js";
import { createTheme, type RGBA as RGBAType } from "../lib/theme.ts";
import { watchDirectory } from "../lib/watcher.ts";
import { loadTasks, ensureTasksDir, getTasksDir, type Task } from "./task-model.ts";
import { TaskList } from "./task-list.tsx";
import { TaskDetail } from "./task-detail.tsx";
import { TaskForm } from "./task-form.tsx";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    target: { type: "string" },
    theme: { type: "string" },
  },
});

const session = values.session ?? "";
const dir = values.dir ?? process.cwd();
const targetTitle = values.target ?? null;
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

type View =
  | { kind: "list" }
  | { kind: "detail"; task: Task }
  | { kind: "form"; mode: "create" | "edit"; task?: Task };

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();
    const [tasks, setTasks] = createSignal(loadTasks(dir));
    const [view, setView] = createSignal<View>({ kind: "list" });

    function reload() {
      setTasks(loadTasks(dir));
      // If viewing a task detail, refresh it
      const v = view();
      if (v.kind === "detail") {
        const fresh = loadTasks(dir).find((t) => t.id === v.task.id);
        if (fresh) setView({ kind: "detail", task: fresh });
      }
    }

    // File watcher on .tasks/
    let stopWatch: (() => Promise<void>) | null = null;
    onMount(async () => {
      ensureTasksDir(dir);
      try {
        stopWatch = await watchDirectory(getTasksDir(dir), reload, {
          debounceMs: 300,
          ignore: [],
        });
      } catch {
        /* watcher unavailable */
      }
    });
    onCleanup(async () => {
      await stopWatch?.();
    });

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <Switch>
          <Match when={view().kind === "list"}>
            <TaskList
              tasks={tasks()}
              onSelect={(task) => setView({ kind: "detail", task })}
              onNew={() => setView({ kind: "form", mode: "create" })}
              onQuit={() => process.exit(0)}
              theme={theme}
            />
          </Match>
          <Match when={view().kind === "detail"}>
            <TaskDetail
              task={(view() as Extract<View, { kind: "detail" }>).task}
              allTasks={tasks()}
              session={session}
              dir={dir}
              target={targetTitle}
              onBack={() => setView({ kind: "list" })}
              onEdit={(task) => setView({ kind: "form", mode: "edit", task })}
              onTaskUpdate={reload}
              theme={theme}
            />
          </Match>
          <Match when={view().kind === "form"}>
            <TaskForm
              mode={(view() as Extract<View, { kind: "form" }>).mode}
              task={(view() as Extract<View, { kind: "form" }>).task}
              dir={dir}
              onSave={(task) => {
                reload();
                setView({ kind: "detail", task });
              }}
              onCancel={() => {
                const v = view();
                if (v.kind === "form" && v.mode === "edit" && (v as any).task) {
                  setView({ kind: "detail", task: (v as any).task });
                } else {
                  setView({ kind: "list" });
                }
              }}
              theme={theme}
            />
          </Match>
        </Switch>
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
