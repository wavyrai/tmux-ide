import type { Rect } from "../recipes.ts";

export interface AgentTerminalCanvasInput {
  /** Workbench `canvasBody` width, after the one-cell focus rail. */
  width: number;
  /** Workbench `canvasBody` height, after the native dock. */
  height: number;
  /** Session title + window strip rows owned by the native app shell. */
  chromeRows?: number;
  /** App-native rows overlaid on the framebuffer bottom (scrollback search). */
  footerRows?: number;
}

export interface AgentTerminalCanvasProjection {
  width: number;
  height: number;
  chrome: Rect;
  framebuffer: Rect;
  footer: Rect;
  /** Exact visible framebuffer size. Null while the native dock hides it. */
  tmuxSize: { cols: number; rows: number } | null;
}

export type AgentTerminalCanvasHit =
  | { kind: "chrome"; localX: number; localY: number }
  | { kind: "framebuffer"; localX: number; localY: number }
  | { kind: "footer"; localX: number; localY: number }
  | null;

export type AgentTerminalCanvasPointerPolicy =
  | "outside"
  | "route"
  | "focus-route"
  | "consume"
  | "settle-boundary";

/**
 * Pure adaptation between native Workbench geometry and tmux window truth.
 *
 * tmux only owns the framebuffer. The focus rail, bottom dock, terminal title /
 * window strip, and app-native search row never participate in `refresh-client
 * -C`, pane geometry, pointer cells, or size-mismatch calculations.
 */
export function projectAgentTerminalCanvas(
  input: AgentTerminalCanvasInput,
): AgentTerminalCanvasProjection {
  const width = cellCount(input.width);
  const height = cellCount(input.height);
  const requestedChromeRows = cellCount(input.chromeRows ?? 2);
  const requestedFooterRows = cellCount(input.footerRows ?? 0);
  const chromeHeight = Math.min(height, requestedChromeRows);
  const framebufferHeight = Math.max(0, height - chromeHeight);
  const footerHeight = Math.min(framebufferHeight, requestedFooterRows);
  const footerY = Math.max(chromeHeight, height - footerHeight);

  return {
    width,
    height,
    chrome: { x: 0, y: 0, width, height: chromeHeight },
    framebuffer: { x: 0, y: chromeHeight, width, height: framebufferHeight },
    footer: { x: 0, y: footerY, width, height: footerHeight },
    // Hiding the native canvas must not resize the real tmux window to 1 row.
    // The runtime preserves its last non-zero pin until this becomes non-null.
    tmuxSize: width > 0 && framebufferHeight > 0 ? { cols: width, rows: framebufferHeight } : null,
  };
}

export function agentTerminalCanvasHitTest(
  projection: AgentTerminalCanvasProjection,
  x: number,
  y: number,
): AgentTerminalCanvasHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (cellX < 0 || cellY < 0 || cellX >= projection.width || cellY >= projection.height)
    return null;
  if (contains(projection.chrome, cellX, cellY)) {
    return { kind: "chrome", localX: cellX, localY: cellY - projection.chrome.y };
  }
  // The app-native footer overlays the framebuffer's last row and therefore
  // wins input without changing the PTY size/SIGWINCH contract.
  if (contains(projection.footer, cellX, cellY)) {
    return { kind: "footer", localX: cellX, localY: cellY - projection.footer.y };
  }
  if (contains(projection.framebuffer, cellX, cellY)) {
    return {
      kind: "framebuffer",
      localX: cellX - projection.framebuffer.x,
      localY: cellY - projection.framebuffer.y,
    };
  }
  return null;
}

/**
 * Keeps the app-native footer out of the PTY gesture stream while still paying
 * any release debt when a drag or forwarded mouse press crosses into it.
 */
export function agentTerminalCanvasPointerPolicy(
  projection: AgentTerminalCanvasProjection,
  x: number,
  y: number,
  eventType: string,
): AgentTerminalCanvasPointerPolicy {
  const hit = agentTerminalCanvasHitTest(projection, x, y);
  if (!hit) return "outside";
  if (hit.kind === "footer") {
    return isPointerRelease(eventType) ? "settle-boundary" : "consume";
  }
  return eventType === "down" || eventType === "scroll" ? "focus-route" : "route";
}

/** Translate a physical screen x to the rail-free coordinate used by pane math. */
export function agentTerminalCanvasRouteX(screenX: number, canvasBodyX: number): number {
  return screenX - canvasBodyX;
}

function isPointerRelease(eventType: string): boolean {
  return (
    eventType === "up" || eventType === "drag-end" || eventType === "drop" || eventType === "out"
  );
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function cellCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
