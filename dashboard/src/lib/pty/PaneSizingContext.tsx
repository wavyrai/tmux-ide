/**
 * PaneSizingContext — broadcasts pane geometry to every session in
 * the pane (G20-P2).
 *
 * The active PtyPane reports cols/rows after each ResizeObserver
 * fire. The provider debounces ~60ms and pushes the resize to every
 * registered session id — including background tabs, so when the
 * user flips to a background tab its xterm is already correctly
 * sized.
 *
 * Module-level `paneRegistry` lets code outside the Solid tree (e.g.
 * a hover pre-warm in the tab strip) measure the pane container
 * without having to mount a Terminal inside it.
 */

import {
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { measureDimensions, type TerminalDimensions } from "./dimensions";
import { peekSession } from "./sessionPool";

const RESIZE_DEBOUNCE_MS = 60;
const MIN_COLS = 2;
const MIN_ROWS = 1;

const paneRegistry = new Map<string, HTMLDivElement>();

export function getPaneContainer(paneId: string): HTMLDivElement | null {
  return paneRegistry.get(paneId) ?? null;
}

export interface PaneSizingContextValue {
  /** Called by the active terminal after a ResizeObserver fire. */
  reportDimensions: (cols: number, rows: number) => void;
  /** Last reported dimensions for this pane, or null. */
  getCurrentDimensions: () => { cols: number; rows: number } | null;
  /** Accessor over the wrapper div — null until mount. */
  containerRef: Accessor<HTMLDivElement | null>;
  /** Measure the wrapper using cell metrics; null when offscreen. */
  measureCurrentDimensions: (cellWidth: number, cellHeight: number) => TerminalDimensions | null;
}

const Ctx = createContext<PaneSizingContextValue | null>(null);

export function usePaneSizingContext(): PaneSizingContextValue | null {
  return useContext(Ctx);
}

export interface PaneSizingProviderProps {
  paneId: string;
  /** Session ids that belong to this pane (active + background). */
  sessionIds: ReadonlyArray<string>;
  children: JSX.Element;
}

export function PaneSizingProvider(props: PaneSizingProviderProps) {
  const [containerEl, setContainerEl] = createSignal<HTMLDivElement | null>(null);
  let lastDims: { cols: number; rows: number } | null = null;
  let pendingDims: { cols: number; rows: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let prevSessionIds: ReadonlyArray<string> = [];

  const flush = () => {
    timer = null;
    const dims = pendingDims;
    pendingDims = null;
    if (!dims) return;
    lastDims = dims;
    for (const id of props.sessionIds) {
      peekSession(id)?.pty?.resize(dims.cols, dims.rows);
    }
  };

  const reportDimensions = (cols: number, rows: number) => {
    const c = Math.max(MIN_COLS, cols);
    const r = Math.max(MIN_ROWS, rows);
    pendingDims = { cols: c, rows: r };
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, RESIZE_DEBOUNCE_MS);
  };

  const getCurrentDimensions = () => lastDims;

  const measureCurrentDimensions = (cellWidth: number, cellHeight: number) => {
    const el = containerEl();
    if (!el) return null;
    return measureDimensions(el, cellWidth, cellHeight);
  };

  // Register the pane in the module-level registry once we have a
  // container. The cleanup removes us on unmount so callers don't see
  // stale entries.
  onMount(() => {
    const el = containerEl();
    if (el) paneRegistry.set(props.paneId, el);
    onCleanup(() => {
      paneRegistry.delete(props.paneId);
      if (timer) clearTimeout(timer);
    });
  });

  // Push current geometry to *newly-added* sessions so background
  // tabs catch up the moment they join the pane.
  createEffect(() => {
    const current = props.sessionIds;
    const dims = lastDims;
    if (dims) {
      for (const id of current) {
        if (prevSessionIds.includes(id)) continue;
        peekSession(id)?.pty?.resize(dims.cols, dims.rows);
      }
    }
    prevSessionIds = current;
  });

  return (
    <Ctx.Provider
      value={{
        reportDimensions,
        getCurrentDimensions,
        containerRef: containerEl,
        measureCurrentDimensions,
      }}
    >
      <div
        data-testid={`pane-sizing-${props.paneId}`}
        ref={(el) => setContainerEl(el)}
        class="flex min-h-0 flex-1 flex-col"
      >
        {props.children}
      </div>
    </Ctx.Provider>
  );
}
