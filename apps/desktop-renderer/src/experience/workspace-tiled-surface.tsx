/**
 * The layout-faithful workspace view (m50): window tabs over tmux's own tiling.
 *
 * The shape of this surface is the whole scope call. There is ONE layout truth —
 * tmux's — and this renders it rather than keeping a second one beside it.
 *
 * How it is faithful by construction, which is the part worth understanding
 * before changing anything here:
 *
 *  - A desktop interactive attachment is a real `tmux attach-session` client
 *    pinned to ONE window, and tmux paints that whole window into it, pane
 *    borders and all. So the tiling on screen is not this view's arithmetic; it
 *    is tmux's, arriving as bytes. Nothing here can put a pane in the wrong
 *    place, because nothing here places a pane.
 *  - Interactive attachment ownership is WINDOW-keyed in the daemon's lease
 *    manager, so a second interactive attachment to another pane of the same
 *    window is refused. That is not a limitation this view works around — it is
 *    the reason the single-attachment shape is the right one.
 *  - What this view does own is the CHROME: which pane a click belongs to, where
 *    a context menu opens, where a border can be dragged. All of it is derived
 *    from the pane-stream layout frame by the pure functions in
 *    `workspace-layout-tiles.ts`, and all of it is positioned over the grid the
 *    terminal actually rendered — measured from the DOM, never assumed.
 *
 * The overlay covers no output. tmux spends exactly one cell on the border
 * between two panes, and the drag handles sit on those cells; a tile's own
 * region is transparent and only carries hit testing and a hover header.
 */
import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { TerminalSurface } from "../terminal/terminal-surface.tsx";
import type { NativeTerminalTransport } from "../terminal/native-terminal-transport.ts";
import type { PaneStreamLayoutEvent } from "../terminal/pane-stream-transport.ts";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import { Icon, type IconArtwork } from "../ui-system/icon.tsx";
import { DOM_ICON_METADATA } from "./dom-icons.ts";
import { gridOverlayBox } from "./grid-overlay.ts";
import { MirrorPaneNode } from "../terminal/mirror-pane-node.tsx";
import type { AppWindowCanvasMirrorProps } from "./app-window-canvas.tsx";
import {
  layoutBorders,
  layoutTiles,
  resolveBorderDrag,
  windowTabKey,
  windowTabs,
  type LayoutBorder,
  type LayoutFrame,
  type WindowTab,
} from "./workspace-layout-tiles.ts";

export interface TiledSurfaceVerbs {
  readonly workspaceConnected: boolean;
  readonly invoke: (
    verbId: "pane.select" | "pane.resize" | "pane.kill",
    semanticPaneId: string,
    args?: { readonly resize?: { readonly axis: "cols" | "rows"; readonly cells: number } },
  ) => void;
  /** The existing create flow, reused verbatim as the tab strip's "+". */
  readonly onCreateWindow?: () => void;
}

export interface WorkspaceTiledSurfaceProps {
  readonly layouts: readonly PaneStreamLayoutEvent[];
  readonly workspaceName: string;
  readonly transport?: NativeTerminalTransport | null;
  /** Pane chrome models by semantic pane id, for status glyphs. */
  readonly paneFrames: readonly PaneFrameModel[];
  /**
   * Titles by semantic pane id, from the daemon's terminal inventory.
   *
   * The inventory is where a pane's name lives for every pane; the chrome models
   * cover only the ones that are agents. Reading the title from the inventory
   * first is what stops a plain shell from being labelled "Terminal" while the
   * daemon knows perfectly well what it is called.
   */
  readonly paneTitles?: ReadonlyMap<string, string>;
  /**
   * The panes the daemon currently reports as attachable. A window with none of
   * them left has been closed — the pane-stream wire carries no "window closed"
   * frame, so this is what prunes a dead tab rather than a timeout.
   */
  readonly livePanes?: ReadonlySet<string>;
  /**
   * The pane to show before any layout frame has arrived — the inventory's own
   * active pane.
   *
   * Geometry can be late (the lease is still connecting) or absent (a daemon
   * whose control channel cannot report layouts). Waiting for it would leave a
   * user staring at a placeholder while a perfectly attachable terminal exists,
   * so the view degrades to the one thing it can be sure of: a single pane,
   * full bleed, no borders. It is the same view a single-pane window gets.
   */
  readonly fallbackPane?: string | null;
  /**
   * The session's windows as the daemon's inventory groups them, used until
   * layout frames arrive.
   *
   * The inventory already knows which panes share a tmux window, so the tab
   * strip can exist before any geometry does — which matters because creating a
   * window is one of the first things a user does, and a strip that appears
   * only once a layout frame happens to arrive would leave the new window with
   * nowhere to show up.
   */
  readonly fallbackWindows?: readonly {
    readonly key: string;
    readonly label: string;
    readonly panes: readonly string[];
    readonly active: boolean;
  }[];
  readonly reducedMotion?: boolean;
  readonly terminalThemeKey?: string;
  readonly verbs: TiledSurfaceVerbs;
  readonly onOpenPaneMenu?: (
    semanticPaneId: string,
    pointer: { readonly x: number; readonly y: number },
  ) => void;
  readonly onOpenWindowMenu?: (
    semanticPaneId: string,
    pointer: { readonly x: number; readonly y: number },
  ) => void;
  readonly onFocusPane?: (semanticPaneId: string, source: "keyboard" | "mouse") => void;
  /**
   * The window whose tab is being renamed, named by a pane inside it. The tab
   * is where a rename belongs: it is where the name is READ, so it is where a
   * user looks to change it, and editing in place means the old name is visible
   * until the moment the new one is committed.
   */
  readonly renamingPane?: string | null;
  readonly onRenameCommit?: (semanticPaneId: string, name: string) => void;
  readonly onRenameCancel?: () => void;
  /** Reports whether a terminal attachment is currently open (see the status strip). */
  readonly onAttachmentChanged?: (attached: boolean) => void;
  /**
   * The pane-mirror affordance, carried over from the canvas unchanged in
   * meaning: a read-only peek at every attachable pane of the workspace, on a
   * deck below the tiled area. It answers the question the tiled view cannot —
   * what the panes you are NOT looking at are doing — so it stays a toggle
   * rather than becoming part of the default picture.
   */
  readonly mirror?: AppWindowCanvasMirrorProps;
}

function toFrame(layout: PaneStreamLayoutEvent): LayoutFrame {
  return layout;
}

/*
 * The header's own two glyphs, named from the semantic vocabulary rather than
 * drawn here, so a header control and a titlebar control are the same mark.
 */
const MENU_ICON = DOM_ICON_METADATA.more.artwork;
const CLOSE_ICON = DOM_ICON_METADATA.close.artwork;

/**
 * A pane's type glyph, from the semantic vocabulary.
 *
 * The role a pane frame reports IS the product's word for what the pane is, so
 * the mapping is role to icon and nothing is inferred from a title or a command
 * line. A pane with no frame model is a plain terminal — the common case, since
 * frames are built for agent panes — and terminal is what it gets.
 */
const ROLE_ICON: Readonly<Record<PaneFrameModel["pane"]["kind"], IconArtwork>> = {
  home: DOM_ICON_METADATA.home.artwork,
  terminal: DOM_ICON_METADATA.terminals.artwork,
  files: DOM_ICON_METADATA.files.artwork,
  changes: DOM_ICON_METADATA.changes.artwork,
  missions: DOM_ICON_METADATA.missions.artwork,
  activity: DOM_ICON_METADATA.activity.artwork,
  preview: DOM_ICON_METADATA.preview.artwork,
  native: DOM_ICON_METADATA.native.artwork,
};

/** Percentages, rounded to a precision the DOM will not thrash over. */
function percent(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

export function WorkspaceTiledSurface(props: WorkspaceTiledSurfaceProps) {
  /**
   * The windows tmux still has.
   *
   * A layout frame is never retracted, so a killed window's last frame would sit
   * in the tab strip forever. A window survives here while any of its panes is
   * still attachable — the daemon's own inventory, which is pruned on kill.
   */
  const frames = createMemo<readonly LayoutFrame[]>(() => {
    const live = props.livePanes;
    return props.layouts.map(toFrame).filter((frame) => {
      if (!live) return true;
      const joined = frame.panes.filter((pane) => pane.pane !== null);
      return joined.length === 0 || joined.some((pane) => live.has(pane.pane!));
    });
  });
  const tabs = createMemo<readonly WindowTab[]>(() => {
    const fromFrames = windowTabs(frames());
    if (fromFrames.length > 0) return fromFrames;
    return (props.fallbackWindows ?? []).map((window) => ({
      semanticWindowId: null,
      label: window.label,
      active: window.active,
      paneCount: window.panes.length,
      zoomed: false,
      addressPane: window.panes[0] ?? null,
    }));
  });
  const currentFrame = createMemo<LayoutFrame | null>(
    () => frames().find((frame) => frame.currentWindow) ?? frames()[0] ?? null,
  );
  const tiles = createMemo(() => {
    const frame = currentFrame();
    if (frame) return layoutTiles(frame);
    const fallback = props.fallbackPane;
    return fallback
      ? [
          {
            pane: fallback,
            active: true,
            // No layout frame has arrived, so there is no separator row this
            // header could be hoisted into — it reveals on hover, like a pane
            // flush with the top of a window.
            headerRows: 0 as const,
            cells: { cols: 0, rows: 0 },
            rect: { left: 0, top: 0, width: 1, height: 1 },
          },
        ]
      : [];
  });
  const borders = createMemo(() => {
    const frame = currentFrame();
    return frame ? layoutBorders(frame) : [];
  });
  const paneCount = createMemo(() => currentFrame()?.panes.length ?? (props.fallbackPane ? 1 : 0));

  /**
   * The pane the attachment is addressed by, chosen for STABILITY rather than
   * for activity.
   *
   * One attach renders the whole window whichever of its panes names it, and
   * re-targeting tears the attachment down — into a window-keyed lease whose
   * grace period has not expired, which is exactly the "previous session is
   * still releasing" conflict. So clicking a tile moves tmux's active pane and
   * this does not move at all; the cursor follows because tmux drew it there.
   */
  let chosenAttachPane: string | null = null;
  const attachPane = createMemo<string | null>(() => {
    const frame = currentFrame();
    const joined = (frame?.panes ?? [])
      .map((pane) => pane.pane)
      .filter((pane): pane is string => pane !== null);
    if (joined.length === 0) {
      chosenAttachPane = props.fallbackPane ?? null;
      return chosenAttachPane;
    }
    // STICKY: keep the pane already attached while it is still in this window.
    // Every change here is a teardown and a re-attach into a window-keyed lease
    // whose grace period has not expired, so churn costs the user their
    // terminal — and geometry arriving a moment after the fallback was chosen
    // must not count as a reason to move.
    if (chosenAttachPane && joined.includes(chosenAttachPane)) return chosenAttachPane;
    const fallback = props.fallbackPane;
    chosenAttachPane =
      fallback && joined.includes(fallback) ? fallback : ([...joined].sort()[0] ?? null);
    return chosenAttachPane;
  });

  const frameFor = (semanticPaneId: string): PaneFrameModel | undefined =>
    props.paneFrames.find((model) => model.pane.id === semanticPaneId);
  const titleFor = (semanticPaneId: string): string =>
    props.paneTitles?.get(semanticPaneId) ?? frameFor(semanticPaneId)?.title ?? "Terminal";
  const iconFor = (semanticPaneId: string): IconArtwork => {
    const kind = frameFor(semanticPaneId)?.pane.kind;
    return kind ? ROLE_ICON[kind] : ROLE_ICON.terminal;
  };

  // ── Aligning the overlay to the grid the terminal actually rendered ────────
  //
  // A multi-pane window attaches size-passive: the surface renders the window's
  // own grid at its natural pixel size and CENTERS it, so the grid box is not
  // the pane area's box. The overlay follows the measured grid through the
  // rule-10 helper in `grid-overlay.ts`, which is where that invariant lives.
  let areaElement: HTMLDivElement | undefined;
  let overlayElement: HTMLDivElement | undefined;
  let overlayStyle: RuntimeStyleBinding | null = null;
  const [gridBox, setGridBox] = createSignal<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const positionOverlay = (): void => {
    if (!overlayElement || !areaElement) return;
    /*
     * Align to the terminal's VIEWPORT element, never to `.xterm-screen`.
     *
     * The screen element lives inside xterm's scroll area, so its rect moves
     * with the scrollback — measured against it the overlay drifted hundreds of
     * pixels below the terminal, which is how a right-click in the pane area
     * hit no pane at all. The viewport element is the grid's own box in both
     * modes: it fills the card when the surface drives tmux, and it shrinks to
     * the window's natural grid and centres when the card is size-passive.
     */
    const viewport = areaElement.querySelector<HTMLElement>(".terminal-surface__viewport");
    const area = areaElement.getBoundingClientRect();
    const natural = viewport?.getBoundingClientRect();
    overlayStyle ??= createRuntimeStyleBinding(overlayElement);
    // Scale 1 on purpose: the interactive surface letterboxes by CENTRING, with
    // no CSS transform (a transform would desync xterm's pointer-to-cell map),
    // so the rule-10 box collapses to the centred rectangle. Degenerate input
    // falls back to the whole area, which is what the helper already promises.
    const box = gridOverlayBox(
      { width: natural?.width ?? 0, height: natural?.height ?? 0 },
      { width: area.width, height: area.height },
      1,
    );
    overlayStyle.update({
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      right: "auto",
      bottom: "auto",
    });
    setGridBox({ width: box.width, height: box.height });
  };

  createEffect(() => {
    // Re-measure whenever the layout the overlay describes changes.
    void tiles();
    queueMicrotask(positionOverlay);
  });

  const observeArea = (element: HTMLDivElement): void => {
    areaElement = element;
    /*
     * The context menu listens in the CAPTURE phase.
     *
     * The terminal underneath is xterm, which handles `contextmenu` itself; a
     * bubbling listener would run after it and, where it stops propagation,
     * never at all. Capturing means the pane menu opens wherever the user
     * right-clicks in the pane area, which is the only rule worth having.
     */
    const onContextMenu = (event: MouseEvent): void => {
      const pane = tileAtPointer(event);
      if (!pane) return;
      event.preventDefault();
      props.onOpenPaneMenu?.(pane, { x: event.clientX, y: event.clientY });
    };
    element.addEventListener("contextmenu", onContextMenu, true);
    onCleanup(() => element.removeEventListener("contextmenu", onContextMenu, true));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionOverlay());
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };
  onCleanup(() => overlayStyle?.dispose());

  /**
   * Which tile a pointer is over, from the overlay's own box and the tile
   * fractions. It is the same arithmetic the tiles are drawn with, so a hit can
   * never disagree with what the user sees.
   */
  const tileAtPointer = (event: PointerEvent | MouseEvent): string | null => {
    if (!overlayElement) return null;
    const box = overlayElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const hit = tiles().find(
      (tile) =>
        x >= tile.rect.left &&
        x < tile.rect.left + tile.rect.width &&
        y >= tile.rect.top &&
        y < tile.rect.top + tile.rect.height,
    );
    return hit?.pane ?? null;
  };

  // ── Border drag ───────────────────────────────────────────────────────────
  //
  // The border follows the pointer WHILE dragging, throttled, and flushes on
  // release. A resize per pointermove would spend a serialized daemon round
  // trip per frame of mouse movement; sending nothing until release leaves the
  // user dragging a handle over panes that do not move. The throttle is the
  // honest middle, and the flush is what guarantees the last position is the
  // one tmux ends on rather than whichever tick happened to land last.
  //
  // Every dispatch states an ABSOLUTE size rather than a delta. Under a
  // throttle the two are not equivalent: a superseded or dropped delta silently
  // loses its movement and the border drifts away from the pointer, while an
  // absolute size is self-correcting — the next tick states the target again
  // and any missed one costs nothing. The baseline is the size captured at the
  // GRAB, so the target tracks the pointer even as re-tiling changes the frame
  // underneath.
  const BORDER_DRAG_THROTTLE_MS = 80;
  const [dragging, setDragging] = createSignal<LayoutBorder | null>(null);

  const beginDrag = (border: LayoutBorder, event: PointerEvent): void => {
    if (!props.verbs.workspaceConnected) return;
    const frame = currentFrame();
    if (!frame) return;
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    // Captured at the grab: the frame re-tiles under the drag, and a baseline
    // that moved with it would make the border chase its own last position.
    const grabbedFrame = frame;
    const grabbedBox = gridBox();
    handle.setPointerCapture(event.pointerId);
    setDragging(border);

    let lastSentAt = 0;
    let lastSentCells: number | null = null;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;

    const dispatch = (clientX: number, clientY: number): void => {
      const resolved = resolveBorderDrag({
        border,
        frame: grabbedFrame,
        gridBox: grabbedBox,
        deltaX: clientX - startX,
        deltaY: clientY - startY,
      });
      // Null means the pointer has come back to where it started, so the size
      // to ask for is the one the pane already had.
      const cells = resolved?.cells ?? border.cells;
      if (cells === lastSentCells) return;
      lastSentCells = cells;
      lastSentAt = Date.now();
      props.verbs.invoke("pane.resize", border.pane, {
        resize: { axis: border.orientation === "vertical" ? "cols" : "rows", cells },
      });
    };

    const clearPending = (): void => {
      if (pendingTimer !== null) clearTimeout(pendingTimer);
      pendingTimer = null;
    };

    const move = (moved: PointerEvent): void => {
      const wait = BORDER_DRAG_THROTTLE_MS - (Date.now() - lastSentAt);
      if (wait <= 0) {
        clearPending();
        dispatch(moved.clientX, moved.clientY);
        return;
      }
      // Trailing edge: the last position inside the window still lands, so a
      // drag that stops mid-throttle does not leave the border behind.
      clearPending();
      const x = moved.clientX;
      const y = moved.clientY;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        dispatch(x, y);
      }, wait);
    };

    const detach = (): void => {
      clearPending();
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      setDragging(null);
    };
    const finish = (release: PointerEvent): void => {
      handle.releasePointerCapture?.(release.pointerId);
      detach();
      // Flush: whatever the throttle was holding, the release position wins.
      dispatch(release.clientX, release.clientY);
    };
    const cancel = (): void => detach();

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
    onCleanup(clearPending);
  };

  return (
    <div class="tiled-workspace" data-window-count={tabs().length}>
      <nav
        class="window-tabs"
        aria-label="tmux windows"
        role="tablist"
        data-focus-zone="window-tabs"
      >
        <Index each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              class="window-tabs__tab"
              data-window-tab={tab().semanticWindowId ?? ""}
              data-active={tab().active}
              aria-selected={tab().active}
              // A window whose panes carry no verified identity cannot be
              // addressed, so its tab refuses rather than dispatching into
              // nothing and reading as a broken control.
              disabled={tab().addressPane === null}
              title={
                tab().addressPane === null
                  ? "This window is not addressable yet"
                  : `${tab().label} — ${tab().paneCount} pane${tab().paneCount === 1 ? "" : "s"}`
              }
              onClick={() => {
                const pane = tab().addressPane;
                if (pane && !tab().active) props.verbs.invoke("pane.select", pane);
              }}
              onContextMenu={(event) => {
                const pane = tab().addressPane;
                if (!pane) return;
                event.preventDefault();
                props.onOpenWindowMenu?.(pane, { x: event.clientX, y: event.clientY });
              }}
            >
              <Show
                when={props.renamingPane !== null && props.renamingPane === tab().addressPane}
                fallback={<span class="window-tabs__label">{tab().label}</span>}
              >
                <input
                  class="window-tabs__rename-field"
                  aria-label="Window name"
                  value={tab().label}
                  ref={(element) => queueMicrotask(() => element.select())}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      props.onRenameCancel?.();
                      return;
                    }
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    const pane = tab().addressPane;
                    const typed = event.currentTarget.value.trim();
                    if (pane && typed) props.onRenameCommit?.(pane, typed);
                    else props.onRenameCancel?.();
                  }}
                  onBlur={() => props.onRenameCancel?.()}
                />
              </Show>
              <Show when={tab().paneCount > 1}>
                <span class="window-tabs__count" aria-hidden="true">
                  {tab().paneCount}
                </span>
              </Show>
              <Show when={tab().zoomed}>
                <span class="window-tabs__zoom" title="This window is zoomed">
                  ⛶
                </span>
              </Show>
            </button>
          )}
        </Index>
        <Show when={props.verbs.onCreateWindow}>
          {(create) => (
            <button
              type="button"
              class="window-tabs__create"
              aria-label="New terminal or agent"
              title="New terminal or agent"
              onClick={() => create()()}
            >
              +
            </button>
          )}
        </Show>
      </nav>

      <div
        class="tiled-pane-area"
        ref={observeArea}
        data-pane-count={paneCount()}
        data-zoomed={currentFrame()?.zoomed ?? false}
        data-focus-zone="canvas"
        /*
         * Pane hit testing lives on the AREA, not on the tiles.
         *
         * The tiles are `pointer-events: none` so a left click reaches the
         * terminal underneath — which is a real tmux client, so tmux selects the
         * pane itself, exactly as it would for an ssh client. Listening here
         * lets the view follow along (and cover a tmux with mouse mode off)
         * without ever swallowing the click that types.
         */
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const pane = tileAtPointer(event);
          const active = tiles().find((tile) => tile.active)?.pane;
          if (pane && pane !== active) props.verbs.invoke("pane.select", pane);
        }}
      >
        <Show
          when={attachPane()}
          fallback={
            <div class="tiled-pane-area__empty" role="status">
              <strong>No addressable window</strong>
              <span>
                {tabs().length === 0
                  ? "Waiting for tmux to report this session's windows."
                  : "This window's panes have no verified identity yet."}
              </span>
            </div>
          }
        >
          {(semanticPaneId) => (
            <TerminalSurface
              target={{ workspaceName: props.workspaceName, semanticPaneId: semanticPaneId() }}
              title={titleFor(semanticPaneId())}
              transport={props.transport}
              focused
              /*
               * THE GEOMETRY OWNER (m50.2, gap 1).
               *
               * The visible window's interactive attachment is the one client
               * whose size tmux should follow, so it asks for ownership and the
               * daemon attaches it without `-f ignore-size`. The surface then
               * measures this card, floors it into whole cells, and drives tmux
               * to match; tmux re-tiles, the layout frame comes back, and the
               * view re-renders from it. tmux is still the only layout truth —
               * this closes a loop through it rather than computing beside it.
               *
               * What this replaces: a size-passive card rendered the window's
               * own grid centred, so a window sized for someone else's terminal
               * sat in the middle of the app under a sea of letterbox. The
               * faithfulness argument for that was real but backwards — the
               * proportions were tmux's because nothing had told tmux the size
               * of the surface it was being shown in.
               *
               * Ownership is exclusive per window because the interactive lease
               * already is, and it is released when this attachment is. Every
               * mirror on the deck below stays passive.
               */
              geometryOwnership="owner"
              reducedMotion={props.reducedMotion}
              themeKey={props.terminalThemeKey}
              onFocus={(source) => {
                const active = tiles().find((tile) => tile.active);
                if (active) props.onFocusPane?.(active.pane, source);
              }}
            />
          )}
        </Show>

        <div class="tiled-pane-area__overlay" ref={(element) => (overlayElement = element)}>
          <For each={tiles()}>
            {(tile) => (
              <div
                class="pane-tile"
                data-pane={tile.pane}
                data-active={tile.active}
                style={{
                  left: percent(tile.rect.left),
                  top: percent(tile.rect.top),
                  width: percent(tile.rect.width),
                  height: percent(tile.rect.height),
                }}
              >
                <PaneHeader
                  pane={tile.pane}
                  title={titleFor(tile.pane)}
                  icon={iconFor(tile.pane)}
                  status={frameFor(tile.pane)?.status ?? null}
                  active={tile.active}
                  /*
                   * The header's share of its own tile.
                   *
                   * The tile is `pane.height + headerRows` cells tall and the
                   * header is the one separator row of it, so the header is that
                   * fraction of the box — which keeps it exactly one terminal row
                   * tall at every window size without the component ever knowing
                   * a pixel. A tile with no separator row above it reports 0 and
                   * the header falls back to a hover overlay on the pane's own
                   * first row (styles.css), because there is no free row to take.
                   */
                  heightFraction={tile.headerRows / (tile.cells.rows + tile.headerRows)}
                  hoisted={tile.headerRows === 1}
                  onOpenMenu={(pointer) => props.onOpenPaneMenu?.(tile.pane, pointer)}
                  onClose={() => props.verbs.invoke("pane.kill", tile.pane)}
                />
                <span class="sr-only">
                  {titleFor(tile.pane)}
                  {tile.active ? ", active pane" : ""}
                </span>
              </div>
            )}
          </For>
          <For each={borders()}>
            {(border) => (
              <div
                class="pane-border"
                data-pane-border={border.id}
                data-orientation={border.orientation}
                data-dragging={dragging()?.id === border.id}
                role="separator"
                aria-orientation={border.orientation}
                aria-label={`Resize pane ${border.orientation === "vertical" ? "width" : "height"}`}
                style={{
                  left: percent(border.rect.left),
                  top: percent(border.rect.top),
                  width: percent(border.rect.width),
                  height: percent(border.rect.height),
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  beginDrag(border, event);
                }}
              />
            )}
          </For>
        </div>
      </div>
      <Show when={props.mirror}>
        {(mirror) => (
          <div class="mirror-deck" data-enabled={mirror().enabled}>
            <div class="mirror-deck__controls">
              <button
                type="button"
                class="mirror-deck__toggle"
                aria-pressed={mirror().enabled}
                data-mirror-toggle="true"
                onClick={() => mirror().onToggle(!mirror().enabled)}
              >
                Mirror
              </button>
            </div>
            <Show when={mirror().enabled}>
              {/*
               * `Index`, never `For`.
               *
               * The node list is rebuilt on every stream tick, so `For` — which
               * keys by reference — would throw away each node's DOM and
               * re-initialize its xterm several times a second. That is the
               * re-mount defect the mirror was fixed for once already; the
               * element identity is what the suite asserts across ticks.
               */}
              <div class="mirror-deck__nodes">
                <Index each={mirror().nodes}>
                  {(node) => (
                    <div
                      class="mirror-deck__node"
                      data-mirror-node-id={`mirror:${node().pane}`}
                      data-pane={node().pane}
                      data-state={node().state.kind}
                    >
                      <span class="mirror-deck__title">{node().title}</span>
                      <MirrorPaneNode
                        pane={node().pane}
                        title={node().title}
                        state={node().state}
                        connection={mirror().connection}
                        faultLabel={mirror().faultLabel}
                        registerSink={node().registerSink}
                        onRetry={mirror().onRetry}
                        reducedMotion={props.reducedMotion}
                        themeKey={props.terminalThemeKey}
                      />
                    </div>
                  )}
                </Index>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <AttachmentReporter area={() => areaElement} onChange={props.onAttachmentChanged} />
    </div>
  );
}

/**
 * How long an armed close stays armed.
 *
 * The confirm exists so a stray click cannot kill a pane; an arm that never
 * expires turns the NEXT visit to the same button — minutes later, in a
 * different task — into the confirming click. Disarming on a timer, on pointer
 * exit and on blur means the second click has to be a deliberate follow-up to
 * the first.
 */
const CLOSE_CONFIRM_MS = 4_000;

/**
 * One pane's header (m50.2, gap 3).
 *
 * It occupies the separator row tmux already draws above the pane, so it costs
 * no output — see the mosaic invariant in `workspace-layout-tiles.ts`. The
 * header carries the pane's type, its live title, its status glyph, and the two
 * verbs a header is the natural home for: the full menu, and close.
 *
 * Close ARMS rather than firing, matching the destructive discipline the verb
 * menu already holds itself to. A close button beside a menu button, both one
 * row tall, is exactly the geometry in which a mis-aimed click happens; making
 * the first click reversible is what keeps the affordance worth having.
 */
function PaneHeader(props: {
  readonly pane: string;
  readonly title: string;
  readonly icon: IconArtwork;
  readonly status: PaneFrameModel["status"] | null;
  readonly active: boolean;
  readonly heightFraction: number;
  readonly hoisted: boolean;
  readonly onOpenMenu: (pointer: { readonly x: number; readonly y: number }) => void;
  readonly onClose: () => void;
}) {
  const [armed, setArmed] = createSignal(false);
  let disarmTimer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
    disarmTimer = null;
    setArmed(false);
  };
  const arm = (): void => {
    if (disarmTimer !== null) clearTimeout(disarmTimer);
    setArmed(true);
    disarmTimer = setTimeout(disarm, CLOSE_CONFIRM_MS);
  };
  onCleanup(disarm);

  return (
    <div
      class="pane-tile__header"
      data-hoisted={props.hoisted}
      data-active={props.active}
      style={props.hoisted ? { height: percent(props.heightFraction) } : undefined}
      onPointerLeave={disarm}
    >
      <Icon class="pane-tile__icon" icon={props.icon} size="control" />
      <span class="pane-tile__title">{props.title}</span>
      <Show when={props.status}>
        {(status) => (
          <i class="pane-tile__status" data-tone={status().tone} title={status().label} />
        )}
      </Show>
      <button
        type="button"
        class="pane-tile__action"
        data-pane-menu={props.pane}
        aria-label={`Actions for ${props.title}`}
        title={`Actions for ${props.title}`}
        onClick={(event) => {
          event.stopPropagation();
          disarm();
          // Opened at the button's own bottom-left, not at the pointer: a menu
          // summoned from a control belongs under that control, wherever the
          // click happened to land inside it.
          const box = event.currentTarget.getBoundingClientRect();
          props.onOpenMenu({ x: box.left, y: box.bottom });
        }}
      >
        <Icon icon={MENU_ICON} size="control" />
      </button>
      <button
        type="button"
        class="pane-tile__action"
        data-pane-close={props.pane}
        data-confirm-pending={armed()}
        aria-label={
          armed() ? `Close ${props.title} — this cannot be undone` : `Close ${props.title}`
        }
        title={armed() ? "Click again to close — this cannot be undone" : `Close ${props.title}`}
        onBlur={disarm}
        onKeyDown={(event) => {
          if (event.key === "Escape") disarm();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (!armed()) {
            arm();
            return;
          }
          disarm();
          props.onClose();
        }}
      >
        <Icon icon={CLOSE_ICON} size="control" />
      </button>
    </div>
  );
}

/**
 * Watches whether a terminal attachment is actually open.
 *
 * It exists for one honesty bug: the status strip printed "No desktop terminal
 * attachment is open" over a connected terminal, because that line comes from a
 * daemon projection which cannot know what the renderer attached. The DOM does
 * know — `data-phase` on the surface is the attachment's own report — so the
 * fact travels from where it is true to where it is printed.
 */
function AttachmentReporter(props: {
  readonly area: () => HTMLElement | undefined;
  readonly onChange?: (attached: boolean) => void;
}) {
  createEffect(() => {
    const element = props.area();
    if (!element || !props.onChange || typeof MutationObserver === "undefined") return;
    const report = (): void =>
      props.onChange!(element.querySelector('.terminal-surface[data-phase="connected"]') !== null);
    report();
    const observer = new MutationObserver(report);
    observer.observe(element, { subtree: true, attributes: true, attributeFilter: ["data-phase"] });
    onCleanup(() => {
      observer.disconnect();
      props.onChange?.(false);
    });
  });
  return null;
}

export { windowTabKey };
