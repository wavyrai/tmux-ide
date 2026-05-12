/**
 * Shared types for v2 Solid widget mounts.
 *
 * Each widget exports a `mount(container, opts)` function and returns a
 * MountHandle so the React side can update options without remount.
 */

export interface BaseMountOptions {
  /** Project name (matches a tmux-ide session). Used to derive API URLs. */
  sessionName: string;
  /** Daemon API base URL, e.g. http://127.0.0.1:6060 — usually empty for same-origin. */
  apiBaseUrl: string;
  /** Optional auth token for the daemon. */
  bearerToken: string | null;
}

export interface MountHandle {
  unmount(): void;
  setOptions(next: Partial<BaseMountOptions>): void;
}

export interface ExplorerMountOptions extends BaseMountOptions {
  /** Called when the user activates a file (Enter / l / right). The host
   *  decides what to do (e.g. switch to a Preview view). */
  onOpenFile?: (path: string) => void;
}

export interface ExplorerMountHandle {
  unmount(): void;
  setOptions(next: Partial<ExplorerMountOptions>): void;
}

export interface PlansRailMountOptions extends BaseMountOptions {
  /** Currently selected plan file (e.g. "design.md"). The rail highlights
   *  the row whose `path` matches; pass null/undefined for no selection. */
  selectedFile?: string | null;
  /** Called when the user activates a row (click or Enter). The host
   *  decides what to do — typically setSelectedFile + load detail. */
  onSelect?: (filename: string) => void;
  /** Called when the user clicks the "New plan" footer button. The host
   *  is responsible for creating a stub plan and selecting it. */
  onCreate?: () => void;
}

export interface PlansRailMountHandle {
  unmount(): void;
  setOptions(next: Partial<PlansRailMountOptions>): void;
}
