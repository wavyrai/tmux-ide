import { z } from "zod";

/**
 * Renderer-neutral icon meanings shared by every product host.
 *
 * Host adapters own glyphs, vectors, measurements, and accessibility wiring.
 * These IDs only preserve semantic identity across those adapters.
 */
export const SEMANTIC_ICON_IDS = [
  "home",
  "terminals",
  "files",
  "changes",
  "missions",
  "activity",
  "preview",
  "native",
  "more",
  "close",
  "minimize",
  "maximize",
  "restore",
  "split-right",
  "split-down",
  "duplicate",
  "dock",
  "float",
  "move",
  "resize",
  "pop-out",
  "search",
  "refresh",
  "command",
] as const;
export const SemanticIconIdSchemaZ = z.enum(SEMANTIC_ICON_IDS);
export type SemanticIconId = z.infer<typeof SemanticIconIdSchemaZ>;

/** Semantic content role of a framed pane; presentation remains host-owned. */
export const PANE_ROLE_IDS = [
  "home",
  "terminal",
  "files",
  "changes",
  "missions",
  "activity",
  "preview",
  "native",
] as const;
export const PaneRoleIdSchemaZ = z.enum(PANE_ROLE_IDS);
export type PaneRoleId = z.infer<typeof PaneRoleIdSchemaZ>;
