import { For } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";
import { AgentCard, type AgentInfo } from "./agent-card.tsx";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

interface GoalSectionProps {
  title: string;
  priority: number;
  totalTasks: number;
  doneTasks: number;
  agents: AgentInfo[];
  theme: WidgetTheme;
  selectedAgent: number;
  agentStartIndex: number;
}

export function GoalSection(props: GoalSectionProps) {
  const pct = () =>
    props.totalTasks > 0 ? Math.round((props.doneTasks / props.totalTasks) * 100) : 0;

  return (
    <box paddingLeft={1} paddingTop={1}>
      <box flexDirection="row" gap={2}>
        <text fg={toRGBA(props.theme.fg)} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={toRGBA(props.theme.fgMuted)}>
          [P{props.priority}] {pct()}%
        </text>
      </box>
      <text fg={toRGBA(props.theme.gitAdded)}>{progressBar(pct(), 15)}</text>
      <For each={props.agents}>
        {(agent, i) => (
          <AgentCard
            agent={agent}
            theme={props.theme}
            selected={props.agentStartIndex + i() === props.selectedAgent}
          />
        )}
      </For>
    </box>
  );
}
