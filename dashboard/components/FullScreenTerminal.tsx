"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { TerminalManager } from "@/components/TerminalManager";
import { TerminalTabItem } from "@/components/TerminalTabItem";
import { fetchProject } from "@/lib/api";
import { useKeybind } from "@/lib/useKeybinds";
import { useLayoutState } from "@/lib/useLayoutState";

function projectFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/project\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function FullScreenTerminal() {
  const pathname = usePathname();
  const projectRouteName = projectFromPath(pathname);
  const currentProjectName = projectRouteName ?? "default";
  const loadingProjectsRef = useRef(new Set<string>());
  const {
    terminalOpen,
    toggleTerminal,
    closeTerminalMode,
    newTab,
    closeTab,
    setActiveTab,
    reorderTabs,
    getProjectTabs,
    getActiveTabId,
  } = useLayoutState();

  const projectTabs = getProjectTabs(currentProjectName);
  const activeTabId = getActiveTabId(currentProjectName);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const tabIds = useMemo(() => projectTabs.map((tab) => tab.id), [projectTabs]);

  const newProjectTab = useCallback(
    async (projectName: string) => {
      if (!projectRouteName) {
        return newTab(projectName);
      }

      const project = await fetchProject(projectName);
      if (!project?.dir) {
        return newTab(projectName, { title: projectName });
      }
      // Default to the user's login shell in the project's dir. Users who
      // want the tmux-ide CLI can run `tmux-ide` themselves from the prompt;
      // forcing it here meant tmux's default-shell decided your shell, which
      // routinely demoted zsh users into bash/sh and skipped .zshrc.
      return newTab(projectName, {
        title: projectName,
        cwd: project.dir,
      });
    },
    [newTab, projectRouteName],
  );

  // Cmd+J / Ctrl+J — VS Code-style panel toggle (less Mac key conflict than `).
  useKeybind("Mod+j", () => toggleTerminal(), { allowInput: true });
  useKeybind(
    "Escape",
    () => {
      if (terminalOpen) closeTerminalMode();
    },
    { allowInput: true },
  );

  useEffect(() => {
    if (!terminalOpen) {
      loadingProjectsRef.current.clear();
    }
  }, [terminalOpen]);

  // First open for a project starts a browser-backed tmux-ide client. Each tab
  // gets its own PTY, so browser resize maps to a real tmux client resize.
  useEffect(() => {
    if (!terminalOpen) return;
    if (loadingProjectsRef.current.has(currentProjectName)) return;
    if (projectTabs.length > 0) return;

    let cancelled = false;
    loadingProjectsRef.current.add(currentProjectName);

    async function autoCreate() {
      try {
        const tab = await newProjectTab(currentProjectName);
        if (!cancelled) setActiveTab(currentProjectName, tab.id);
      } catch {
        if (!cancelled) newTab(currentProjectName);
      } finally {
        loadingProjectsRef.current.delete(currentProjectName);
      }
    }

    void autoCreate();
    return () => {
      cancelled = true;
    };
  }, [currentProjectName, newProjectTab, newTab, projectTabs.length, setActiveTab, terminalOpen]);

  const openProjectTab = useCallback(() => {
    void newProjectTab(currentProjectName);
  }, [currentProjectName, newProjectTab]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = tabIds.indexOf(String(active.id));
    const to = tabIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;

    const next = [...tabIds];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    reorderTabs(next);
  }

  // Stay mounted across toggles so xterm + WebSocket state survives Cmd-J off.
  // Visibility flips display: none — the entire subtree (TerminalManager,
  // every Terminal, every WS) keeps running in the background.
  return (
    <section
      data-testid="full-screen-terminal"
      data-project={currentProjectName}
      data-open={terminalOpen ? "true" : "false"}
      className="absolute inset-0 z-20 min-h-0 flex-col bg-[var(--term-bg)]"
      style={{ display: terminalOpen ? "flex" : "none" }}
      aria-hidden={!terminalOpen}
      aria-label="Full-screen terminal"
    >
      <div className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-weak)] bg-[var(--surface)]">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <div className="flex min-w-0 flex-1 overflow-x-auto">
              {projectTabs.map((tab) => (
                <TerminalTabItem
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeTabId}
                  onActivate={() => setActiveTab(currentProjectName, tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <button
          type="button"
          data-testid="terminal-new-tab"
          onClick={openProjectTab}
          className="flex h-8 w-8 shrink-0 items-center justify-center border-l border-[var(--border-weak)] text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
          aria-label="New terminal tab"
        >
          +
        </button>
        <button
          type="button"
          data-testid="terminal-close-mode"
          onClick={closeTerminalMode}
          className="flex h-8 w-8 shrink-0 items-center justify-center border-l border-[var(--border-weak)] text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--red)]"
          aria-label="Close terminal mode"
        >
          ×
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <TerminalManager />
      </div>
    </section>
  );
}
