import { createSignal, onMount } from "solid-js";
import { RGBA, TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createTask, updateTaskField, loadTasks, type Task } from "./task-model.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface TaskFormProps {
  mode: "create" | "edit";
  task?: Task;
  dir: string;
  onSave: (task: Task) => void;
  onCancel: () => void;
  theme: WidgetTheme;
}

export function TaskForm(props: TaskFormProps) {
  const [title, setTitle] = createSignal(props.task?.title ?? "");
  const [description, setDescription] = createSignal(props.task?.description ?? "");
  const [priority, setPriority] = createSignal(props.task?.priority ?? 2);
  const [activeField, setActiveField] = createSignal<"title" | "description">("title");

  let titleRef: InputRenderable | undefined;
  let descRef: InputRenderable | undefined;

  const theme = props.theme;

  onMount(() => {
    setTimeout(() => titleRef?.focus(), 50);
  });

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      props.onCancel();
      evt.preventDefault();
    } else if (evt.name === "tab") {
      if (activeField() === "title") {
        setActiveField("description");
        setTimeout(() => descRef?.focus(), 10);
      } else {
        setActiveField("title");
        setTimeout(() => titleRef?.focus(), 10);
      }
      evt.preventDefault();
    } else if (evt.ctrl && evt.name === "s") {
      save();
      evt.preventDefault();
    }
  });

  function save() {
    if (!title()) return;

    if (props.mode === "create") {
      const tasks = loadTasks(props.dir);
      const newTask = createTask(props.dir, tasks);
      updateTaskField(props.dir, newTask.id, {
        title: title(),
        description: description(),
        priority: priority(),
      });
      props.onSave({
        ...newTask,
        title: title(),
        description: description(),
        priority: priority(),
      });
    } else if (props.task) {
      updateTaskField(props.dir, props.task.id, {
        title: title(),
        description: description(),
        priority: priority(),
      });
      props.onSave({
        ...props.task,
        title: title(),
        description: description(),
        priority: priority(),
      });
    }
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={toRGBA(theme.fg)} attributes={TextAttributes.BOLD}>
          {props.mode === "create" ? "New Task" : "Edit Task"}
        </text>
        <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onCancel()}>
          Esc:cancel
        </text>
      </box>

      {/* Title field */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(activeField() === "title" ? theme.accent : theme.fgMuted)}>Title</text>
        <input
          value={title()}
          placeholder="What needs to be done?"
          onInput={(v: string) => setTitle(v)}
          focusedBackgroundColor={toRGBA(theme.selected)}
          cursorColor={toRGBA(theme.accent)}
          focusedTextColor={toRGBA(theme.fg)}
          onMouseDown={() => {
            setActiveField("title");
            setTimeout(() => titleRef?.focus(), 10);
          }}
          ref={(r: InputRenderable) => {
            titleRef = r;
          }}
        />
      </box>

      {/* Description field */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(activeField() === "description" ? theme.accent : theme.fgMuted)}>
          Description
        </text>
        <input
          value={description()}
          placeholder="Add details..."
          onInput={(v: string) => setDescription(v)}
          focusedBackgroundColor={toRGBA(theme.selected)}
          cursorColor={toRGBA(theme.accent)}
          focusedTextColor={toRGBA(theme.fg)}
          onMouseDown={() => {
            setActiveField("description");
            setTimeout(() => descRef?.focus(), 10);
          }}
          ref={(r: InputRenderable) => {
            descRef = r;
          }}
        />
      </box>

      {/* Priority selector */}
      <box flexShrink={0} paddingBottom={1}>
        <text fg={toRGBA(theme.fgMuted)}>Priority</text>
        <box flexDirection="row" gap={2} paddingTop={0}>
          <text
            fg={toRGBA(priority() === 1 ? theme.gitDeleted : theme.fgMuted)}
            onMouseUp={() => setPriority(1)}
          >
            {priority() === 1 ? "[***]" : " *** "}
          </text>
          <text
            fg={toRGBA(priority() === 2 ? theme.gitModified : theme.fgMuted)}
            onMouseUp={() => setPriority(2)}
          >
            {priority() === 2 ? "[** ]" : " **  "}
          </text>
          <text
            fg={toRGBA(priority() === 3 ? theme.accent : theme.fgMuted)}
            onMouseUp={() => setPriority(3)}
          >
            {priority() === 3 ? "[*  ]" : " *   "}
          </text>
          <text
            fg={toRGBA(priority() === 4 ? theme.fg : theme.fgMuted)}
            onMouseUp={() => setPriority(4)}
          >
            {priority() === 4 ? "[   ]" : "     "}
          </text>
        </box>
      </box>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Footer */}
      <box flexShrink={0}>
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(40)}
          </text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.fgMuted)}>Tab:next field</text>
          <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => save()}>
            Ctrl+S:save
          </text>
          <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onCancel()}>
            Esc:cancel
          </text>
        </box>
      </box>
    </box>
  );
}
