"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Terminal } from "@/components/Terminal";

function projectFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/project\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function readTabFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("tab");
}

/**
 * Mounts one <Terminal> per project the user has ever visited the terminal tab
 * of, and keeps them mounted across navigations. Only the active project's
 * terminal is visible — the rest sit in the same DOM with display:none, which
 * preserves their xterm instance, scrollback, and WebSocket connection.
 *
 * Visibility derives from URL state (pathname + ?tab=terminal). Since tab
 * changes within a page use history.replaceState (no popstate), the project
 * page dispatches a "tabchange" CustomEvent that this component listens for.
 */
export function TerminalPool() {
  const pathname = usePathname();
  const activeProject = projectFromPath(pathname);

  const [tab, setTab] = useState<string | null>(null);
  const [visited, setVisited] = useState<string[]>([]);

  // Track ?tab=terminal across pushState/replaceState/popstate/tabchange
  useEffect(() => {
    function update() {
      setTab(readTabFromLocation());
    }
    update();
    window.addEventListener("popstate", update);
    window.addEventListener("tabchange", update as EventListener);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("tabchange", update as EventListener);
    };
  }, [pathname]);

  const terminalTabActive = tab === "terminal";

  // Once we land on a project's terminal tab, remember it forever so subsequent
  // visits restore the same xterm instance. This is the persistence point.
  useEffect(() => {
    if (terminalTabActive && activeProject) {
      setVisited((prev) => (prev.includes(activeProject) ? prev : [...prev, activeProject]));
    }
  }, [terminalTabActive, activeProject]);

  if (visited.length === 0) return null;

  return (
    <div
      data-testid="terminal-pool"
      data-active-project={activeProject ?? ""}
      data-terminal-tab-active={terminalTabActive ? "true" : "false"}
      className="pointer-events-none absolute inset-0 z-10"
    >
      {visited.map((id) => {
        const isVisible = terminalTabActive && id === activeProject;
        return (
          <div
            key={id}
            data-terminal-slot={id}
            className="absolute inset-0 flex flex-col"
            style={{
              display: isVisible ? "flex" : "none",
              pointerEvents: isVisible ? "auto" : "none",
            }}
          >
            <Terminal id={id} showHeader={false} />
          </div>
        );
      })}
    </div>
  );
}
