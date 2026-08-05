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
    verbId: "pane.select" | "pane.resize",
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
  /** Pane chrome models by semantic pane id, for titles and status glyphs. */
  readonly paneFrames: readonly PaneFrameModel[];
  /**
   * The panes the daemon currently reports as attachable. A window with none of
   * them left has been closed — the pane-stream wire carries no "window closed"
   * frame, so this is what prunes a dead tab rather than a timeout.
   */
  readonly livePanes?: ReadonlySet<string>;
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
  const tabs = createMemo<readonly WindowTab[]>(() => windowTabs(frames()));
  const currentFrame = createMemo<LayoutFrame | null>(
    () => frames().find((frame) => frame.currentWindow) ?? frames()[0] ?? null,
  );
  const tiles = createMemo(() => {
    const frame = currentFrame();
    return frame ? layoutTiles(frame) : [];
  });
  const borders = createMemo(() => {
    const frame = currentFrame();
    return frame ? layoutBorders(frame) : [];
  });
  const paneCount = createMemo(() => currentFrame()?.panes.length ?? 0);

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
  const attachPane = createMemo<string | null>(() => {
    const frame = currentFrame();
    if (!frame) return null;
    const joined = frame.panes
      .map((pane) => pane.pane)
      .filter((pane): pane is string => pane !== null);
    return [...joined].sort()[0] ?? null;
  });

  const frameFor = (semanticPaneId: string): PaneFrameModel | undefined =>
    props.paneFrames.find((model) => model.pane.id === semanticPaneId);

  // ── Aligning the overlay to the grid the terminal actually rendered ────────
  //
  // A multi-pane window attaches size-passive: the surface renders the window's
  // own grid at its natural pixel size and CENTERS it, so the grid box is not
  // the pane area's box. Measuring `.xterm-screen` is how the overlay follows it
  // without the renderer having to expose a new geometry API — and it is the
  // same box the user is looking at, which no computed guess can promise.
  let areaElement: HTMLDivElement | undefined;
  let overlayElement: HTMLDivElement | undefined;
  let overlayStyle: RuntimeStyleBinding | null = null;
  const [gridBox, setGridBox] = createSignal<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const positionOverlay = (): void => {
    if (!overlayElement || !areaElement) return;
    const screen = areaElement.querySelector<HTMLElement>(".xterm-screen");
    const area = areaElement.getBoundingClientRect();
    const box = screen?.getBoundingClientRect();
    overlayStyle ??= createRuntimeStyleBinding(overlayElement);
    if (!box || box.width === 0 || box.height === 0) {
      // No grid to align to yet: the overlay fills the area so a single-pane
      // window is still hit-testable while its terminal is still measuring.
      overlayStyle.update({
        inset: "0",
        right: "auto",
        bottom: "auto",
        width: "100%",
        height: "100%",
      });
      setGridBox({ width: area.width, height: area.height });
      return;
    }
    overlayStyle.update({
      left: `${box.left - area.left}px`,
      top: `${box.top - area.top}px`,
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
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => positionOverlay());
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  };
  onCleanup(() => overlayStyle?.dispose());

  // ── Border drag ───────────────────────────────────────────────────────────
  //
  // Dispatched on RELEASE, never continuously. A drag that sent a resize per
  // pointermove would spend a serialized daemon round trip per frame of mouse
  // movement, and every one of them would be superseded before it landed. One
  // verb, at the end, is both the honest thing to report and the cheap one.
  const [dragging, setDragging] = createSignal<LayoutBorder | null>(null);

  const beginDrag = (border: LayoutBorder, event: PointerEvent): void => {
    if (!props.verbs.workspaceConnected) return;
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    handle.setPointerCapture(event.pointerId);
    setDragging(border);
    const finish = (release: PointerEvent): void => {
      handle.releasePointerCapture?.(release.pointerId);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      setDragging(null);
      const frame = currentFrame();
      if (!frame) return;
      const resolved = resolveBorderDrag({
        border,
        frame,
        gridBox: gridBox(),
        deltaX: release.clientX - startX,
        deltaY: release.clientY - startY,
      });
      if (resolved) props.verbs.invoke("pane.resize", border.pane, { resize: resolved });
    };
    const cancel = (): void => {
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", cancel);
      setDragging(null);
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", cancel);
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
              <span class="window-tabs__label">{tab().label}</span>
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
              title={frameFor(semanticPaneId())?.title ?? currentFrame()?.windowName ?? "Terminal"}
              transport={props.transport}
              focused
              // A multi-pane window is one size-passive card: the desktop never
              // drives the window's size, tmux does, and the grid is centered.
              sizePassive={paneCount() > 1}
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
                onPointerDown={(event) => {
                  // Left button only: a right-click opens the menu, and making
                  // it also move tmux's active pane would mean the menu acts on
                  // a pane the user has already been moved off.
                  if (event.button !== 0 || tile.active) return;
                  props.verbs.invoke("pane.select", tile.pane);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onOpenPaneMenu?.(tile.pane, { x: event.clientX, y: event.clientY });
                }}
              >
                <span class="pane-tile__chrome" aria-hidden="true">
                  <span class="pane-tile__title">{frameFor(tile.pane)?.title ?? "Terminal"}</span>
                  <Show when={frameFor(tile.pane)?.status}>
                    {(status) => (
                      <i
                        class="pane-tile__status"
                        data-tone={status().tone}
                        title={status().label}
                      />
                    )}
                  </Show>
                </span>
                <span class="sr-only">
                  {frameFor(tile.pane)?.title ?? "Terminal"}
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
