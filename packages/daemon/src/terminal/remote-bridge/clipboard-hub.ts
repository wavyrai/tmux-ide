import type { RemoteClipboardEvent } from "@tmux-ide/contracts";

/** One clipboard frame per pane per window: at most four a second. */
export const REMOTE_CLIPBOARD_WINDOW_MS = 250;
/** Quiet panes are forgotten once the table holds this many. */
const PRUNE_AT = 256;

export interface RemoteClipboardSink {
  publish(event: RemoteClipboardEvent): void;
}

interface PaneWindow {
  lastSent: number;
  pending: RemoteClipboardEvent | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Fans clipboard reports from pane interpreters out to bridge connections.
 *
 * The first write from a quiet pane goes out at once. Later writes inside the
 * same window replace each other, and only the last one goes out when the
 * window ends. Nothing is kept for connections that open later, and nothing is
 * tracked while no connection listens.
 */
export class RemoteClipboardHub implements RemoteClipboardSink {
  readonly #listeners = new Set<(event: RemoteClipboardEvent) => void>();
  readonly #panes = new Map<string, PaneWindow>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  subscribe(listener: (event: RemoteClipboardEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#forgetAll();
    };
  }

  publish(event: RemoteClipboardEvent): void {
    if (this.#listeners.size === 0) return;
    const now = this.#now();
    this.#prune(now);
    const pane = this.#panes.get(event.paneId);
    if (pane && (pane.timer || now - pane.lastSent < REMOTE_CLIPBOARD_WINDOW_MS)) {
      pane.pending = event;
      if (!pane.timer) {
        pane.timer = setTimeout(
          () => this.#flush(event.paneId),
          REMOTE_CLIPBOARD_WINDOW_MS - (now - pane.lastSent),
        );
        pane.timer.unref?.();
      }
      return;
    }
    this.#panes.set(event.paneId, { lastSent: now, pending: null, timer: null });
    this.#send(event);
  }

  /** Panes with a window still open or recently used (tests). */
  trackedPanes(): number {
    return this.#panes.size;
  }

  #flush(paneId: string): void {
    const pane = this.#panes.get(paneId);
    if (!pane) return;
    pane.timer = null;
    const event = pane.pending;
    pane.pending = null;
    if (!event) return;
    pane.lastSent = this.#now();
    this.#send(event);
  }

  #send(event: RemoteClipboardEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One connection's failure never blocks another's copy.
      }
    }
  }

  #prune(now: number): void {
    if (this.#panes.size < PRUNE_AT) return;
    for (const [paneId, pane] of this.#panes)
      if (!pane.timer && now - pane.lastSent >= REMOTE_CLIPBOARD_WINDOW_MS)
        this.#panes.delete(paneId);
  }

  #forgetAll(): void {
    for (const pane of this.#panes.values()) if (pane.timer) clearTimeout(pane.timer);
    this.#panes.clear();
  }
}

/** The daemon-wide hub every pane interpreter reports to. */
export const daemonRemoteClipboardHub = new RemoteClipboardHub();
