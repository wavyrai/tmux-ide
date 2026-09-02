import type { PaneStreamServerFrame } from "@tmux-ide/contracts";

export type OpenTuiTerminalLayout = Extract<PaneStreamServerFrame, { type: "layout" }>;

export interface OpenTuiPaneFrame {
  readonly paneId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly contentHeight: number;
  readonly active: boolean;
}

/**
 * Clamp daemon-owned tmux geometry into the renderer canvas. Pane chrome owns
 * exactly one row inside each frame; terminal content receives the remainder,
 * preventing the historical bottom-row clipping caused by overlay chrome.
 */
export function projectOpenTuiPaneFrames(
  layout: OpenTuiTerminalLayout | null,
  canvas: { readonly width: number; readonly height: number },
): readonly OpenTuiPaneFrame[] {
  if (!layout || canvas.width < 1 || canvas.height < 2) return [];
  return Object.freeze(
    layout.panes.flatMap((pane) => {
      if (pane.pane === null) return [];
      const left = Math.max(0, Math.min(canvas.width - 1, pane.left));
      const top = Math.max(0, Math.min(canvas.height - 2, pane.top));
      const width = Math.max(1, Math.min(pane.width, canvas.width - left));
      const height = Math.max(2, Math.min(pane.height, canvas.height - top));
      return [
        Object.freeze({
          paneId: pane.pane,
          left,
          top,
          width,
          height,
          contentHeight: height - 1,
          active: pane.active,
        }),
      ];
    }),
  );
}
