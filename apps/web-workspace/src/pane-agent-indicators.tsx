import type { Pane } from "@superlogical/shared/model";
// Matches PaneTitleBar.agentStatus and AgentBadge in the TUI. Fixture-only
// presentation; daemon integration must supply real lifecycle and fresh receipts.
const states = {
  running: { label: "working", marker: "●", tone: "working" },
  waiting: { label: "blocked", marker: "!", tone: "attention" },
  complete: { label: "done", marker: "✓", tone: "done" },
  idle: { label: "idle", marker: "○", tone: "muted" },
  failed: { label: "failed", marker: "!", tone: "danger" },
  disconnected: { label: "disconnected", marker: "○", tone: "muted" },
} as const;
export function AgentStatus({ agent }: { agent: NonNullable<Pane["agent"]> }) {
  const status = states[agent.activity];
  return (
    <span
      className="pane-agent-status"
      data-tone={status.tone}
      title={`Agent state: ${status.label}`}
      aria-label={`${agent.name}: ${status.label}`}
    >
      <span aria-hidden="true">{status.marker}</span> {status.label}
    </span>
  );
}
export function PaneAgentIndicators({ pane }: { pane: Pane }) {
  return (
    <div className="pane-indicators" aria-label="Agent indicators">
      {pane.interaction && (
        <span
          className="pane-interaction"
          title={`Activity: ${pane.interaction.badge}${pane.interaction.external ? " · External tmux" : ""}`}
        >
          {pane.interaction.badge}
          {pane.interaction.external && <span className="pane-external"> · External tmux</span>}
        </span>
      )}
      {pane.agent && <AgentStatus agent={pane.agent} />}
    </div>
  );
}
