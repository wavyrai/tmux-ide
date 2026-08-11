export type OpenTuiLocalSurface =
  | "home"
  | "terminals"
  | "files"
  | "changes"
  | "missions"
  | "activity";
export type OpenTuiLocalFocusZone = "sidebar" | "canvas" | "dock-tabs" | "dock-body";
export type OpenTuiLocalDockMode = "collapsed" | "open" | "maximized";

export interface OpenTuiLocalViewState {
  readonly revision: number;
  readonly workspaceId: string | null;
  readonly focusedPaneId: string | null;
  readonly surface: OpenTuiLocalSurface;
  readonly focusZone: OpenTuiLocalFocusZone;
  readonly dockMode: OpenTuiLocalDockMode;
  readonly paletteOpen: boolean;
}

export interface OpenTuiCanonicalNavigationFacts {
  readonly workspaceIds: readonly string[];
  readonly paneIds: readonly string[];
  readonly activeWorkspaceId?: string | null;
  readonly activePaneId?: string | null;
}

type LocalViewListener = (state: OpenTuiLocalViewState) => void;

const initialState = (
  state: Partial<Omit<OpenTuiLocalViewState, "revision">>,
): OpenTuiLocalViewState => ({
  revision: 0,
  workspaceId: state.workspaceId ?? null,
  focusedPaneId: state.focusedPaneId ?? null,
  surface: state.surface ?? "terminals",
  focusZone: state.focusZone ?? "canvas",
  dockMode: state.dockMode ?? "open",
  paletteOpen: state.paletteOpen ?? false,
});

/** Renderer-local navigation. Canonical snapshots only reconcile dead IDs. */
export class OpenTuiLocalViewController {
  #state: OpenTuiLocalViewState;
  #listeners = new Set<LocalViewListener>();
  #disposed = false;

  constructor(state: Partial<Omit<OpenTuiLocalViewState, "revision">> = {}) {
    this.#state = initialState(state);
  }

  getState(): OpenTuiLocalViewState {
    return this.#state;
  }

  subscribe(listener: LocalViewListener): () => void {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(patch: Partial<Omit<OpenTuiLocalViewState, "revision">>): OpenTuiLocalViewState {
    if (this.#disposed) return this.#state;
    const candidate = { ...this.#state, ...patch };
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).some(
      (key) => candidate[key] !== this.#state[key],
    );
    if (!changed) return this.#state;
    this.#state = { ...candidate, revision: this.#state.revision + 1 };
    for (const listener of this.#listeners) listener(this.#state);
    return this.#state;
  }

  reconcile(facts: OpenTuiCanonicalNavigationFacts): OpenTuiLocalViewState {
    if (this.#disposed) return this.#state;
    const workspaceId =
      this.#state.workspaceId && facts.workspaceIds.includes(this.#state.workspaceId)
        ? this.#state.workspaceId
        : facts.activeWorkspaceId && facts.workspaceIds.includes(facts.activeWorkspaceId)
          ? facts.activeWorkspaceId
          : (facts.workspaceIds[0] ?? null);
    const focusedPaneId =
      this.#state.focusedPaneId && facts.paneIds.includes(this.#state.focusedPaneId)
        ? this.#state.focusedPaneId
        : facts.activePaneId && facts.paneIds.includes(facts.activePaneId)
          ? facts.activePaneId
          : (facts.paneIds[0] ?? null);
    return this.update({ workspaceId, focusedPaneId });
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}
