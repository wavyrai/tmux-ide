import { z } from "zod";
import { DockToolIdSchemaZ } from "./experience-shell.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";

export const FocusZoneSchemaZ = z.enum([
  "application-bar",
  "sidebar",
  "primary-navigation",
  "canvas",
  "dock-tabs",
  "dock-body",
  "status-strip",
  "terminal",
]);
export type FocusZone = z.infer<typeof FocusZoneSchemaZ>;

export const SemanticFocusTargetSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zone"), zone: FocusZoneSchemaZ }).strict(),
  z
    .object({
      kind: z.literal("pane"),
      paneId: SemanticProductIdSchemaZ,
      input: z.enum(["chrome", "terminal"]),
    })
    .strict(),
  z.object({ kind: z.literal("dock-tool"), tool: DockToolIdSchemaZ }).strict(),
  z
    .object({
      kind: z.literal("control"),
      controlId: SemanticProductIdSchemaZ,
      zone: FocusZoneSchemaZ,
    })
    .strict(),
]);
export type SemanticFocusTarget = z.infer<typeof SemanticFocusTargetSchemaZ>;

export const OverlayKindSchemaZ = z.enum(["modal-dialog", "command-palette", "context-menu"]);
export type OverlayKind = z.infer<typeof OverlayKindSchemaZ>;

export const SemanticOverlaySchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    kind: OverlayKindSchemaZ,
    focusReturnTarget: SemanticFocusTargetSchemaZ,
  })
  .strict();
export type SemanticOverlay = z.infer<typeof SemanticOverlaySchemaZ>;

export const FocusOverlayStateV1SchemaZ = z
  .object({
    windowActivity: z.enum(["active", "inactive"]),
    focusZone: FocusZoneSchemaZ,
    appFocusedPaneId: SemanticProductIdSchemaZ.nullable(),
    terminalInputPaneId: SemanticProductIdSchemaZ.nullable(),
    layoutSelectedPaneId: SemanticProductIdSchemaZ.nullable(),
    overlays: z.array(SemanticOverlaySchemaZ).max(16),
  })
  .strict()
  .superRefine((state, ctx) => {
    const ids = state.overlays.map((overlay) => overlay.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "overlay ids must be unique",
        path: ["overlays"],
      });
    }
    if (
      state.terminalInputPaneId !== null &&
      state.appFocusedPaneId !== state.terminalInputPaneId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "terminal input owner must also be the app-focused pane",
        path: ["terminalInputPaneId"],
      });
    }
  });
export type FocusOverlayStateV1 = z.infer<typeof FocusOverlayStateV1SchemaZ>;

export type SemanticInputLayer =
  | { readonly kind: OverlayKind; readonly overlayId: string }
  | { readonly kind: "app"; readonly zone: FocusZone }
  | { readonly kind: "terminal"; readonly paneId: string }
  | { readonly kind: "none" };

const overlayPriority: Readonly<Record<OverlayKind, number>> = {
  "context-menu": 1,
  "command-palette": 2,
  "modal-dialog": 3,
};

/** Only this winning layer may handle a semantic key. */
export function resolveSemanticInputLayer(state: FocusOverlayStateV1): SemanticInputLayer {
  const parsed = FocusOverlayStateV1SchemaZ.parse(state);
  let winner: SemanticOverlay | null = null;
  for (const overlay of parsed.overlays) {
    if (!winner || overlayPriority[overlay.kind] >= overlayPriority[winner.kind]) winner = overlay;
  }
  if (winner) return { kind: winner.kind, overlayId: winner.id };
  if (parsed.terminalInputPaneId !== null && parsed.focusZone === "terminal") {
    return { kind: "terminal", paneId: parsed.terminalInputPaneId };
  }
  return { kind: "app", zone: parsed.focusZone };
}

export interface FocusAvailability {
  readonly paneIds: ReadonlySet<string>;
  readonly controlIds?: ReadonlySet<string>;
}

function targetExists(target: SemanticFocusTarget, availability: FocusAvailability): boolean {
  if (target.kind === "pane") return availability.paneIds.has(target.paneId);
  if (target.kind === "control") return availability.controlIds?.has(target.controlId) === true;
  return true;
}

export function deterministicFocusFallback(
  state: FocusOverlayStateV1,
  availability: FocusAvailability,
): SemanticFocusTarget {
  if (state.appFocusedPaneId && availability.paneIds.has(state.appFocusedPaneId)) {
    return { kind: "pane", paneId: state.appFocusedPaneId, input: "chrome" };
  }
  const firstPaneId = [...availability.paneIds].sort()[0];
  return firstPaneId
    ? { kind: "pane", paneId: firstPaneId, input: "chrome" }
    : { kind: "zone", zone: "primary-navigation" };
}

function applyTarget(state: FocusOverlayStateV1, target: SemanticFocusTarget): FocusOverlayStateV1 {
  if (target.kind === "pane") {
    return {
      ...state,
      focusZone: target.input === "terminal" ? "terminal" : "canvas",
      appFocusedPaneId: target.paneId,
      terminalInputPaneId: target.input === "terminal" ? target.paneId : null,
    };
  }
  if (target.kind === "dock-tool") {
    return { ...state, focusZone: "dock-tabs", terminalInputPaneId: null };
  }
  if (target.kind === "control") {
    return { ...state, focusZone: target.zone, terminalInputPaneId: null };
  }
  return { ...state, focusZone: target.zone, terminalInputPaneId: null };
}

export interface CloseOverlayResult {
  readonly state: FocusOverlayStateV1;
  readonly closedOverlayId: string | null;
  readonly restoredTarget: SemanticFocusTarget;
}

/** Close one top-most overlay and restore a semantic target without host focus handles. */
export function closeTopOverlay(
  state: FocusOverlayStateV1,
  availability: FocusAvailability,
): CloseOverlayResult {
  const parsed = FocusOverlayStateV1SchemaZ.parse(state);
  const closed = parsed.overlays.at(-1) ?? null;
  if (!closed) {
    const restoredTarget = deterministicFocusFallback(parsed, availability);
    return { state: applyTarget(parsed, restoredTarget), closedOverlayId: null, restoredTarget };
  }
  const overlays = parsed.overlays.slice(0, -1);
  const restoredTarget = targetExists(closed.focusReturnTarget, availability)
    ? closed.focusReturnTarget
    : deterministicFocusFallback(parsed, availability);
  return {
    state: applyTarget({ ...parsed, overlays }, restoredTarget),
    closedOverlayId: closed.id,
    restoredTarget,
  };
}
