import type { CanvasRect } from "./canvas-interaction-geometry.ts";

export type AppWindowInteractionCommand =
  | { readonly type: "window.focus"; readonly windowId: string | null }
  | {
      readonly type: "window.move";
      readonly windowId: string;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "window.resize";
      readonly windowId: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly type: "window.float"; readonly windowId: string; readonly rect?: CanvasRect }
  | {
      readonly type: "window.dock";
      readonly windowId: string;
      readonly stackId?: string;
      readonly index?: number;
    };

export type AppWindowInteractionCommandSource = "keyboard" | "mouse" | "programmatic";

export interface AppWindowInteractionCommandIntent {
  readonly command: AppWindowInteractionCommand;
  readonly source: AppWindowInteractionCommandSource;
}

export function focusAppWindowIntent(
  windowId: string | null,
  source: AppWindowInteractionCommandSource,
): AppWindowInteractionCommandIntent {
  return { command: { type: "window.focus", windowId }, source };
}

export function moveAppWindowIntent(
  windowId: string,
  point: { readonly x: number; readonly y: number },
  source: AppWindowInteractionCommandSource,
): AppWindowInteractionCommandIntent {
  return { command: { type: "window.move", windowId, x: point.x, y: point.y }, source };
}

export function resizeAppWindowIntent(
  windowId: string,
  size: { readonly width: number; readonly height: number },
  source: AppWindowInteractionCommandSource,
): AppWindowInteractionCommandIntent {
  return {
    command: { type: "window.resize", windowId, width: size.width, height: size.height },
    source,
  };
}

export function floatAppWindowIntent(
  windowId: string,
  source: AppWindowInteractionCommandSource,
  rect?: CanvasRect,
): AppWindowInteractionCommandIntent {
  return {
    command: rect ? { type: "window.float", windowId, rect } : { type: "window.float", windowId },
    source,
  };
}

export function dockAppWindowIntent(
  windowId: string,
  source: AppWindowInteractionCommandSource,
  target: { readonly stackId?: string; readonly index?: number } = {},
): AppWindowInteractionCommandIntent {
  return {
    command: { type: "window.dock", windowId, ...target },
    source,
  };
}

/**
 * Commit a complete floating rect through the repository's atomic
 * `window.float(rect)` operation. Separate move/resize commands can expose an
 * invalid intermediate rect and consume multiple durable revisions.
 */
export function rectCommitIntent(
  windowId: string,
  rect: CanvasRect,
  source: AppWindowInteractionCommandSource,
): AppWindowInteractionCommandIntent {
  return floatAppWindowIntent(windowId, source, rect);
}

/** Restore geometry exists if and only if the window is maximized. */
export type AppWindowMaximizeState =
  | { readonly mode: "restored" }
  | { readonly mode: "maximized"; readonly restoreRect: CanvasRect };

export interface AppWindowMaximizeIntent {
  readonly state: AppWindowMaximizeState;
  readonly rect: CanvasRect;
  /** Exactly one atomic durable transition; never a move/resize sequence. */
  readonly commands: readonly [AppWindowInteractionCommandIntent];
}

function assertNever(value: never): never {
  throw new Error(`unknown maximize mode: ${String(value)}`);
}

/**
 * Maximize is a local layout intent expressed through the existing atomic
 * AppWindow full-rect command; it does not invent a second durable model.
 */
export function toggleAppWindowMaximizeIntent(input: {
  readonly windowId: string;
  readonly currentRect: CanvasRect;
  readonly availableRect: CanvasRect;
  readonly state: AppWindowMaximizeState;
  readonly source: AppWindowInteractionCommandSource;
}): AppWindowMaximizeIntent {
  switch (input.state.mode) {
    case "restored":
      return {
        state: { mode: "maximized", restoreRect: input.currentRect },
        rect: input.availableRect,
        commands: [rectCommitIntent(input.windowId, input.availableRect, input.source)],
      };
    case "maximized":
      return {
        state: { mode: "restored" },
        rect: input.state.restoreRect,
        commands: [rectCommitIntent(input.windowId, input.state.restoreRect, input.source)],
      };
    default:
      return assertNever(input.state);
  }
}
