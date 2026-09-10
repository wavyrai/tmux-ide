import { useState } from "react";
import { AgentIcon } from "../agent-icon";
import { Home, Terminal, Monitor, Layers, ChevronDown, ChevronRight } from "../icons";
import { paneIds, type LayoutNode } from "./layout-model";
import type { FixturePane } from "./fixture-content";
export interface WorkbenchWindow {
  id: string;
  name: string;
  machine: string;
  session: string;
  layout: LayoutNode | null;
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
  onHide,
}: {
  windows: WorkbenchWindow[];
  panes: Record<string, FixturePane>;
  active: string;
  selected: string;
  home: boolean;
  onHome: () => void;
  onTerminals: () => void;
  onSelect: (window: string, pane?: string) => void;
  onHide: () => void;
}) {
  const [closed, setClosed] = useState<string[]>([]);
  const activeWindow = windows.find((w) => w.id === active);
  return (
    <aside className="dw-sidebar">
      <header className="dw-toolbar">
        <Layers size={16} />
        <strong>tmux-ide</strong>
        <button className="dw-button" onClick={onHide} aria-label="Hide sidebar">
          <ChevronDown size={14} />
        </button>
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
        {[...new Set(windows.map((w) => w.machine))].map((machine) => (
          <div key={machine}>
            <button
              className="dw-row"
              aria-expanded={!closed.includes(machine)}
              onClick={() =>
                setClosed((all) =>
                  all.includes(machine) ? all.filter((m) => m !== machine) : [...all, machine],
                )
              }
            >
              {closed.includes(machine) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <Monitor size={14} />
              <strong>{machine}</strong>
              <span className="dw-status">{machine === "Local" ? "local" : "SSH"}</span>
            </button>
            {!closed.includes(machine) &&
              [...new Set(windows.filter((w) => w.machine === machine).map((w) => w.session))].map(
                (session) => {
                  const entries = windows.filter(
                    (w) => w.machine === machine && w.session === session,
                  );
                  return (
                    <div key={session}>
                      <button
                        className="dw-row"
                        data-depth="1"
                        data-active={
                          !home &&
                          activeWindow?.machine === machine &&
                          activeWindow?.session === session
                        }
                        onClick={() => onSelect(entries[0]!.id)}
                      >
                        <Terminal size={14} />
                        <span>{session}</span>
                        <span className="dw-status">
                          {entries.reduce((n, w) => n + paneIds(w.layout).length, 0)}
                        </span>
                      </button>
                      {entries
                        .flatMap((w) =>
                          paneIds(w.layout).map((id) => ({ window: w.id, pane: panes[id] })),
                        )
                        .filter(
                          (entry) =>
                            entry.pane && /(claude|codex|opencode)/.test(entry.pane.command),
                        )
                        .map(({ window, pane }) => (
                          <button
                            className="dw-row"
                            data-depth="2"
                            key={`${window}:${pane.id}`}
                            data-active={!home && active === window && selected === pane.id}
                            aria-current={
                              !home && active === window && selected === pane.id
                                ? "true"
                                : undefined
                            }
                            onClick={() => onSelect(window, pane.id)}
                          >
                            <AgentIcon name={pane.command} />
                            <span>{pane.title}</span>
                            <span className="dw-status">
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
                },
              )}
          </div>
        ))}
      </div>
      <footer className="dw-footer">
        <span>Design workspace</span>
        <span>Local fixtures · no daemon</span>
      </footer>
    </aside>
  );
}
