"use client";

import { useState, useEffect } from "react";
import { openCommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";
import { useLayoutState } from "@/lib/useLayoutState";

export function TopBar() {
  const [time, setTime] = useState("");
  const { terminalOpen, toggleTerminal } = useLayoutState();

  useEffect(() => {
    function update() {
      setTime(
        new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    }
    update();
    const id = setInterval(update, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="h-6 flex items-center px-3 bg-[var(--bg-weak)] border-b text-[11px] sticky top-0 z-30">
      <span className="text-[var(--accent)] font-medium">tmux-ide</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={toggleTerminal}
        data-testid="terminal-toggle"
        data-active={terminalOpen ? "true" : "false"}
        className={`mr-2 h-5 px-2 text-[10px] transition-colors ${
          terminalOpen
            ? "bg-[var(--surface-active)] text-[var(--accent)]"
            : "text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
        }`}
        aria-pressed={terminalOpen}
        aria-label="Toggle terminal mode"
        title="Toggle terminal mode (⌘J)"
      >
        ⌘J
      </button>
      <button
        type="button"
        onClick={openCommandPalette}
        data-testid="command-palette-button"
        className="mr-2 h-5 px-2 text-[10px] text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
        aria-label="Open command palette"
        title="Open command palette (⌘K)"
      >
        ⌘K
      </button>
      <ThemeToggle />
      <span className="text-[var(--dim)] ml-3">{time}</span>
    </div>
  );
}
