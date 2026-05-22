import { createSignal, For, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export interface AgentInfo {
  name: string;
  paneId: string;
  state: "busy" | "idle" | "error";
  role?: string;
  currentTask: { id: string; title: string; elapsed: string } | null;
}

interface AgentPanelProps {
  agents: AgentInfo[];
  isActive: boolean;
  theme: WidgetTheme;
  onAddAgent: () => void;
  onSelectAgent: (agent: AgentInfo) => void;
}

function dotChar(state: AgentInfo["state"]): string {
  return state === "error" ? "!" : state === "busy" ? "*" : "o";
}

function dotColor(state: AgentInfo["state"], theme: WidgetTheme): RGBAType {
  switch (state) {
    case "idle":
      return theme.gitAdded;
    case "busy":
      return theme.gitModified;
    case "error":
      return theme.gitDeleted;
  }
}

export function AgentPanel(props: AgentPanelProps) {
  const [selected, setSelected] = createSignal(0);

  // Total rows = agents + 1 for the [+add] row
  const rowCount = () => props.agents.length + 1;

  useKeyboard((evt) => {
    if (!props.isActive) return;

    if (evt.name === "up" || evt.name === "k") {
      setSelected((i) => Math.max(0, i - 1));
      evt.preventDefault();
    } else if (evt.name === "down" || evt.name === "j") {
      setSelected((i) => Math.min(rowCount() - 1, i + 1));
      evt.preventDefault();
    } else if (evt.name === "return") {
      if (selected() === props.agents.length) {
        props.onAddAgent();
      } else {
        const agent = props.agents[selected()];
        if (agent) props.onSelectAgent(agent);
      }
      evt.preventDefault();
    }
  });

  return (
    <box flexGrow={1}>
      <For each={props.agents}>
        {(agent, i) => {
          const isSel = () => props.isActive && selected() === i();
          return (
            <box
              flexShrink={0}
              flexDirection="row"
              gap={1}
              backgroundColor={isSel() ? toRGBA(props.theme.selected) : undefined}
              onMouseDown={() => {
                setSelected(i());
                props.onSelectAgent(agent);
              }}
            >
              <text fg={toRGBA(dotColor(agent.state, props.theme))}>{dotChar(agent.state)}</text>
              <text
                fg={toRGBA(isSel() ? props.theme.selectedText : props.theme.fg)}
                attributes={isSel() ? TextAttributes.BOLD : 0}
                wrapMode="none"
              >
                {agent.name}
              </text>
              <Show when={agent.currentTask}>
                {(task) => (
                  <text fg={toRGBA(props.theme.fgMuted)} wrapMode="none">
                    {task().title} {task().elapsed}
                  </text>
                )}
              </Show>
              <Show when={!agent.currentTask}>
                <text fg={toRGBA(props.theme.fgMuted)}>idle</text>
              </Show>
            </box>
          );
        }}
      </For>

      {/* Add agent row */}
      <box
        flexShrink={0}
        flexDirection="row"
        backgroundColor={
          props.isActive && selected() === props.agents.length
            ? toRGBA(props.theme.selected)
            : undefined
        }
        onMouseDown={() => {
          setSelected(props.agents.length);
          props.onAddAgent();
        }}
      >
        <text
          fg={toRGBA(
            props.isActive && selected() === props.agents.length
              ? props.theme.accent
              : props.theme.fgMuted,
          )}
        >
          [+add]
        </text>
      </box>
    </box>
  );
}
