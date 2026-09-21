import { useState } from "react";
import { leaves, type Workspace } from "@superlogical/shared/model";
import { AgentIcon } from "./agent-icon";
import { PaneAgentIndicators } from "./pane-agent-indicators";
export function agentRows(workspace: Workspace | null) {
  return (workspace?.tabs || [])
    .flatMap((tab) =>
      leaves(tab.layout).flatMap((id) => {
        const pane = workspace!.panes[id];
        return pane?.agent ? [{ pane, tab, machine: tab.machine || "Local" }] : [];
      }),
    )
    .sort((a, b) => rank(a.pane.agent!.activity) - rank(b.pane.agent!.activity));
}
const rank = (s: string) => (s === "waiting" || s === "failed" ? 0 : s === "running" ? 1 : 2);
export function HomeOverview({
  workspace,
  onOpen,
}: {
  workspace: Workspace | null;
  onOpen: (tab: string, pane?: string) => void;
}) {
  const [scope, setScope] = useState("All machines");
  const all = agentRows(workspace);
  const rows = all.filter((a) => scope === "All machines" || a.machine === scope);
  const machines = [...new Set((workspace?.tabs || []).map((t) => t.machine || "Local"))];
  return (
    <main className="home-overview" aria-label="Home">
      <header className="home-top">
        <strong>Home</strong>
        <span>Live daemon · read-only catalog</span>
      </header>
      <div className="home-content">
        <div className="home-intro">
          <div>
            <span className="home-eyebrow">YOUR WORKSPACE</span>
            <h1>Everything in view.</h1>
            <p>Agents, sessions, and activity across your machines.</p>
          </div>
          <label className="home-scope">
            Scope
            <select
              aria-label="Machine scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {["All machines", ...machines].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="home-counts">
          <div>
            <strong>{rows.filter((a) => rank(a.pane.agent!.activity) === 0).length}</strong>
            <span>Need attention</span>
          </div>
          <div>
            <strong>{rows.filter((a) => a.pane.agent!.activity === "running").length}</strong>
            <span>Working</span>
          </div>
          <div>
            <strong>{rows.length}</strong>
            <span>Agents</span>
          </div>
          <div>
            <strong>
              {
                (workspace?.tabs || []).filter(
                  (t) =>
                    !t.hidden && (scope === "All machines" || (t.machine || "Local") === scope),
                ).length
              }
            </strong>
            <span>Open sessions</span>
          </div>
        </div>
        <section className="home-section">
          <h2>
            Agents <span>Attention first</span>
          </h2>
          <div className="home-agent-list">
            {rows.map(({ pane, tab, machine }) => (
              <button key={pane.id} onClick={() => onOpen(tab.id, pane.id)} className="home-agent">
                <AgentIcon name={pane.command} size={19} />
                <div className="home-agent-name">
                  <strong>{pane.agent!.name}</strong>
                  <small>
                    {machine} / {tab.name}
                  </small>
                </div>
                <PaneAgentIndicators pane={pane} />
                <span aria-hidden="true">↗</span>
              </button>
            ))}
            {!rows.length && <p className="home-empty">No agents in this scope.</p>}
          </div>
        </section>
        <div className="home-columns">
          <section className="home-section">
            <h2>
              Pane activity <span>Observed receipts</span>
            </h2>
            {rows
              .filter((a) => a.pane.interaction)
              .map(({ pane, tab, machine }) => (
                <button
                  className="home-event"
                  key={pane.id}
                  onClick={() => onOpen(tab.id, pane.id)}
                >
                  <AgentIcon name={pane.command} size={14} />
                  <div>
                    <strong>{pane.agent!.name}</strong>
                    <p>
                      {pane.interaction!.badge === "READING"
                        ? "Reading pane output"
                        : "Input received"}
                      {pane.interaction!.external ? " · External tmux" : ""}
                    </p>
                    <small>
                      {machine} / {tab.name}
                    </small>
                  </div>
                  <span className="pane-interaction">{pane.interaction!.badge}</span>
                </button>
              ))}
            {!rows.some((a) => a.pane.interaction) && (
              <p className="home-empty">No pane activity in this scope.</p>
            )}
          </section>
          <section className="home-section">
            <h2>Sessions</h2>
            {workspace?.tabs
              .filter(
                (t) => !t.hidden && (scope === "All machines" || (t.machine || "Local") === scope),
              )
              .map((tab) => (
                <button className="home-session" key={tab.id} onClick={() => onOpen(tab.id)}>
                  <div>
                    <strong>{tab.name}</strong>
                    <small>{tab.machine || "Local"}</small>
                  </div>
                  <span>{tab.paneCount ?? leaves(tab.layout).length} panes ↗</span>
                </button>
              ))}
          </section>
        </div>
      </div>
    </main>
  );
}
