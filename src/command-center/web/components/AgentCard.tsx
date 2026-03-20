import { JSX, Show } from "solid-js";
import type { Agent } from "../types.ts";

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard(props: AgentCardProps): JSX.Element {
  const dotStyle = (): Record<string, string> => {
    const base: Record<string, string> = {
      width: "6px",
      height: "6px",
      "border-radius": "50%",
      "flex-shrink": "0",
    };
    if (props.agent.isBusy) {
      base.background = "var(--warning)";
      base["box-shadow"] = "0 0 4px rgba(232,201,90,0.3)";
    } else {
      base.background = "var(--text-muted)";
    }
    return base;
  };

  return (
    <div style={{
      display: "flex",
      "align-items": "center",
      gap: "8px",
      padding: "6px 8px",
      "border-radius": "4px",
      background: "var(--bg-surface)",
    }}>
      {/* Status dot */}
      <span style={dotStyle()} />

      {/* Agent info */}
      <div style={{ flex: "1", "min-width": "0" }}>
        <div style={{ "font-size": "12px", color: "var(--text-primary)", "font-weight": "500" }}>
          {props.agent.paneTitle}
        </div>
        <Show
          when={props.agent.taskTitle}
          fallback={<div style={{ "font-size": "10px", color: "var(--text-muted)" }}>idle</div>}
        >
          <div style={{ "font-size": "10px", color: "var(--text-secondary)", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
            {props.agent.taskTitle}
          </div>
        </Show>
      </div>

      {/* Elapsed */}
      <Show when={props.agent.elapsed}>
        <span style={{ "font-size": "10px", color: "var(--text-muted)", "flex-shrink": "0" }}>
          {props.agent.elapsed}
        </span>
      </Show>
    </div>
  );
}
