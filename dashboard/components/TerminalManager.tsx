"use client";

import { Terminal } from "@/components/Terminal";
import { useLayoutState } from "@/lib/useLayoutState";

export function TerminalManager() {
  const { activeTabId, tabs } = useLayoutState();

  if (tabs.length === 0) return null;

  return (
    <div data-testid="terminal-manager" className="absolute inset-0 z-10">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            data-terminal-slot={tab.id}
            className="absolute inset-0 flex flex-col"
            style={{
              display: active ? "flex" : "none",
            }}
          >
            <Terminal id={tab.id} showHeader={false} />
          </div>
        );
      })}
    </div>
  );
}
