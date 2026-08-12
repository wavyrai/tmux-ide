import { createMemo, createRoot, createSignal } from "solid-js";

import {
  clampPaletteTop,
  paletteContains,
  palettePos,
  paletteRowAt,
  paletteRows,
  paletteActionKey,
  type PaletteAction,
  type PaletteGeom,
  type TmuxBuffer,
} from "../../palette.ts";
import {
  adaptPaletteRowsToCommands,
  appendPalettePaste,
  dispatchPaletteCommand,
  ensurePaletteSelectionVisible,
  firstEnabledPaletteCommandId,
  restorePaletteActionLevelFromBuffers,
  stepEnabledPaletteCommandId,
} from "../../palette-surface-adapter.ts";
import {
  commandPaletteHitTest,
  projectCommandPalette,
} from "../../workspace/command-palette-surface.ts";
import type {
  PaletteAsyncState,
  PaletteFeatureSession,
  PaletteHostPort,
  PalettePointerEvent,
  PaletteWorkspaceIdentity,
} from "./contract.ts";
import { paletteWorkspaceIdentityScope } from "./contract.ts";

const EMPTY_REPO: readonly string[] = Object.freeze([]);
const EMPTY_BUFFERS: readonly TmuxBuffer[] = Object.freeze([]);
const BUFFER_PAGE_ROWS = 10;

const messageOf = (error: unknown) =>
  error instanceof Error && error.message.trim()
    ? error.message
    : "The palette source is unavailable.";

export function createPaletteFeatureSession(host: PaletteHostPort): PaletteFeatureSession {
  return createRoot((disposeRoot) => {
    const [isOpen, setOpen] = createSignal(false);
    const [isDisposed, setDisposed] = createSignal(false);
    const [level, setLevel] = createSignal<"actions" | "buffers">("actions");
    const [query, setQuery] = createSignal("");
    const [selectedCommandId, setSelectedCommandId] = createSignal<string | null>(null);
    const [selectedBufferIndex, setSelectedBufferIndex] = createSignal(0);
    const [scrollTop, setScrollTop] = createSignal(0);
    const [currentIdentity, setCurrentIdentity] = createSignal(host.identity());
    const [identityScope, setIdentityScope] = createSignal(
      paletteWorkspaceIdentityScope(currentIdentity()),
    );
    const [repo, setRepo] = createSignal<PaletteAsyncState<readonly string[]>>({
      phase: "idle",
      value: EMPTY_REPO,
    });
    const [buffers, setBuffers] = createSignal<PaletteAsyncState<readonly TmuxBuffer[]>>({
      phase: "idle",
      value: EMPTY_BUFFERS,
    });
    let asyncGeneration = 0;
    let repoAbort: AbortController | null = null;
    let bufferAbort: AbortController | null = null;

    const rows = createMemo(() => {
      const facts = host.facts();
      return paletteRows(query(), [...facts.sessions], {
        terminal: facts.terminal,
        surface: facts.surface,
        agents: [...facts.agents],
        panes: facts.panes,
        sizeMismatch: facts.sizeMismatch,
        appMousePane: facts.appMousePane,
        againName: facts.againName,
        usage: facts.usage,
        keycaps: facts.keycaps,
        repoFiles: repo().value,
        views: facts.views,
      });
    });
    const entries = createMemo(() => {
      const facts = host.facts();
      return adaptPaletteRowsToCommands(rows(), {
        currentSurface: facts.currentSurface,
        currentTab: facts.surface,
        currentViewId: facts.currentViewId,
        currentSession: facts.currentSession,
        syncOn: facts.syncOn,
        saveState: facts.saveState,
        multiplexerFacts: facts.multiplexerFacts,
        disabledReason: host.disabledReason,
        fallbackGroup: query().trim() ? "Results" : "Commands",
      });
    });
    const projection = createMemo(() => {
      const repoState = repo();
      return projectCommandPalette({
        width: host.width(),
        height: host.height(),
        query: query(),
        commands: entries().map((entry) => entry.descriptor),
        selectedCommandId: selectedCommandId(),
        scrollTop: scrollTop(),
        title: level() === "buffers" ? "Paste buffer" : "Navigator",
        queryPlaceholder: "Search · @workspaces @agents @panes @commands",
        phase: repoState.phase === "error" ? "error" : "ready",
        errorMessage: repoState.phase === "error" ? repoState.message : null,
        retryCommandId: "palette:retry-repo",
      });
    });

    const abortAsync = () => {
      asyncGeneration += 1;
      repoAbort?.abort();
      bufferAbort?.abort();
      repoAbort = null;
      bufferAbort = null;
    };
    const resetSelection = () => {
      setScrollTop(0);
      setSelectedCommandId(firstEnabledPaletteCommandId(entries()));
    };
    const selectCommand = (id: string | null) => {
      setSelectedCommandId(id);
      setScrollTop(ensurePaletteSelectionVisible(projection(), entries(), id));
    };
    const loadRepo = () => {
      if (isDisposed() || !isOpen()) return;
      repoAbort?.abort();
      const controller = new AbortController();
      repoAbort = controller;
      const generation = ++asyncGeneration;
      const identity = currentIdentity();
      const scope = paletteWorkspaceIdentityScope(identity);
      setRepo((current) => ({ phase: "loading", value: current.value }));
      void host.loadRepoFiles(identity, controller.signal).then(
        (files) => {
          if (
            controller.signal.aborted ||
            generation !== asyncGeneration ||
            scope !== identityScope()
          )
            return;
          setRepo({ phase: "ready", value: Object.freeze([...files]) });
          if (!selectedCommandId()) resetSelection();
        },
        (error) => {
          if (controller.signal.aborted || generation !== asyncGeneration) return;
          setRepo((current) => ({
            phase: "error",
            value: current.value,
            message: messageOf(error),
          }));
        },
      );
    };
    const loadBufferList = () => {
      if (isDisposed() || !isOpen()) return;
      repoAbort?.abort();
      repoAbort = null;
      if (repo().phase === "loading") {
        setRepo((current) => ({ phase: "idle", value: current.value }));
      }
      bufferAbort?.abort();
      const controller = new AbortController();
      bufferAbort = controller;
      const generation = ++asyncGeneration;
      const identity = currentIdentity();
      const scope = paletteWorkspaceIdentityScope(identity);
      setLevel("buffers");
      setSelectedBufferIndex(0);
      setScrollTop(0);
      setBuffers((current) => ({ phase: "loading", value: current.value }));
      void host.loadBuffers(identity, controller.signal).then(
        (value) => {
          if (
            controller.signal.aborted ||
            generation !== asyncGeneration ||
            scope !== identityScope()
          )
            return;
          setBuffers({ phase: "ready", value: Object.freeze([...value]) });
        },
        (error) => {
          if (controller.signal.aborted || generation !== asyncGeneration) return;
          setBuffers((current) => ({
            phase: "error",
            value: current.value,
            message: messageOf(error),
          }));
        },
      );
    };
    const backToActions = () => {
      bufferAbort?.abort();
      bufferAbort = null;
      asyncGeneration += 1;
      const restore = restorePaletteActionLevelFromBuffers(projection(), entries());
      setLevel("actions");
      setSelectedBufferIndex(0);
      setSelectedCommandId(restore.selectedCommandId);
      setScrollTop(restore.scrollTop);
      if (repo().phase !== "ready") loadRepo();
    };
    const bufferGeom = (): PaletteGeom => {
      const width = Math.min(64, Math.max(12, host.width() - 4));
      const position = palettePos(host.width(), host.height(), width);
      return {
        ...position,
        width,
        visibleRows: Math.min(BUFFER_PAGE_ROWS, Math.max(0, buffers().value.length - scrollTop())),
      };
    };
    const close = (reason: "escape" | "outside" | "action" = "escape") => {
      if (!isOpen()) return;
      abortAsync();
      setOpen(false);
      setLevel("actions");
      void host.dispatch({ kind: "close", reason });
    };
    const execute = (action: PaletteAction) => {
      if (action.kind === "paste-buffer") {
        loadBufferList();
        return;
      }
      close("action");
      void host.dispatch(
        action.kind === "settings"
          ? { kind: "settings", command: action.id, usageKey: paletteActionKey(action) }
          : { kind: "action", action, usageKey: paletteActionKey(action) },
      );
    };
    const activateSelected = () => dispatchPaletteCommand(entries(), selectedCommandId(), execute);

    const handleBufferKey = (name: string): boolean => {
      const state = buffers();
      if (name === "escape") {
        backToActions();
        return true;
      }
      if (name === "r" && state.phase === "error") {
        loadBufferList();
        return true;
      }
      if (name === "up" || name === "down") {
        const delta = name === "up" ? -1 : 1;
        const nextIndex = Math.max(
          0,
          Math.min(Math.max(0, state.value.length - 1), selectedBufferIndex() + delta),
        );
        setSelectedBufferIndex(nextIndex);
        setScrollTop((top) => {
          const visibleTop =
            nextIndex < top
              ? nextIndex
              : nextIndex >= top + BUFFER_PAGE_ROWS
                ? nextIndex - BUFFER_PAGE_ROWS + 1
                : top;
          return clampPaletteTop(visibleTop, state.value.length, BUFFER_PAGE_ROWS);
        });
        return true;
      }
      if (name === "return") {
        const buffer = state.value[selectedBufferIndex()];
        if (buffer) {
          close("action");
          void host.dispatch({ kind: "paste-buffer", bufferName: buffer.name });
        }
        return true;
      }
      return true;
    };

    const handleActionPointer = (event: PalettePointerEvent): boolean => {
      const hit = commandPaletteHitTest(projection(), event.x, event.y);
      if (event.kind === "scroll") {
        if (!hit) return true;
        const step = event.scrollDirection === "up" ? -3 : 3;
        setScrollTop((top) => Math.max(0, Math.min(projection().contentRowCount - 1, top + step)));
        return true;
      }
      if (event.kind === "move" && hit?.kind === "command" && !hit.disabled) {
        selectCommand(hit.commandId);
        return true;
      }
      if (event.kind !== "down") return true;
      if (!hit) {
        close("outside");
        return true;
      }
      if (event.button === 2) return true;
      if (hit.kind === "command" && !hit.disabled) {
        selectCommand(hit.commandId);
        dispatchPaletteCommand(entries(), hit.commandId, execute);
      } else if (hit.kind === "retry") {
        loadRepo();
      }
      return true;
    };

    const session: PaletteFeatureSession = {
      open: isOpen,
      disposed: isDisposed,
      snapshot: () => ({
        open: isOpen(),
        level: level(),
        query: query(),
        selectedCommandId: selectedCommandId(),
        selectedBufferIndex: selectedBufferIndex(),
        scrollTop: scrollTop(),
        entries: entries(),
        projection: projection(),
        repo: repo(),
        buffers: buffers(),
      }),
      projection,
      entries,
      openPalette() {
        if (isDisposed()) return;
        abortAsync();
        const nextIdentity = host.identity();
        const scope = paletteWorkspaceIdentityScope(nextIdentity);
        if (scope !== identityScope()) {
          setCurrentIdentity(nextIdentity);
          setIdentityScope(scope);
          setRepo({ phase: "idle", value: EMPTY_REPO });
          setBuffers({ phase: "idle", value: EMPTY_BUFFERS });
        }
        setQuery("");
        setLevel("actions");
        setOpen(true);
        resetSelection();
        if (repo().phase !== "ready") loadRepo();
      },
      close,
      openBufferPicker: loadBufferList,
      switchWorkspace(identity: PaletteWorkspaceIdentity) {
        const next = paletteWorkspaceIdentityScope(identity);
        if (next === identityScope()) return;
        abortAsync();
        setCurrentIdentity(identity);
        setIdentityScope(next);
        setRepo({ phase: "idle", value: EMPTY_REPO });
        setBuffers({ phase: "idle", value: EMPTY_BUFFERS });
        setLevel("actions");
        setQuery("");
        resetSelection();
        if (isOpen()) loadRepo();
      },
      retryRepoFiles: loadRepo,
      retryBuffers: loadBufferList,
      handleKey(event) {
        if (!isOpen() || isDisposed()) return false;
        if (level() === "buffers") return handleBufferKey(event.name);
        if (event.name === "escape") close("escape");
        else if (event.name === "return") activateSelected();
        else if (event.name === "up")
          selectCommand(stepEnabledPaletteCommandId(entries(), selectedCommandId(), -1));
        else if (event.name === "down")
          selectCommand(stepEnabledPaletteCommandId(entries(), selectedCommandId(), 1));
        else if (event.name === "backspace") {
          setQuery(query().slice(0, -1));
          resetSelection();
        } else if (event.name.length === 1 && !event.ctrl && !event.meta) {
          setQuery(query() + (event.shift ? event.name.toUpperCase() : event.name));
          resetSelection();
        }
        return true;
      },
      handlePaste(text) {
        if (!isOpen() || isDisposed() || level() === "buffers") return false;
        setQuery(appendPalettePaste(query(), text));
        resetSelection();
        return true;
      },
      handlePointer(event) {
        if (!isOpen() || isDisposed()) return false;
        if (level() === "buffers") {
          const geometry = bufferGeom();
          if (event.kind === "scroll") {
            if (!paletteContains(geometry, event.x, event.y)) return true;
            const step = event.scrollDirection === "up" ? -3 : 3;
            setScrollTop((top) =>
              clampPaletteTop(top + step, buffers().value.length, BUFFER_PAGE_ROWS),
            );
            return true;
          }
          const row = paletteRowAt(geometry, event.x, event.y);
          if (event.kind === "move" && row >= 0) {
            setSelectedBufferIndex(scrollTop() + row);
            return true;
          }
          if (event.kind === "down" && event.button !== 2) {
            if (!paletteContains(geometry, event.x, event.y)) {
              close("outside");
              return true;
            }
            if (row >= 0) {
              const index = scrollTop() + row;
              const buffer = buffers().value[index];
              if (buffer) {
                setSelectedBufferIndex(index);
                close("action");
                void host.dispatch({ kind: "paste-buffer", bufferName: buffer.name });
              }
            }
          }
          return true;
        }
        return handleActionPointer(event);
      },
      dispose() {
        if (isDisposed()) return;
        abortAsync();
        setOpen(false);
        setDisposed(true);
        disposeRoot();
      },
    };
    return Object.freeze(session);
  });
}
