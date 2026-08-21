/* @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createRenderEffect, createSignal, type Accessor } from "solid-js";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import type { SemanticThemeSnapshot, TerminalPaletteProjection } from "../theme.ts";
import type { PaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { PaneScopedTerminalSurface } from "./pane-scoped-terminal-surface.tsx";
import { projectOpenTuiPaneFrames, type OpenTuiPaneFrame } from "./terminal-layout-projection.ts";
import { MIN_PANE, type ResizeGuideRect } from "../resize-model.ts";

type WorkspaceMouseEvent = {
  readonly type: string;
  readonly button?: number;
  readonly x: number;
  readonly y: number;
  stopPropagation?: () => void;
};

export interface ApplicationPaneResizePreview {
  readonly semanticPaneId: string;
  readonly axis: "cols" | "rows";
  readonly cells: number;
  readonly guide: ResizeGuideRect;
}

interface ApplicationPaneSeparator {
  readonly axis: "x" | "y";
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly paneId: string;
  readonly initialCells: number;
  readonly siblingCells: number;
}

export interface ApplicationTerminalWorkspaceProps {
  readonly layout: Accessor<OpenTuiWorkspaceLayoutSnapshot>;
  readonly adapter: PaneScopedTerminalAdapter;
  readonly rendererEpoch: number;
  readonly hostFocusTransitionOwner?: PaneSurfaceHostFocusTransitionOwner;
  readonly width: number;
  readonly height: number;
  /** Rows owned by parent chrome before the terminal canvas. Defaults to the
   * standalone app bar + window strip; nested shells use one window-strip row. */
  readonly topOffset?: number;
  /** Parent origin in renderer cells; OpenTUI mouse events are viewport-relative. */
  readonly originX?: number;
  readonly originY?: number;
  readonly focusedPane: string | null;
  /** Physical host focus is independent from which retained window is current. */
  readonly rendererFocused?: boolean;
  readonly theme: SemanticThemeSnapshot;
  readonly palette: TerminalPaletteProjection;
  readonly onSelectPane: (paneId: string) => void;
  readonly onResizePreview?: (preview: ApplicationPaneResizePreview) => void;
  readonly onResizePane?: (preview: ApplicationPaneResizePreview) => void;
  readonly onWindowPresented?: (
    semanticWindowId: string,
    paneId: string,
    windowName?: string,
  ) => void;
}

export function terminalPaneChromeLabel(paneId: string, focused: boolean, width: number): string {
  return `${focused ? "●" : "○"} ${paneId}`.slice(0, Math.max(0, width));
}

export function terminalWindowStripSlotWidth(width: number, windowCount: number): number {
  return Math.max(1, Math.min(32, Math.floor(width / Math.max(1, windowCount))));
}

function titleOf(layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number]): string {
  return layout.windowName ?? layout.semanticWindowId ?? "window";
}

function paneForWindow(layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number]): string | null {
  return (
    layout.panes.find((pane) => pane.active && pane.pane)?.pane ??
    layout.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

function retainedWindowKey(
  layout: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string | null {
  return layout.semanticWindowId ?? paneForWindow(layout);
}

function separatorAt(
  frames: ReturnType<typeof projectOpenTuiPaneFrames>,
  x: number,
  y: number,
): ApplicationPaneSeparator | null {
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        y >= Math.max(before.top, candidate.top) &&
        y < Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after && x === before.left + before.width) {
      return Object.freeze({
        axis: "x" as const,
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
    }
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        x >= Math.max(before.left, candidate.left) &&
        x < Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (after && y === before.top + before.height) {
      return Object.freeze({
        axis: "y" as const,
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells: before.height,
        siblingCells: after.height,
      });
    }
  }
  return null;
}

function separatorsFor(
  frames: ReturnType<typeof projectOpenTuiPaneFrames>,
): readonly ApplicationPaneSeparator[] {
  const separators: ApplicationPaneSeparator[] = [];
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        Math.max(before.top, candidate.top) <
          Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after)
      separators.push({
        axis: "x",
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        Math.max(before.left, candidate.left) <
          Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (after)
      separators.push({
        axis: "y",
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells: before.height,
        siblingCells: after.height,
      });
  }
  return Object.freeze(separators);
}

function previewFor(
  separator: ApplicationPaneSeparator,
  pointer: number,
  origin: number,
): ApplicationPaneResizePreview {
  const total = separator.initialCells + separator.siblingCells;
  const cells = Math.max(
    MIN_PANE,
    Math.min(total - MIN_PANE, separator.initialCells + pointer - origin),
  );
  const delta = cells - separator.initialCells;
  return Object.freeze({
    semanticPaneId: separator.paneId,
    axis: separator.axis === "x" ? "cols" : "rows",
    cells,
    guide:
      separator.axis === "x"
        ? Object.freeze({
            x: separator.position + delta,
            y: separator.start,
            width: 1,
            height: Math.max(1, separator.end - separator.start),
          })
        : Object.freeze({
            x: separator.start,
            y: separator.position + delta,
            width: Math.max(1, separator.end - separator.start),
            height: 1,
          }),
  });
}

/**
 * Renderer-only terminal composition. Canonical layout and terminal cells are
 * supplied by the generation host; this component owns no daemon lifecycle,
 * replica reduction, authority queue, or optional tool surface.
 */
export function ApplicationTerminalWorkspace(props: ApplicationTerminalWorkspaceProps) {
  const layout = props.layout;
  const topOffset = () => Math.max(1, Math.floor(props.topOffset ?? 2));
  // Immutable layout publications may be fresh objects with identical pane
  // geometry. Retain the frame items so Solid's keyed-by-reference <For>
  // preserves each PaneSurface owner and its canonical subscription.
  const projectedFrames = createMemo(
    () =>
      layout().windows.flatMap((window) =>
        projectOpenTuiPaneFrames(window, {
          width: props.width,
          height: props.height,
        }).map((frame) => Object.freeze({ ...frame, visible: window.currentWindow })),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((frame, index) => {
          const candidate = next[index]!;
          return (
            frame.paneId === candidate.paneId &&
            frame.left === candidate.left &&
            frame.top === candidate.top &&
            frame.width === candidate.width &&
            frame.height === candidate.height &&
            frame.contentHeight === candidate.contentHeight &&
            frame.active === candidate.active &&
            frame.visible === candidate.visible
          );
        }),
    },
  );
  const visibleFrames = createMemo(() => projectedFrames().filter((frame) => frame.visible));
  const retainedWindowIds = createMemo(
    () =>
      Object.freeze(
        layout()
          .windows.map(retainedWindowKey)
          .filter((id): id is string => id !== null),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length && previous.every((id, index) => id === next[index]),
    },
  );
  if (props.onWindowPresented)
    createRenderEffect(() => {
      const current = layout().current;
      const pane = current ? paneForWindow(current) : null;
      const semanticWindowId = current?.semanticWindowId ?? current?.windowName;
      const windowName = current?.windowName ?? undefined;
      if (!pane || !semanticWindowId) return;
      try {
        props.onWindowPresented?.(semanticWindowId, pane, windowName);
      } catch {
        // Optional switch diagnostics never own native presentation.
      }
    });
  const retainedPaneIds = createMemo(
    () =>
      Object.freeze(
        projectedFrames()
          .map(({ paneId }) => paneId)
          .sort((left, right) => left.localeCompare(right)),
      ),
    undefined,
    {
      equals: (previous, next) =>
        previous.length === next.length &&
        previous.every((paneId, index) => paneId === next[index]),
    },
  );
  const [hoveredSeparator, setHoveredSeparator] = createSignal<ApplicationPaneSeparator | null>(
    null,
  );
  const [resizePreview, setResizePreview] = createSignal<ApplicationPaneResizePreview | null>(null);
  let drag: {
    readonly separator: ApplicationPaneSeparator;
    readonly origin: number;
    preview: ApplicationPaneResizePreview;
  } | null = null;

  const terminalPoint = (event: WorkspaceMouseEvent): { x: number; y: number } => ({
    x: event.x - (props.originX ?? 0),
    y: event.y - (props.originY ?? 0) - topOffset(),
  });
  // tmux retains one active pane per window even while that window is hidden.
  // Keep those native terminal surfaces presentation-ready while the host has
  // focus; switching the visible window then changes only composition, not
  // terminal cursor/style state or grid dirtiness. The selected-pane marker
  // remains a separate workspace chrome overlay.
  const terminalSurfaceFocused = (frame: OpenTuiPaneFrame): boolean =>
    (props.rendererFocused ?? props.focusedPane !== null) && frame.active;
  const routePointer = (event: WorkspaceMouseEvent): void => {
    event.stopPropagation?.();
    const point = terminalPoint(event);
    const isRelease = event.type === "up" || event.type === "drag-end" || event.type === "drop";
    if (drag) {
      if (event.type === "drag" || isRelease) {
        const pointer = drag.separator.axis === "x" ? point.x : point.y;
        const next = previewFor(drag.separator, pointer, drag.origin);
        if (next.cells !== drag.preview.cells) {
          drag.preview = next;
          props.onResizePreview?.(next);
          setResizePreview(next);
        }
        if (isRelease) {
          const completed = drag.preview;
          const changed = completed.cells !== drag.separator.initialCells;
          drag = null;
          setResizePreview(null);
          setHoveredSeparator(null);
          if (changed) props.onResizePane?.(completed);
        }
      }
      return;
    }
    if (event.type === "move" || event.type === "over") {
      setHoveredSeparator(separatorAt(visibleFrames(), point.x, point.y));
      return;
    }
    if (event.type === "out") {
      setHoveredSeparator(null);
      return;
    }
    if (event.type !== "down" || event.button === 2) return;
    const separator = separatorAt(visibleFrames(), point.x, point.y);
    if (!separator) return;
    const origin = separator.axis === "x" ? point.x : point.y;
    const preview = previewFor(separator, origin, origin);
    drag = { separator, origin, preview };
    setHoveredSeparator(null);
    setResizePreview(preview);
  };
  const guide = createMemo(() => {
    const active = resizePreview();
    if (active) return { rect: active.guide, active: true };
    const hovered = hoveredSeparator();
    return hovered
      ? { rect: previewFor(hovered, hovered.position, hovered.position).guide, active: false }
      : null;
  });

  return (
    <>
      <box
        position="absolute"
        left={0}
        top={topOffset()}
        width={props.width}
        height={props.height}
        onMouse={routePointer}
        onMouseDown={routePointer}
        onMouseUp={routePointer}
      />
      <box
        position="absolute"
        left={0}
        top={topOffset() - 1}
        width={props.width}
        height={1}
        backgroundColor={props.theme.roles.surfaces.panel}
        flexDirection="row"
        onMouse={routePointer}
      >
        <Show
          when={layout().windows.length > 0}
          fallback={<text fg={props.theme.roles.text.muted}> no terminal windows </text>}
        >
          <For each={retainedWindowIds()}>
            {(windowId) => {
              const window = createMemo(
                () =>
                  layout().windows.find((candidate) => retainedWindowKey(candidate) === windowId)!,
              );
              return (
                <text
                  width={terminalWindowStripSlotWidth(props.width, retainedWindowIds().length)}
                  height={1}
                  content={` ${titleOf(window())} `}
                  fg={
                    window().currentWindow
                      ? props.theme.roles.text.link
                      : props.theme.roles.text.secondary
                  }
                  attributes={window().currentWindow ? 1 : 0}
                  onMouseDown={() => {
                    const pane = paneForWindow(window());
                    if (pane) props.onSelectPane(pane);
                  }}
                />
              );
            }}
          </For>
        </Show>
      </box>
      <For each={retainedPaneIds()}>
        {(paneId) => {
          const frame = createMemo(
            () => projectedFrames().find((candidate) => candidate.paneId === paneId)!,
          );
          return (
            <box
              position="absolute"
              left={frame().left}
              top={frame().top + topOffset()}
              width={frame().width}
              height={frame().height}
              visible={frame().visible}
              backgroundColor={props.theme.roles.surfaces.canvas}
              onMouseDown={() => props.onSelectPane(frame().paneId)}
              onMouse={routePointer}
            >
              <box
                position="absolute"
                left={0}
                top={0}
                width={frame().width}
                height={1}
                zIndex={2}
                backgroundColor={props.theme.roles.surfaces.command}
              >
                <text
                  fg={
                    props.focusedPane === frame().paneId
                      ? props.theme.roles.text.link
                      : props.theme.roles.text.secondary
                  }
                >
                  {` ${terminalPaneChromeLabel(
                    frame().paneId,
                    props.focusedPane === frame().paneId,
                    frame().width,
                  ).slice(1)}`}
                </text>
              </box>
              <box
                position="absolute"
                left={0}
                top={1}
                width={frame().width}
                height={frame().contentHeight}
              >
                <PaneScopedTerminalSurface
                  adapter={props.adapter}
                  paneId={frame().paneId}
                  width={frame().width}
                  height={frame().contentHeight}
                  defaultFg={props.palette.foreground}
                  defaultBg={props.palette.background}
                  terminalPalette={props.palette}
                  searchHl={props.palette.searchHighlight}
                  searchCur={props.palette.searchCurrent}
                  scrollOffset={0}
                  paneFocused={terminalSurfaceFocused(frame())}
                  active={() => frame().visible}
                  sourceEpoch={props.rendererEpoch}
                  hostFocusTransitionOwner={props.hostFocusTransitionOwner}
                  selRange={null}
                  search={null}
                />
              </box>
            </box>
          );
        }}
      </For>
      {/* PaneSurface is a native renderable. Keep the one-cell focus marker as
          a workspace-level overlay so its framebuffer cell cannot be cleared
          by native child composition at the frame origin. */}
      <For each={retainedPaneIds()}>
        {(paneId) => {
          const frame = createMemo(
            () => projectedFrames().find((candidate) => candidate.paneId === paneId)!,
          );
          return (
            <text
              position="absolute"
              left={frame().left}
              top={frame().top + topOffset()}
              visible={frame().visible}
              zIndex={3}
              selectable={false}
              onMouseDown={() => props.onSelectPane(frame().paneId)}
              fg={
                props.focusedPane === frame().paneId
                  ? props.theme.roles.text.link
                  : props.theme.roles.text.secondary
              }
            >
              {props.focusedPane === frame().paneId ? "●" : "○"}
            </text>
          );
        }}
      </For>
      <For each={separatorsFor(visibleFrames())}>
        {(separator) => (
          <box
            position="absolute"
            left={separator.axis === "x" ? separator.position : separator.start}
            top={(separator.axis === "x" ? separator.start : separator.position) + topOffset()}
            width={separator.axis === "x" ? 1 : Math.max(1, separator.end - separator.start)}
            height={separator.axis === "x" ? Math.max(1, separator.end - separator.start) : 1}
            backgroundColor={props.theme.colors.accentMuted}
            onMouse={routePointer}
            onMouseDown={routePointer}
            onMouseUp={routePointer}
          />
        )}
      </For>
      <box
        position="absolute"
        left={guide()?.rect.x ?? 0}
        top={(guide()?.rect.y ?? 0) + topOffset()}
        width={guide()?.rect.width ?? 0}
        height={guide()?.rect.height ?? 0}
        backgroundColor={
          guide()?.active ? props.theme.colors.accent : props.theme.colors.accentMuted
        }
        onMouse={routePointer}
      />
    </>
  );
}
