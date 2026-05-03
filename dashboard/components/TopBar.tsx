"use client";

import { Command, Menu, Terminal } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { ActivityBar } from "./ActivityBar";
import { openCommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { useLayoutState } from "@/lib/useLayoutState";

export function TopBar() {
  const [time, setTime] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // iOS Safari sometimes synthesizes a SECOND click after touchend; if the
  // hamburger opens the drawer, the synthetic click can land on the
  // newly-mounted backdrop and immediately close it. Arm the backdrop with
  // a 200ms grace window after opening so that ghost click is ignored.
  const drawerArmedAtRef = useRef(0);
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

  useEffect(() => {
    if (!drawerOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDrawerOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);

  return (
    <>
      <div className="h-6 flex items-center px-2 md:px-3 bg-[var(--bg-weak)] border-b text-[11px] sticky top-0 z-30">
        <button
          type="button"
          data-testid="mobile-nav-toggle"
          onClick={() => {
            drawerArmedAtRef.current = Date.now();
            setDrawerOpen(true);
          }}
          className="mr-2 flex h-5 w-5 items-center justify-center text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] motion-safe:active:scale-[0.95] md:hidden"
          aria-label="Open navigation"
          aria-expanded={drawerOpen}
          aria-controls="mobile-shell-drawer"
        >
          <Menu aria-hidden="true" size={15} />
        </button>
        <span className="text-[var(--accent)] font-medium">tmux-ide</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={toggleTerminal}
          data-testid="terminal-toggle"
          data-active={terminalOpen ? "true" : "false"}
          className={`mr-1 inline-flex h-5 items-center gap-1 px-2 text-[10px] transition-colors motion-safe:transition-transform motion-safe:duration-75 motion-safe:active:scale-[0.98] md:mr-2 ${
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
          className="mr-1 inline-flex h-5 items-center gap-1 px-2 text-[10px] text-[var(--dim)] transition-colors motion-safe:transition-transform motion-safe:duration-75 motion-safe:active:scale-[0.98] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)] md:mr-2"
          aria-label="Open command palette"
          title="Open command palette (⌘K)"
        >
          <Command aria-hidden="true" size={13} />
          <span className="border border-[var(--border-weak)] px-1 leading-3">K</span>
        </button>
        <ThemeToggle />
        <span className="ml-3 hidden text-[var(--dim)] md:inline">{time}</span>
      </div>

      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" data-testid="mobile-shell-drawer-root">
          <button
            type="button"
            className="absolute inset-0 bg-[var(--modal-overlay)]"
            aria-label="Close navigation"
            onClick={() => {
              if (Date.now() - drawerArmedAtRef.current < 200) return;
              setDrawerOpen(false);
            }}
          />
          <div
            id="mobile-shell-drawer"
            data-testid="mobile-shell-drawer"
            className="absolute inset-y-0 left-0 flex w-[min(280px,calc(100vw-48px))] motion-safe:animate-[mobile-drawer-in_180ms_var(--ease-out-fluid)] flex-col border-r border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <ActivityBar variant="drawer" testId="activity-bar-drawer" />
            <Sidebar
              className="!w-full flex-1 !border-r-0"
              testId="sidebar-drawer"
              onNavigate={() => setDrawerOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
