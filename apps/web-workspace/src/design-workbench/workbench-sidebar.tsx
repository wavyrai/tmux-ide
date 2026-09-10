import { useState } from "react";
import { AgentIcon } from "../agent-icon";
import { Home, Terminal, Monitor, Layers, ChevronDown, ChevronRight } from "../icons";
import { paneIds, type LayoutNode } from "./layout-model";
import { groupSidebarWindows } from "./sidebar-model";
export interface SidebarPane {
  id: string;
  title: string;
  command: string;
  state: string;
}
export interface WorkbenchWindow {
  id: string;
  name: string;
  machine: string;
  machineId: string;
  session: string;
  sessionId: string;
  layout: LayoutNode | null;
  paneCount?: number;
  panes?: readonly string[];
}
export function WorkbenchSidebar({
  windows,
  panes,
  active,
  selected,
  home,
  onHome,
  onTerminals,
  onSelect,
  footer = ["Design workspace", "Local fixtures · no daemon"],
}: {
  footer?: readonly [string, string];
  windows: WorkbenchWindow[];
  panes: Record<string, SidebarPane>;
  active: string;
  selected: string;
  home: boolean;
  onHome: () => void;
  onTerminals: () => void;
  onSelect: (window: string, pane?: string) => void;
}) {
  const [closed, setClosed] = useState<string[]>([]);
  const activeWindow = windows.find((w) => w.id === active);
  return (
    <aside className="dw-sidebar" id="design-workspace-sidebar">
      <header className="dw-toolbar">
        <Layers size={16} />
        <strong>Workspace</strong>
      </header>
      <nav className="dw-section">
        <button className="dw-row" data-active={home} onClick={onHome}>
          <Home size={14} />
          Home
        </button>
        <button className="dw-row" data-active={!home} onClick={onTerminals}>
          <Terminal size={14} />
          Terminals
        </button>
      </nav>
      <div className="dw-section">
        <span className="dw-section-label">Machines</span>
        {groupSidebarWindows(windows).map((machine) => (
          <div key={machine.id}>
            <button
              className="dw-row"
              aria-expanded={!closed.includes(machine.id)}
              onClick={() =>
                setClosed((all) =>
                  all.includes(machine.id)
                    ? all.filter((m) => m !== machine.id)
                    : [...all, machine.id],
                )
              }
            >
              {closed.includes(machine.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Monitor size={14} />
              <strong>{machine.label}</strong>
              <span className="dw-status">{machine.label === "Local" ? "local" : "SSH"}</span>
            </button>
            {!closed.includes(machine.id) &&
              machine.sessions.map((session) => {
                const entries = session.windows;
                return (
                  <div key={session.id}>
                    <button
                      className="dw-row"
                      data-depth="1"
                      data-active={
                        !home &&
                        activeWindow?.machineId === machine.id &&
                        activeWindow?.sessionId === session.id
                      }
                      onClick={() => onSelect(entries[0]!.id)}
                    >
                      <Terminal size={14} />
                      <span>{session.label}</span>
                      <span className="dw-status">
                        {entries.reduce(
                          (n, w) => n + (w.paneCount ?? (w.panes ?? paneIds(w.layout)).length),
                          0,
                        )}
                      </span>
                    </button>
                    {entries
                      .flatMap((w) =>
                        (w.panes ?? paneIds(w.layout)).map((id) => ({
                          window: w.id,
                          pane: panes[id],
                        })),
                      )
                      .filter(
                        (entry) => entry.pane && /(claude|codex|opencode)/.test(entry.pane.command),
                      )
                      .map(({ window, pane }) => (
                        <button
                          className="dw-row"
                          data-depth="2"
                          key={`${window}:${pane.id}`}
                          data-active={!home && active === window && selected === pane.id}
                          aria-current={
                            !home && active === window && selected === pane.id ? "true" : undefined
                          }
                          onClick={() => onSelect(window, pane.id)}
                        >
                          <AgentIcon name={pane.command} />
                          <span>{pane.title}</span>
                          <span className="dw-status" title={pane.state} aria-label={pane.state}>
                            {pane.state === "working"
                              ? "●"
                              : pane.state === "needs input"
                                ? "!"
                                : "○"}
                          </span>
                        </button>
                      ))}
                  </div>
                );
              })}
          </div>
        ))}
      </div>
      <footer className="dw-footer">
        <span>{footer[0]}</span>
        <span>{footer[1]}</span>
      </footer>
    </aside>
  );
}
