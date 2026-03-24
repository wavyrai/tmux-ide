import { For, Show } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";
import type { ProofSchema } from "../../types.ts";
import { AgentCard, type AgentInfo } from "./agent-card.tsx";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

function progressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return "#".repeat(filled) + "-".repeat(width - filled);
}

export interface CompletedTask {
  id: string;
  title: string;
  proof?: ProofSchema | null;
}

function proofBadges(proof: ProofSchema | null | undefined): string {
  if (!proof) return "";
  const parts: string[] = [];
  if (proof.tests) {
    const ok = proof.tests.passed === proof.tests.total;
    parts.push(`${ok ? "✓" : "✗"} ${proof.tests.passed}/${proof.tests.total} tests`);
  }
  if (proof.pr) {
    const status = proof.pr.status ? ` ${proof.pr.status}` : "";
    parts.push(`PR #${proof.pr.number}${status}`);
  }
  if (proof.ci) {
    parts.push(`CI: ${proof.ci.status}`);
  }
  if (proof.notes) {
    parts.push(proof.notes);
  }
  return parts.join("  ");
}

interface GoalSectionProps {
  title: string;
  priority: number;
  totalTasks: number;
  doneTasks: number;
  completedTasks: CompletedTask[];
  agents: AgentInfo[];
  theme: WidgetTheme;
  selectedAgent: number;
  agentStartIndex: number;
  onSelectAgent?: (globalIndex: number) => void;
  onToggleExpand?: () => void;
}

export function GoalSection(props: GoalSectionProps) {
  const pct = () =>
    props.totalTasks > 0 ? Math.round((props.doneTasks / props.totalTasks) * 100) : 0;

  return (
    <box paddingLeft={1} paddingTop={1}>
      <box flexDirection="row" gap={2} onMouseDown={props.onToggleExpand}>
        <text fg={toRGBA(props.theme.fg)} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <text fg={toRGBA(props.theme.fgMuted)}>
          [P{props.priority}] {pct()}%
        </text>
      </box>
      <text fg={toRGBA(props.theme.gitAdded)}>{progressBar(pct(), 15)}</text>
      <For each={props.agents}>
        {(agent, i) => {
          const globalIdx = () => props.agentStartIndex + i();
          return (
            <AgentCard
              agent={agent}
              theme={props.theme}
              selected={globalIdx() === props.selectedAgent}
              onMouseDown={() => props.onSelectAgent?.(globalIdx())}
            />
          );
        }}
      </For>
      <Show when={props.completedTasks.length > 0}>
        <For each={props.completedTasks}>
          {(task) => {
            const badges = () => proofBadges(task.proof);
            const allPass = () =>
              task.proof?.tests ? task.proof.tests.passed === task.proof.tests.total : false;
            return (
              <box flexDirection="row" gap={1} paddingLeft={1}>
                <text fg={toRGBA(props.theme.gitAdded)}>✓</text>
                <text fg={toRGBA(props.theme.fgMuted)}>{task.title}</text>
                <Show when={badges()}>
                  <text fg={toRGBA(allPass() ? props.theme.gitAdded : props.theme.fgMuted)}>
                    {badges()}
                  </text>
                </Show>
              </box>
            );
          }}
        </For>
      </Show>
    </box>
  );
}
