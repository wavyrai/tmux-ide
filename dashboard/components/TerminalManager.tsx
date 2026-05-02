"use client";

import { usePathname } from "next/navigation";
import { Terminal } from "@/components/Terminal";
import { useLayoutState } from "@/lib/useLayoutState";

function projectFromPath(pathname: string): string {
  const match = pathname.match(/^\/project\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : "default";
}

/**
 * Mounts every open terminal once and keeps each xterm + WebSocket alive
 * across navigations. Only the active tab for the current project is visible
 * (display: flex); every other terminal is mounted with display: none so its
 * scrollback and connection survive.
 */
interface TerminalManagerProps {
  onSessionExit?: (id: string) => void;
}

export function TerminalManager({ onSessionExit }: TerminalManagerProps) {
  const pathname = usePathname();
  const currentProject = projectFromPath(pathname);
  const { tabs, getActiveTabId } = useLayoutState();
  const visibleId = getActiveTabId(currentProject);

  if (tabs.length === 0) return null;

  return (
    <div data-testid="terminal-manager" className="absolute inset-0 z-10">
      {tabs.map((tab) => {
        const visible = tab.id === visibleId;
        return (
          <div
            key={tab.id}
            data-terminal-slot={tab.id}
            data-active={visible || undefined}
            className="absolute inset-0 flex flex-col"
            style={{
              display: visible ? "flex" : "none",
            }}
          >
            <Terminal id={tab.id} showHeader={false} onSessionExit={onSessionExit} />
          </div>
        );
      })}
    </div>
  );
}
