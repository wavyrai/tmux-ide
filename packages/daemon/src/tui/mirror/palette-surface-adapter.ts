import type { Tab } from "./app-state.ts";
import type { PaletteAction, PaletteRow } from "./palette.ts";
import type {
  CommandPaletteDescriptor,
  CommandPaletteProjection,
} from "./workspace/command-palette-surface.ts";
import type { WorkspaceIconId } from "./workspace/icons.ts";

export interface PaletteSurfaceAdapterContext {
  currentTab?: Tab;
  currentViewId?: string | null;
  currentSession?: string | null;
  syncOn?: boolean;
  saveState?: PaletteSaveState;
  /** Return a reason to disable an otherwise offered action. */
  disabledReason?: (action: PaletteAction) => string | null | undefined;
  fallbackGroup?: string;
}

export interface PaletteSaveState {
  hasBuffer: boolean;
  hasPath: boolean;
  readOnlyReason: string | null;
}

export interface PaletteActionLevelRestore {
  selectedCommandId: string | null;
  scrollTop: number;
}

/**
 * Single-writer authority for the asynchronous tmux paste-buffer picker.
 * Leaving/reopening the palette invalidates all prior request generations, and
 * starting a newer request prevents an older completion from winning.
 */
export class PaletteBufferLoadGate {
  #generation = 0;

  begin(): number {
    this.#generation += 1;
    return this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  commit(generation: number, effect: () => void): boolean {
    if (!this.isCurrent(generation)) return false;
    effect();
    return true;
  }
}

export interface PaletteSurfaceEntry {
  id: string;
  action: PaletteAction;
  descriptor: CommandPaletteDescriptor;
  /** Index in CommandPaletteSurface's group + command candidate stream. */
  candidateIndex: number;
}

function actionPayload(action: PaletteAction): string {
  switch (action.kind) {
    case "tab":
      return action.tab;
    case "view":
      return action.viewId;
    case "attach":
      return action.session;
    case "jump-agent":
      return `${action.session}:${action.paneId}`;
    case "restart-agent":
    case "stop-agent":
      return `${action.session}:${action.agentKind}:${action.paneId}`;
    case "open-file":
    case "go-file":
      return action.path;
    case "rename-window":
      return action.name;
    case "select-layout":
      return action.layout;
    case "settings":
      return action.id;
    default:
      return "";
  }
}

/** Runtime-stable identity. Unlike usage keys, dynamic file and pane rows stay distinct. */
export function paletteCommandId(action: PaletteAction): string {
  const payload = actionPayload(action);
  return `palette.${action.kind}${payload ? `:${encodeURIComponent(payload)}` : ""}`;
}

function iconForAction(action: PaletteAction): WorkspaceIconId {
  switch (action.kind) {
    case "tab":
      return action.tab === "home"
        ? "home"
        : action.tab === "terminal"
          ? "terminals"
          : action.tab === "files"
            ? "files"
            : "changes";
    case "view":
      return "native";
    case "open-folder":
    case "open-file":
    case "go-file":
    case "save":
      return "files";
    case "attach":
    case "jump-agent":
    case "new-agent":
    case "new-agent-again":
    case "manage-team":
    case "restart-agent":
    case "stop-agent":
    case "search-scrollback":
    case "paste-buffer":
    case "select-text":
      return "terminals";
    case "refresh-diff":
      return "changes";
    case "new-window":
      return "pop-out";
    case "rename-window":
      return "command";
    case "kill-window":
    case "quit":
      return "close";
    case "zoom-pane":
      return "maximize";
    case "swap-pane":
    case "rotate-window":
      return "move";
    case "break-pane":
      return "split-right";
    case "select-layout":
    case "resize-window":
      return "resize";
    case "sync-toggle":
      return "refresh";
    case "settings":
      return "native";
  }
}

function categoryForAction(action: PaletteAction): string {
  switch (action.kind) {
    case "tab":
    case "view":
    case "open-folder":
    case "attach":
      return "Navigation";
    case "jump-agent":
    case "new-agent":
    case "new-agent-again":
    case "manage-team":
    case "restart-agent":
    case "stop-agent":
      return "Agents";
    case "open-file":
    case "go-file":
    case "save":
      return "Files";
    case "refresh-diff":
      return "Changes";
    case "paste-buffer":
    case "search-scrollback":
    case "select-text":
      return "Terminal";
    case "new-window":
    case "rename-window":
    case "kill-window":
    case "zoom-pane":
    case "swap-pane":
    case "break-pane":
    case "rotate-window":
    case "sync-toggle":
    case "resize-window":
      return "Window";
    case "select-layout":
      return "Layout";
    case "settings":
      return "Settings";
    case "quit":
      return "Application";
  }
}

function detailForAction(action: PaletteAction): string {
  switch (action.kind) {
    case "tab":
    case "view":
      return "Switch the active workspace surface";
    case "open-folder":
      return "Open or create a workspace from a folder";
    case "attach":
      return `Open the ${action.session} workspace`;
    case "jump-agent":
      return `Focus ${action.session} pane ${action.paneId}`;
    case "new-agent":
      return "Choose a harness and placement";
    case "new-agent-again":
      return "Repeat the last agent launch in this context";
    case "manage-team":
      return "Jump, restart, stop, or add an agent";
    case "restart-agent":
      return `Restart ${action.agentKind} in ${action.session}`;
    case "stop-agent":
      return `Stop ${action.agentKind} in ${action.session}`;
    case "open-file":
    case "go-file":
      return action.path;
    case "save":
      return "Write the current editor buffer";
    case "refresh-diff":
      return "Reload changed files and their diff";
    case "paste-buffer":
      return "Choose from tmux paste buffers";
    case "search-scrollback":
      return "Search the focused terminal's history";
    case "new-window":
      return "Create a tmux window in this workspace";
    case "rename-window":
      return `Rename the active window to ${action.name}`;
    case "kill-window":
      return "Close the active tmux window";
    case "zoom-pane":
      return "Toggle focus on the active terminal pane";
    case "swap-pane":
      return "Swap the active pane with the next pane";
    case "break-pane":
      return "Move the active pane into its own window";
    case "rotate-window":
      return "Rotate panes through the current layout";
    case "select-layout":
      return `Apply the ${action.layout} tmux layout`;
    case "sync-toggle":
      return "Toggle synchronized input for this window";
    case "select-text":
      return "Temporarily capture text instead of app mouse input";
    case "resize-window":
      return "Reclaim the tmux window at this app's canvas size";
    case "settings":
      return "Configure tmux-ide";
    case "quit":
      return "Close this app without sending Ctrl-C to a pane";
  }
}

function isCurrent(action: PaletteAction, context: PaletteSurfaceAdapterContext): boolean {
  if (action.kind === "tab") return action.tab === context.currentTab;
  if (action.kind === "view") return action.viewId === context.currentViewId;
  if (action.kind === "attach") return action.session === context.currentSession;
  if (action.kind === "sync-toggle") return context.syncOn === true;
  return false;
}

function statusForAction(
  action: PaletteAction,
  context: PaletteSurfaceAdapterContext,
): string | null {
  if (action.kind === "sync-toggle") return context.syncOn ? "on" : "off";
  if (action.kind === "jump-agent") return action.session;
  if (action.kind === "attach" && action.session === context.currentSession) return "current";
  return null;
}

function disabledReason(
  action: PaletteAction,
  context: PaletteSurfaceAdapterContext,
): string | null {
  const explicit = context.disabledReason?.(action)?.trim();
  if (explicit) return explicit;
  if (action.kind === "save" && context.saveState) {
    if (!context.saveState.hasBuffer || !context.saveState.hasPath) return "No file is open";
    if (context.saveState.readOnlyReason) return "File is read-only";
  }
  return null;
}

/** Adapt the ranked legacy action rows without changing their order or execution identity. */
export function adaptPaletteRowsToCommands(
  rows: readonly PaletteRow[],
  context: PaletteSurfaceAdapterContext = {},
): PaletteSurfaceEntry[] {
  const hasExplicitGroups = rows.some((row) => row.type === "header");
  let group = context.fallbackGroup?.trim() || "Commands";
  let candidateIndex = 0;
  const seenGroups = new Set<string>();
  const entries: PaletteSurfaceEntry[] = [];

  for (const row of rows) {
    if (row.type === "header") {
      group = row.label;
      continue;
    }
    const normalizedGroup = hasExplicitGroups ? group : context.fallbackGroup?.trim() || "Commands";
    if (!seenGroups.has(normalizedGroup)) {
      seenGroups.add(normalizedGroup);
      candidateIndex += 1;
    }
    const id = paletteCommandId(row.action);
    const current = isCurrent(row.action, context);
    const descriptor: CommandPaletteDescriptor = {
      id,
      icon: iconForAction(row.action),
      label: row.action.label,
      detail: detailForAction(row.action),
      category: categoryForAction(row.action),
      group: normalizedGroup,
      shortcut: row.shortcut,
      status: statusForAction(row.action, context),
      disabledReason: disabledReason(row.action, context),
      current,
    };
    entries.push({ id, action: row.action, descriptor, candidateIndex });
    candidateIndex += 1;
  }
  return entries;
}

export function firstEnabledPaletteCommandId(
  entries: readonly PaletteSurfaceEntry[],
): string | null {
  return entries.find((entry) => !entry.descriptor.disabledReason)?.id ?? null;
}

export function stepEnabledPaletteCommandId(
  entries: readonly PaletteSurfaceEntry[],
  selectedId: string | null,
  direction: 1 | -1,
): string | null {
  const current = entries.findIndex((entry) => entry.id === selectedId);
  const start = current < 0 ? (direction === 1 ? -1 : entries.length) : current;
  for (let index = start + direction; index >= 0 && index < entries.length; index += direction) {
    if (!entries[index]!.descriptor.disabledReason) return entries[index]!.id;
  }
  return current >= 0 ? selectedId : firstEnabledPaletteCommandId(entries);
}

export function paletteActionForCommand(
  entries: readonly PaletteSurfaceEntry[],
  commandId: string | null,
): PaletteAction | null {
  const entry = entries.find((candidate) => candidate.id === commandId);
  return entry && !entry.descriptor.disabledReason ? entry.action : null;
}

/** The only action-level activation gate; disabled/missing rows never reach app effects. */
export function dispatchPaletteCommand(
  entries: readonly PaletteSurfaceEntry[],
  commandId: string | null,
  execute: (action: PaletteAction) => void,
): boolean {
  const action = paletteActionForCommand(entries, commandId);
  if (!action) return false;
  execute(action);
  return true;
}

export function ensurePaletteSelectionVisible(
  projection: CommandPaletteProjection,
  entries: readonly PaletteSurfaceEntry[],
  commandId: string | null,
): number {
  if (!commandId) return projection.scrollTop;
  if (projection.rows.some((row) => row.kind === "command" && row.commandId === commandId)) {
    return projection.scrollTop;
  }
  const entry = entries.find((candidate) => candidate.id === commandId);
  if (!entry) return projection.scrollTop;
  return Math.max(0, Math.min(entry.candidateIndex, Math.max(0, projection.contentRowCount - 1)));
}

/** Return from the tmux buffer picker to its visible, selected parent action. */
export function restorePaletteActionLevelFromBuffers(
  projection: CommandPaletteProjection,
  entries: readonly PaletteSurfaceEntry[],
): PaletteActionLevelRestore {
  const parent = entries.find(
    (entry) => entry.action.kind === "paste-buffer" && !entry.descriptor.disabledReason,
  );
  const selectedCommandId = parent?.id ?? firstEnabledPaletteCommandId(entries);
  return {
    selectedCommandId,
    scrollTop: ensurePaletteSelectionVisible(projection, entries, selectedCommandId),
  };
}

export function appendPalettePaste(query: string, text: string): string {
  // Palette queries are a single terminal row; collapse pasted control runs so
  // they can never leak escape sequences or create invisible command text.
  // eslint-disable-next-line no-control-regex
  return query + text.replace(/[\x00-\x1f\x7f]+/g, " ");
}
