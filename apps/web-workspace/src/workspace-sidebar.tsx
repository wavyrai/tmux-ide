import { AgentStatus } from "./pane-agent-indicators";
import { AgentIcon } from "./agent-icon";
import { useState } from "react";
import { leaves, type Workspace } from "@superlogical/shared/model";
import { Layers, Monitor, Terminal, ChevronDown, ChevronRight } from "./icons";
import { agentRows } from "./home-overview";
export function WorkspaceSidebar({
  workspace,
  connection,
  activeId,
  focusedId,
  onSelect,
  home,
  onHome,
  onTerminals,
}: {
  workspace: Workspace | null;
  connection: "connecting" | "paired" | "unpaired" | "offline";
  activeId?: string;
  focusedId?: string;
  home: boolean;
  onHome: () => void;
  onTerminals: () => void;
  onSelect: (tab: string, pane?: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const machines = [...new Set((workspace?.tabs || []).map((t) => t.machine || "Local"))];
  return (
    <aside
      className={`workspace-sidebar ${collapsed ? "sidebar-collapsed" : ""}`}
      aria-label="Workspace navigation"
    >
      <div className="sidebar-brand">
        <Layers size={17} />
        {!collapsed && <strong>tmux-ide</strong>}
        <button
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>
      <nav className="sidebar-navigation">
        <button aria-label="Home" aria-current={home ? "page" : undefined} onClick={onHome}>
          <span aria-hidden="true">⌂</span>
          {!collapsed && "Home"}
        </button>
        <button
          aria-label="Terminals"
          aria-current={!home ? "page" : undefined}
          onClick={onTerminals}
        >
          <Terminal size={14} />
          {!collapsed && "Terminals"}
        </button>
      </nav>
      {!collapsed && (
        <>
          <div className="sidebar-caption">
            MACHINES <span>LIVE</span>
          </div>
          {machines.map((machine) => (
            <div className="machine-group" key={machine}>
              <button
                className="machine-row"
                aria-expanded={!closed[machine]}
                onClick={() => setClosed({ ...closed, [machine]: !closed[machine] })}
              >
                {closed[machine] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <Monitor size={14} />
                <strong>{machine}</strong>
                <span className="machine-status">{machine === "Local" ? "local" : "remote"}</span>
              </button>
              {!closed[machine] && (
                <>
                  <div className="sidebar-subheading">Sessions</div>
                  {workspace?.tabs
                    .filter((t) => !t.hidden && (t.machine || "Local") === machine)
                    .map((tab) => (
                      <button
                        key={tab.id}
                        className="sidebar-session"
                        data-selected={!home && activeId === tab.id}
                        onClick={() => onSelect(tab.id)}
                      >
                        <Terminal size={13} />
                        <span>{tab.name}</span>
                        <small>{tab.paneCount ?? leaves(tab.layout).length}</small>
                      </button>
                    ))}
                  <div className="sidebar-subheading">Agents</div>
                  {agentRows(workspace)
                    .filter((a) => a.machine === machine)
                    .map(({ pane, tab }) => (
                      <button
                        key={pane.id}
                        className="sidebar-pane"
                        data-selected={!home && activeId === tab.id && focusedId === pane.id}
                        aria-current={
                          !home && activeId === tab.id && focusedId === pane.id ? "true" : undefined
                        }
                        onClick={() => onSelect(tab.id, pane.id)}
                      >
                        <AgentIcon name={pane.command} size={13} />
                        <span>{pane.agent!.name}</span>
                        <AgentStatus agent={pane.agent!} />
                      </button>
                    ))}
                </>
              )}
            </div>
          ))}
          <div className="sidebar-footer">
            <span className="demo-dot" />
            {connection === "paired"
              ? "Daemon connected"
              : connection === "connecting"
                ? "Connecting…"
                : "Connection interrupted"}
            <p>Live local catalog</p>
          </div>
        </>
      )}
    </aside>
  );
}
