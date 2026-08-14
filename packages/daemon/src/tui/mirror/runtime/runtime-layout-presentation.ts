import type {
  OpenTuiWorkspaceLayoutSnapshot,
  OpenTuiWorkspaceRuntimePort,
} from "../open-tui-workspace-runtime-port.ts";
import type { OpenTuiTerminalLayout } from "./terminal-layout-projection.ts";

type OpenTuiLayoutPort = Pick<OpenTuiWorkspaceRuntimePort, "onLayout">;

export interface OpenTuiRuntimeLayoutPresentation {
  getSnapshot(): OpenTuiTerminalLayout | null;
  getWindowSnapshot(): OpenTuiWorkspaceLayoutSnapshot;
  subscribe(listener: (layout: OpenTuiTerminalLayout | null) => void): () => void;
  subscribeWindows(listener: (layout: OpenTuiWorkspaceLayoutSnapshot) => void): () => void;
  adopt(port: OpenTuiLayoutPort): () => void;
  clear(): void;
  dispose(): void;
}

/**
 * Renderer-local presentation selector. WorkspaceClient activates a physical
 * port by subscribing to its authority; the host calls `adopt` at that exact
 * boundary, so a preparing candidate can never blank or overwrite the retained
 * frame before the client's atomic runtime swap.
 */
export function createOpenTuiRuntimeLayoutPresentation(): OpenTuiRuntimeLayoutPresentation {
  const listeners = new Set<(layout: OpenTuiTerminalLayout | null) => void>();
  const windowListeners = new Set<(layout: OpenTuiWorkspaceLayoutSnapshot) => void>();
  let currentPort: OpenTuiLayoutPort | null = null;
  let current: OpenTuiTerminalLayout | null = null;
  let windows: OpenTuiWorkspaceLayoutSnapshot = Object.freeze({
    current: null,
    windows: Object.freeze([]),
  });
  let stopLayout: (() => void) | null = null;
  let disposed = false;
  const publish = (layout: OpenTuiWorkspaceLayoutSnapshot): void => {
    windows = layout;
    current = layout.current;
    for (const listener of [...listeners]) {
      try {
        listener(layout.current);
      } catch {
        // Presentation observers never own physical runtime lifecycle.
      }
    }
    for (const listener of [...windowListeners]) {
      try {
        listener(layout);
      } catch {
        // Presentation observers never own physical runtime lifecycle.
      }
    }
  };
  return {
    getSnapshot: () => current,
    getWindowSnapshot: () => windows,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    subscribeWindows(listener) {
      if (disposed) return () => undefined;
      windowListeners.add(listener);
      listener(windows);
      return () => windowListeners.delete(listener);
    },
    adopt(port) {
      if (disposed) return () => undefined;
      let candidate = true;
      let candidateStop: (() => void) | null = null;
      candidateStop = port.onLayout((layout) => {
        if (disposed || !candidate || !layout.current) return;
        if (currentPort !== port) {
          const previousStop = stopLayout;
          currentPort = port;
          stopLayout = candidateStop;
          publish(layout);
          previousStop?.();
          return;
        }
        publish(layout);
      });
      // `onLayout` intentionally seeds synchronously. Capture the disposer
      // after that first callback has promoted this candidate.
      if (currentPort === port && stopLayout === null) stopLayout = candidateStop;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        candidate = false;
        candidateStop?.();
        if (currentPort === port) {
          stopLayout = null;
          currentPort = null;
        }
      };
    },
    clear() {
      if (disposed) return;
      stopLayout?.();
      stopLayout = null;
      currentPort = null;
      publish(Object.freeze({ current: null, windows: Object.freeze([]) }));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopLayout?.();
      stopLayout = null;
      currentPort = null;
      current = null;
      windows = Object.freeze({ current: null, windows: Object.freeze([]) });
      listeners.clear();
      windowListeners.clear();
    },
  };
}
