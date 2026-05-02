"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { fetchPanes, type PaneData } from "@/lib/api";
import { useKeybind } from "@/lib/useKeybinds";
import { useLayoutState } from "@/lib/useLayoutState";
import { useToasts } from "@/lib/useToasts";

function projectFromPath(pathname: string): string {
  const match = pathname.match(/^\/project\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : "default";
}

function paneTitle(projectName: string, pane: PaneData): string {
  return `${projectName} · ${pane.name || pane.title || pane.id}`;
}

function paneStatus(pane: PaneData | undefined): "busy" | "idle" | null {
  if (!pane) return null;
  const command = pane.currentCommand.toLowerCase();
  return command === "zsh" || command === "bash" || command === "sh" || command === "fish"
    ? "idle"
    : "busy";
}

export function FullScreenTerminal() {
  const pathname = usePathname();
  const currentProjectName = projectFromPath(pathname);
  const { push } = useToasts();
  const populatedProjectsRef = useRef(new Set<string>());
  const loadingProjectsRef = useRef(new Set<string>());
  const [livePanes, setLivePanes] = useState<PaneData[]>([]);
  const [panePickerOpen, setPanePickerOpen] = useState(false);
  const [panePickerLoading, setPanePickerLoading] = useState(false);
  const {
    terminalOpen,
    toggleTerminal,
    closeTerminalMode,
    newTab,
    newPaneTab,
    closeTab,
    setActiveTab,
    reorderTabs,
    getProjectTabs,
    getActiveTabId,
  } = useLayoutState();

  const projectTabs = getProjectTabs(currentProjectName);
  const activeTabId = getActiveTabId(currentProjectName);
  const projectTabsRef = useRef(projectTabs);
  useEffect(() => {
    projectTabsRef.current = projectTabs;
  }, [projectTabs]);
  const livePanesById = useMemo(
    () => new Map(livePanes.map((pane) => [pane.id, pane])),
    [livePanes],
  );
  const openPaneIds = useMemo(
    () => new Set(projectTabs.flatMap((tab) => (tab.paneId ? [tab.paneId] : []))),
    [projectTabs],
  );
  const attachablePanes = useMemo(
    () => livePanes.filter((pane) => !openPaneIds.has(pane.id)),
    [livePanes, openPaneIds],
  );

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const tabIds = useMemo(() => projectTabs.map((tab) => tab.id), [projectTabs]);
  const projectTabSignature = useMemo(
    () => projectTabs.map((tab) => `${tab.id}:${tab.paneId ?? ""}`).join("\n"),
    [projectTabs],
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
      populatedProjectsRef.current.clear();
      loadingProjectsRef.current.clear();
      setPanePickerOpen(false);
    }
  }, [terminalOpen]);

  // First open for a project attaches a tab per live tmux pane. If the command
  // center has no session for this project, preserve the old bash-tab fallback.
  useEffect(() => {
    if (!terminalOpen) return;
    if (loadingProjectsRef.current.has(currentProjectName)) return;
    if (projectTabs.length > 0 && populatedProjectsRef.current.has(currentProjectName)) return;

    let cancelled = false;
    const existingTabs = projectTabs;
    loadingProjectsRef.current.add(currentProjectName);

    async function populateFromPanes() {
      try {
        const panes = await fetchPanes(currentProjectName);
        if (cancelled) return;

        populatedProjectsRef.current.add(currentProjectName);
        setLivePanes(panes);
        const livePaneIds = new Set(panes.map((pane) => pane.id));

        for (const tab of existingTabs) {
          if (!tab.paneId || livePaneIds.has(tab.paneId)) continue;
          closeTab(tab.id);
          push({
            kind: "warning",
            title: `Pane ${tab.title} ended`,
            scope: { project: currentProjectName },
          });
        }

        if (existingTabs.length > 0) return;

        if (panes.length === 0) {
          newTab(currentProjectName);
          push({
            kind: "info",
            title: "No live tmux session",
            body: "Opened a standalone shell instead.",
            scope: { project: currentProjectName },
          });
          return;
        }

        for (const pane of panes) {
          newPaneTab(currentProjectName, pane.id, paneTitle(currentProjectName, pane));
        }

        const activePane = panes.find((pane) => pane.active) ?? panes[0];
        if (activePane) {
          setActiveTab(currentProjectName, `${currentProjectName}:${activePane.id}`);
        }
      } catch {
        if (cancelled || existingTabs.length > 0) return;
        newTab(currentProjectName);
        push({
          kind: "info",
          title: "No live tmux session",
          body: "Opened a standalone shell instead.",
          scope: { project: currentProjectName },
        });
      } finally {
        loadingProjectsRef.current.delete(currentProjectName);
      }
    }

    void populateFromPanes();
    return () => {
      cancelled = true;
    };
  }, [
    closeTab,
    currentProjectName,
    newPaneTab,
    newTab,
    projectTabSignature,
    projectTabs,
    push,
    setActiveTab,
    terminalOpen,
  ]);

  const openPanePicker = useCallback(async () => {
    setPanePickerOpen((open) => !open);
    setPanePickerLoading(true);
    const panes = await fetchPanes(currentProjectName);
    setLivePanes(panes);
    setPanePickerLoading(false);
  }, [currentProjectName]);

  const attachPane = useCallback(
    (pane: PaneData) => {
      newPaneTab(currentProjectName, pane.id, paneTitle(currentProjectName, pane));
      setPanePickerOpen(false);
    },
    [currentProjectName, newPaneTab],
  );

  const handleSessionExit = useCallback(
    (id: string) => {
      const tab = projectTabsRef.current.find((candidate) => candidate.id === id);
      if (!tab?.paneId) return;
      closeTab(id);
      push({
        kind: "warning",
        title: `Pane ${tab.title} ended`,
        scope: { project: currentProjectName },
      });
    },
    [closeTab, currentProjectName, push],
  );

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
                  paneStatus={paneStatus(tab.paneId ? livePanesById.get(tab.paneId) : undefined)}
                  onActivate={() => setActiveTab(currentProjectName, tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <div className="relative">
          <button
            type="button"
            data-testid="terminal-new-tab"
            onClick={openPanePicker}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-l border-[var(--border-weak)] text-[var(--dim)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--accent)]"
            aria-label="New terminal tab"
          >
            +
          </button>
          {panePickerOpen && (
            <div
              data-testid="terminal-pane-picker"
              className="absolute right-0 top-9 z-30 w-64 border border-[var(--border)] bg-[var(--surface)] py-1 shadow-lg"
            >
              {panePickerLoading ? (
                <div className="px-3 py-2 text-[12px] text-[var(--dim)]">Loading panes</div>
              ) : attachablePanes.length > 0 ? (
                attachablePanes.map((pane) => (
                  <button
                    key={pane.id}
                    type="button"
                    data-testid={`terminal-pane-option-${pane.id}`}
                    onClick={() => attachPane(pane)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        paneStatus(pane) === "busy" ? "bg-[var(--accent)]" : "bg-[var(--dimmer)]"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{pane.name || pane.title}</span>
                    <span className="shrink-0 text-[var(--dim)]">{pane.id}</span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-[12px] text-[var(--dim)]">All panes attached</div>
              )}
              <button
                type="button"
                data-testid="terminal-bash-option"
                onClick={() => {
                  newTab(currentProjectName);
                  setPanePickerOpen(false);
                }}
                className="mt-1 flex w-full items-center border-t border-[var(--border-weak)] px-3 py-2 text-left text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover)]"
              >
                + bash shell
              </button>
            </div>
          )}
        </div>
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
        <TerminalManager onSessionExit={handleSessionExit} />
      </div>
    </section>
  );
}
