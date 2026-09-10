import type { AgentActivity } from "@tmux-ide/contracts";
import { FLEET_HOST_ACCENT_COLORS } from "../theme.ts";

/** Identity-derived colors stay stable when hosts reconnect, reorder, or share a route. */
export function fleetHostColor(host: { id: string; environmentId?: string | null }): string {
  let hash = 2166136261;
  for (const character of host.environmentId ?? host.id)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return FLEET_HOST_ACCENT_COLORS[(hash >>> 0) % FLEET_HOST_ACCENT_COLORS.length]!;
}

export function summarizeFleetActivity(
  agents: readonly { activity: AgentActivity; attention: boolean; disabled?: boolean }[],
  available: boolean,
): {
  kind: "attention" | "running" | "idle" | "unknown";
  attention: number;
  running: number;
  label: string;
} {
  if (!available || agents.some((agent) => agent.disabled))
    return { kind: "unknown", attention: 0, running: 0, label: "? activity" };
  const attention = agents.filter(
    (agent) => agent.attention || agent.activity === "waiting" || agent.activity === "failed",
  ).length;
  const running = agents.filter((agent) => !agent.attention && agent.activity === "running").length;
  return {
    kind: attention ? "attention" : running ? "running" : "idle",
    attention,
    running,
    label: attention ? `! ${attention}` : running ? `● ${running}` : "○ idle",
  };
}
