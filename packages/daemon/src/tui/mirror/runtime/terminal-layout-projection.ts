import type { PaneStreamServerFrame } from "@tmux-ide/contracts";

export type OpenTuiTerminalLayout = Extract<PaneStreamServerFrame, { type: "layout" }>;

export interface OpenTuiPaneFrame {
  readonly paneId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly contentHeight: number;
  readonly nativeHeight?: number;
  readonly nativeWidth?: number;
  readonly compactPosition?: string;
  readonly active: boolean;
}

function nativePaneHeight(
  layout: OpenTuiTerminalLayout,
  pane: OpenTuiTerminalLayout["panes"][number],
): number {
  const outerStatus =
    layout.paneBorderStatus === "top"
      ? pane.top === 0
      : layout.paneBorderStatus === "bottom" && pane.top + pane.height === layout.rows;
  return pane.height - (outerStatus ? 1 : 0);
}

/** Native geometry includes panes hidden by this client's compact presentation. */
export function nativePaneGeometries(layout: OpenTuiTerminalLayout) {
  return Object.freeze(
    layout.panes.flatMap((pane) =>
      pane.pane === null
        ? []
        : [
            Object.freeze({
              paneId: pane.pane,
              cols: pane.width,
              rows: nativePaneHeight(layout, pane),
            }),
          ],
    ),
  );
}

/** Compress shared layout edges, retaining one-cell vertical separators. */
function fitEdges(extent: number, available: number, edges: readonly number[], minimum: number) {
  if (available >= extent || edges.some((edge) => edge < 0 || edge > extent))
    return (value: number) => value;
  const sorted = [
    ...new Set([0, extent, ...edges.filter((edge) => edge > 0 && edge < extent)]),
  ].sort((a, b) => a - b);
  const lengths = sorted.slice(1).map((edge, index) => edge - sorted[index]!);
  const floors = lengths.map((length) => Math.min(length, minimum));
  const reserved = floors.reduce((sum, length) => sum + length, 0);
  if (reserved > available) return null;
  const weight = lengths.reduce((sum, length, index) => sum + length - floors[index]!, 0);
  let consumed = 0;
  let assigned = 0;
  const positions = new Map<number, number>([[0, 0]]);
  for (let index = 0; index < lengths.length; index++) {
    consumed += lengths[index]! - floors[index]!;
    const next = weight === 0 ? 0 : Math.round((consumed * (available - reserved)) / weight);
    const position = positions.get(sorted[index]!)! + floors[index]! + next - assigned;
    positions.set(sorted[index + 1]!, position);
    assigned = next;
  }
  return (value: number) => positions.get(Math.max(0, Math.min(extent, value))) ?? value;
}

/** Fit each client's pane frames while retaining the daemon's native cell sizes. */
export function projectOpenTuiPaneFrames(
  layout: OpenTuiTerminalLayout | null,
  canvas: { readonly width: number; readonly height: number },
  focusedPane?: string | null,
): readonly OpenTuiPaneFrame[] {
  if (!layout || canvas.width < 1 || canvas.height < 2) return [];
  const status = layout.paneBorderStatus;
  const frames = layout.panes.flatMap((pane) => {
    if (pane.pane === null) return [];
    const nativeHeight = nativePaneHeight(layout, pane);
    return [
      {
        paneId: pane.pane,
        left: pane.left,
        top: status === "top" ? Math.max(0, pane.top - 1) : pane.top,
        width: pane.width,
        height: nativeHeight + 1,
        nativeHeight,
        active: pane.active,
      },
    ];
  });
  const x = fitEdges(
    layout.cols,
    canvas.width,
    frames.flatMap((frame) => [frame.left, frame.left + frame.width]),
    1,
  );
  const y = fitEdges(
    layout.rows + (status === "off" ? 1 : 0),
    canvas.height,
    frames.flatMap((frame) => [frame.top, frame.top + frame.height]),
    2,
  );
  if (!x || !y) {
    const frame =
      frames.find((frame) => frame.paneId === focusedPane) ??
      frames.find((frame) => frame.active) ??
      frames[0];
    if (!frame) return [];
    return Object.freeze([
      Object.freeze({
        ...frame,
        left: 0,
        top: 0,
        width: canvas.width,
        height: canvas.height,
        contentHeight: canvas.height - 1,
        nativeWidth: frame.width,
        compactPosition: `${frames.indexOf(frame) + 1}/${frames.length}`,
      }),
    ]);
  }
  return Object.freeze(
    frames.flatMap((frame) => {
      const left = Math.max(0, x(frame.left));
      const top = Math.max(0, y(frame.top));
      if (left >= canvas.width || top >= canvas.height - 1) return [];
      const width = Math.max(1, Math.min(x(frame.left + frame.width), canvas.width) - left);
      const height = Math.max(2, Math.min(y(frame.top + frame.height), canvas.height) - top);
      return [
        Object.freeze({
          ...frame,
          left,
          top,
          width,
          height,
          contentHeight: height - 1,
          ...(width !== frame.width ? { nativeWidth: frame.width } : {}),
        }),
      ];
    }),
  );
}
