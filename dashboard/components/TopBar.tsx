"use client";

import { Command, Terminal } from "lucide-react";
import { useState, useEffect } from "react";
import { openCommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";
import { useLayoutState } from "@/lib/useLayoutState";
import { SidebarTrigger } from "@/components/ui/sidebar";

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
    <div className="sticky top-0 z-30 flex h-6 items-center border-b bg-[var(--bg-weak)] px-2 text-[11px] md:px-3">
      <SidebarTrigger className="mr-2" />
      <span className="font-medium text-[var(--accent)]">tmux-ide</span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={toggleTerminal}
        data-testid="terminal-toggle"
        data-active={terminalOpen ? "true" : "false"}
        className={`mr-1 inline-flex h-5 items-center gap-1 rounded-md px-2 text-[10px] transition-colors motion-safe:transition-transform motion-safe:duration-75 motion-safe:active:scale-[0.98] md:mr-2 ${
          terminalOpen
            ? "bg-[var(--surface-active)] text-[var(--accent)]"
            : "text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
        }`}
        aria-pressed={terminalOpen}
        aria-label="Toggle terminal mode"
        title="Toggle terminal mode (⌘J)"
      >
        <Terminal aria-hidden="true" size={13} />
        <span>⌘J</span>
      </button>
      <button
        type="button"
        onClick={openCommandPalette}
        data-testid="command-palette-button"
        className="mr-1 inline-flex h-5 items-center gap-1 rounded-md px-2 text-[10px] text-[var(--dim)] transition-colors motion-safe:transition-transform motion-safe:duration-75 motion-safe:active:scale-[0.98] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] md:mr-2"
        aria-label="Open command palette"
        title="Open command palette (⌘K)"
      >
        <Command aria-hidden="true" size={13} />
        <span className="border border-[var(--border-weak)] px-1 leading-3">K</span>
      </button>
      <ThemeToggle />
      <span className="ml-3 hidden text-[var(--dim)] md:inline">{time}</span>
    </div>
  );
}
