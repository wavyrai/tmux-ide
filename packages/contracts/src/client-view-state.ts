import { z } from "zod";

import {
  APP_WINDOW_MAX_ID_LENGTH,
  APP_WINDOW_MAX_WINDOWS,
  AppWindowDocumentV1SchemaZ,
  AppWindowIdSchemaZ,
  type AppWindowDockNodeShape,
  type AppWindowDocumentV1,
} from "./app-window-state.ts";
import { DockToolIdSchemaZ } from "./experience-shell.ts";
import { FocusZoneSchemaZ } from "./focus-overlay.ts";

/**
 * Renderer-owned presentation state for one view of a shared workspace.
 *
 * This document is deliberately not part of AppWindowDocumentV1. The latter is
 * shared, durable layout; this value describes how one browser tab or TUI is
 * currently looking at it. Clients may persist it under their own identity,
 * but must never publish it as a shared AppWindow mutation.
 */
export const CLIENT_VIEW_STATE_VERSION = 1 as const;

export const ClientViewIdentitySchemaZ = z
  .string()
  .min(1)
  .max(APP_WINDOW_MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
export type ClientViewIdentity = z.infer<typeof ClientViewIdentitySchemaZ>;

export const ClientCanvasViewportSchemaZ = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000),
    scale: z.number().finite().min(0.1).max(8),
  })
  .strict();
export type ClientCanvasViewport = z.infer<typeof ClientCanvasViewportSchemaZ>;

export const ClientDockPresentationSchemaZ = z
  .object({
    mode: z.enum(["collapsed", "open", "maximized"]),
    preferredHeight: z.number().int().nonnegative().max(1_000_000).nullable(),
    focusZone: FocusZoneSchemaZ,
    activeTabId: DockToolIdSchemaZ.nullable(),
  })
  .strict();
export type ClientDockPresentation = z.infer<typeof ClientDockPresentationSchemaZ>;

export const ClientViewStateV1SchemaZ = z
  .object({
    version: z.literal(CLIENT_VIEW_STATE_VERSION),
    /** Stable device/process identity. Several views may belong to one client. */
    clientId: ClientViewIdentitySchemaZ,
    /** Stable identity for one browser tab, window, or TUI renderer. */
    viewId: ClientViewIdentitySchemaZ,
    /** Correlation only; never grants authority over a workspace. */
    workspaceId: z.string().min(1).max(512),
    focusedWindowId: AppWindowIdSchemaZ.nullable(),
    /** Local active tab override for each durable dock stack. */
    activeWindowIdsByStack: z.record(AppWindowIdSchemaZ, AppWindowIdSchemaZ),
    selectedWindowIds: z
      .array(AppWindowIdSchemaZ)
      .max(APP_WINDOW_MAX_WINDOWS)
      .refine((value) => new Set(value).size === value.length, {
        message: "selected window ids must be unique",
      }),
    dock: ClientDockPresentationSchemaZ,
    viewport: ClientCanvasViewportSchemaZ,
  })
  .strict();
export type ClientViewStateV1 = z.infer<typeof ClientViewStateV1SchemaZ>;

function stackActiveWindows(
  node: AppWindowDockNodeShape | null,
  output: Record<string, string>,
): void {
  if (node === null) return;
  if (node.type === "stack") {
    output[node.id] = node.activeWindowId;
    return;
  }
  for (const child of node.children) stackActiveWindows(child, output);
}

export interface CreateClientViewStateV1Input {
  readonly clientId: string;
  readonly viewId: string;
  readonly workspaceId: string;
  /** Optional migration source while AppWindowDocumentV1 still carries presentation memory. */
  readonly legacyDocument?: AppWindowDocumentV1 | null;
}

/** Seed a new local view from the readable V1 legacy presentation fields. */
export function createClientViewStateV1(input: CreateClientViewStateV1Input): ClientViewStateV1 {
  const document = input.legacyDocument
    ? AppWindowDocumentV1SchemaZ.parse(input.legacyDocument)
    : null;
  const activeWindowIdsByStack: Record<string, string> = {};
  stackActiveWindows(document?.dockRoot ?? null, activeWindowIdsByStack);
  return ClientViewStateV1SchemaZ.parse({
    version: CLIENT_VIEW_STATE_VERSION,
    clientId: input.clientId,
    viewId: input.viewId,
    workspaceId: input.workspaceId,
    focusedWindowId: document?.focusedWindowId ?? null,
    activeWindowIdsByStack,
    selectedWindowIds: document?.focusedWindowId ? [document.focusedWindowId] : [],
    dock: {
      mode: document?.dockState.mode ?? "collapsed",
      preferredHeight: document?.dockState.preferredHeight ?? null,
      focusZone: document?.dockState.focusZone ?? "canvas",
      activeTabId: null,
    },
    viewport: { x: 0, y: 0, scale: 1 },
  });
}

function collectStacks(
  node: AppWindowDockNodeShape | null,
  output: Map<string, ReadonlySet<string>>,
): void {
  if (node === null) return;
  if (node.type === "stack") {
    output.set(node.id, new Set(node.windowIds));
    return;
  }
  for (const child of node.children) collectStacks(child, output);
}

/**
 * Reconcile local references after a shared layout snapshot changes. Viewport
 * and dock presentation survive; references to removed windows/stacks do not.
 */
export function reconcileClientViewStateV1(
  value: ClientViewStateV1,
  nextDocument: AppWindowDocumentV1,
): ClientViewStateV1 {
  const state = ClientViewStateV1SchemaZ.parse(value);
  const document = AppWindowDocumentV1SchemaZ.parse(nextDocument);
  const stacks = new Map<string, ReadonlySet<string>>();
  collectStacks(document.dockRoot, stacks);
  const activeWindowIdsByStack: Record<string, string> = {};
  for (const [stackId, windowId] of Object.entries(state.activeWindowIdsByStack)) {
    if (stacks.get(stackId)?.has(windowId)) activeWindowIdsByStack[stackId] = windowId;
  }
  return ClientViewStateV1SchemaZ.parse({
    ...state,
    focusedWindowId:
      state.focusedWindowId && Object.hasOwn(document.windows, state.focusedWindowId)
        ? state.focusedWindowId
        : null,
    activeWindowIdsByStack,
    selectedWindowIds: state.selectedWindowIds.filter((id) => Object.hasOwn(document.windows, id)),
  });
}
