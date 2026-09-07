import { batch, createSignal } from "solid-js";
import type { TerminalViewportOrigin } from "../terminal-viewport.ts";

/** Terminal mouse reports contain ticks, not macOS pixel offsets or phases.
 * Match tmux copy-mode's five rows per tick without adding another
 * acceleration/momentum curve. Fractional input still accumulates by row.
 * A short idle gap is the only available approximation of a gesture boundary.
 */
export function createTerminalWheelGesture() {
  let target: string | null = null;
  let lastAt = -Infinity;
  let remainder = 0;
  let direction = 0;
  let local = false;
  return {
    reset() {
      target = null;
      remainder = 0;
      local = false;
    },
    retainLocal() {
      local = true;
    },
    consume(key: string, sign: 1 | -1, delta = 1, at = performance.now()) {
      if (target !== key || at - lastAt > 160 || at < lastAt) {
        remainder = 0;
        local = false;
      }
      if (direction !== sign) remainder = 0;
      target = key;
      direction = sign;
      lastAt = at;
      const amount = Number.isFinite(delta) ? Math.abs(delta) : 0;
      remainder += Math.min(amount, 1024) * 5;
      const lines = Math.floor(remainder);
      remainder -= lines;
      return { lines: lines === 0 ? 0 : sign * lines, local };
    },
  };
}

interface ScrollbackSource {
  readonly renderSource: {
    scrollbackDepth(id: string): number;
    captureReadPosition?(
      id: string,
      origin: TerminalViewportOrigin,
    ): (() => TerminalViewportOrigin | null) | null;
    paneCanonicalIdentity?(id: string): {
      readonly historyTrim?: number;
      readonly viewCols?: number;
      readonly viewBackingRevision?: number;
      readonly viewRows?: number;
      readonly cols?: number;
      readonly rows?: number;
      readonly sourceEpoch?: number;
      readonly generation?: string;
      readonly incarnation?: string;
    } | null;
  };
  subscribePaneVersion(id: string, listener: () => void): () => void;
}

/** Client-local viewport over immutable canonical rows: no capture or IPC on wheel. */
export function createTerminalScrollback(
  adapter: ScrollbackSource,
  liveOrigin: (id: string) => TerminalViewportOrigin = () => ({ x: 0, y: 0 }),
  clampOrigin: (id: string, origin: TerminalViewportOrigin) => TerminalViewportOrigin = (
    _id,
    origin,
  ) => origin,
  retainView?: (id: string) => (() => void) | null,
) {
  const panes = new Map<
    string,
    {
      offset: () => number;
      origin: () => TerminalViewportOrigin | null;
      move: (delta: number, returnToLive?: boolean) => void;
      stop: () => void;
      seek: (origin: TerminalViewportOrigin) => void;
    }
  >();
  const pane = (id: string) => {
    const retained = panes.get(id);
    if (retained) return retained;
    // Anchor includes trimmed rows, so append/trim and cursor movement cannot
    // move the text under a reader. Horizontal panning is frozen as well.
    const [reading, setReading] = createSignal<{ anchor: number; x: number } | null>(null);
    let identity = adapter.renderSource.paneCanonicalIdentity?.(id);
    let previousDepth = adapter.renderSource.scrollbackDepth(id);
    let unsubscribe: (() => void) | null = null;
    let releaseReadView: (() => void) | null = null;
    let reflowPosition: (() => TerminalViewportOrigin | null) | null = null;
    const coordinates = () => {
      const depth = adapter.renderSource.scrollbackDepth(id);
      const trim = adapter.renderSource.paneCanonicalIdentity?.(id)?.historyTrim ?? 0;
      const live = liveOrigin(id);
      return { depth, trim, live, base: trim + depth + live.y };
    };
    const capturePosition = () => {
      const value = reading();
      const { depth, trim } = coordinates();
      reflowPosition = value
        ? (adapter.renderSource.captureReadPosition?.(id, {
            x: value.x,
            y: Math.max(trim, value.anchor) - trim - depth,
          }) ?? null)
        : null;
    };
    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
      reflowPosition = null;
      const release = releaseReadView;
      releaseReadView = null;
      release?.();
    };
    const synchronize = () => {
      const nextIdentity = adapter.renderSource.paneCanonicalIdentity?.(id);
      const replaced =
        identity?.sourceEpoch !== nextIdentity?.sourceEpoch ||
        identity?.generation !== nextIdentity?.generation ||
        identity?.incarnation !== nextIdentity?.incarnation;
      const { depth, trim, live } = coordinates();
      // Cursor movement is not history removal. A smaller client can be
      // reading the live grid even when tmux has no history at all.
      const resized =
        identity?.viewBackingRevision !== nextIdentity?.viewBackingRevision ||
        (identity?.viewCols ?? identity?.cols) !== (nextIdentity?.viewCols ?? nextIdentity?.cols) ||
        (identity?.viewRows ?? identity?.rows) !== (nextIdentity?.viewRows ?? nextIdentity?.rows);
      const historyCleared = !resized && previousDepth > 0 && depth === 0 && live.y === 0;
      const mapped = !replaced && resized ? reflowPosition?.() : undefined;
      setReading((value) => {
        if (replaced || !value || historyCleared) return null;
        if (resized && adapter.renderSource.captureReadPosition)
          return mapped ? { x: mapped.x, anchor: trim + depth + mapped.y } : null;
        return { ...value, anchor: Math.max(trim, value.anchor) };
      });
      identity = nextIdentity;
      previousDepth = depth;
      capturePosition();
    };
    const owner = {
      offset: () => {
        const value = reading();
        return value ? Math.max(1, coordinates().base - value.anchor) : 0;
      },
      origin: () => {
        const value = reading();
        const { depth, trim } = coordinates();
        return value
          ? clampOrigin(id, { x: value.x, y: Math.max(trim, value.anchor) - trim - depth })
          : null;
      },
      stop,
      seek: (origin: TerminalViewportOrigin) => {
        owner.move(0);
        if (!reading()) return;
        const clamped = clampOrigin(id, origin);
        const { trim, depth } = coordinates();
        setReading({ anchor: trim + depth + clamped.y, x: clamped.x });
        capturePosition();
      },
      move: (delta: number, returnToLive = false) => {
        synchronize();
        const { trim, live, base } = coordinates();
        if (!reading() && !returnToLive && delta > 0 && base > trim) {
          releaseReadView = retainView?.(id) ?? null;
          identity = adapter.renderSource.paneCanonicalIdentity?.(id);
        }
        // Wheel-entered copy mode exits at the bottom. Explicit selection
        // owns its retention separately and stays open at that edge.
        const frozen = identity?.viewCols !== undefined && !releaseReadView;
        setReading((value) => {
          const anchor = Math.max(trim, (value?.anchor ?? base) - delta);
          // A frozen buffer needs a resize anchor even at its live edge or
          // before it has any history. Only explicit return-to-live releases it.
          return returnToLive ||
            (!frozen && ((delta < 0 && anchor >= base) || (!value && base === trim)))
            ? null
            : { anchor: frozen ? Math.min(base, anchor) : anchor, x: value?.x ?? live.x };
        });
        capturePosition();
        if (reading() && !unsubscribe) {
          unsubscribe = adapter.subscribePaneVersion(id, () => {
            synchronize();
            if (!reading()) stop();
          });
        }
        // Subscription can synchronously publish a replacement or empty source.
        if (!reading()) stop();
      },
    };
    panes.set(id, owner);
    return owner;
  };
  return {
    offset: (id: string) => pane(id).offset(),
    origin: (id: string) => pane(id).origin(),
    move: (id: string, delta: number) => batch(() => pane(id).move(delta)),
    seek: (id: string, origin: TerminalViewportOrigin) => batch(() => pane(id).seek(origin)),
    live: (id: string) => batch(() => pane(id).move(-Infinity, true)),
    retain: (ids: ReadonlySet<string>) => {
      for (const [id, item] of panes)
        if (!ids.has(id)) {
          item.stop();
          panes.delete(id);
        }
    },
    dispose: () => {
      for (const item of panes.values()) item.stop();
      panes.clear();
    },
  };
}
