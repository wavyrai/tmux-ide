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

/** Stable command order is focus, move, then resize. */
export function rectCommitIntents(
  windowId: string,
  before: CanvasRect,
  after: CanvasRect,
  source: AppWindowInteractionCommandSource,
  options: { readonly focus?: boolean } = {},
): readonly AppWindowInteractionCommandIntent[] {
  const intents: AppWindowInteractionCommandIntent[] = [];
  if (options.focus ?? true) intents.push(focusAppWindowIntent(windowId, source));
  if (before.x !== after.x || before.y !== after.y) {
    intents.push(moveAppWindowIntent(windowId, after, source));
  }
  if (before.width !== after.width || before.height !== after.height) {
    intents.push(resizeAppWindowIntent(windowId, after, source));
  }
  return intents;
}

export interface AppWindowMaximizeState {
  readonly mode: "maximized" | "restored";
  /** Original floating rect while maximized; null while restored. */
  readonly restoreRect: CanvasRect | null;
}

export interface AppWindowMaximizeIntent {
  readonly state: AppWindowMaximizeState;
  readonly rect: CanvasRect;
  readonly commands: readonly AppWindowInteractionCommandIntent[];
}

/**
 * Maximize is a local layout intent expressed through existing AppWindow move
 * and resize commands; it does not invent a second durable placement model.
 */
export function toggleAppWindowMaximizeIntent(input: {
  readonly windowId: string;
  readonly currentRect: CanvasRect;
  readonly availableRect: CanvasRect;
  readonly state: AppWindowMaximizeState;
  readonly source: AppWindowInteractionCommandSource;
}): AppWindowMaximizeIntent {
  const maximizing = input.state.mode === "restored";
  const rect = maximizing ? input.availableRect : (input.state.restoreRect ?? input.currentRect);
  return {
    state: maximizing
      ? { mode: "maximized", restoreRect: input.currentRect }
      : { mode: "restored", restoreRect: null },
    rect,
    commands: rectCommitIntents(input.windowId, input.currentRect, rect, input.source),
  };
}
