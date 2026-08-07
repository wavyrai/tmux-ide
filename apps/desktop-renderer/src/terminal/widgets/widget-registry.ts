import { z } from "zod";

import {
  AssetPaneImageWidgetArgsSchemaZ,
  AssetPaneMarkdownWidgetArgsSchemaZ,
  PANE_CARD_WIDGET_ID,
  PANE_IMAGE_WIDGET_ID,
  PANE_IMAGE_WIDGET_MEDIA_TYPES,
  PANE_MARKDOWN_WIDGET_ID,
  PaneImageWidgetArgsSchemaZ,
  PaneMarkdownWidgetArgsSchemaZ,
  RichCardWidgetArgsSchemaZ,
  type AssetPaneImageWidgetArgs,
  type AssetPaneMarkdownWidgetArgs,
  type InlinePaneImageWidgetArgs,
  type PaneImageWidgetArgs,
  type PaneMarkdownWidgetArgs,
  type RichCardWidgetArgs,
  type WidgetMarker,
} from "@tmux-ide/contracts";

/**
 * The widget registry: the closed set of ids a marker may name.
 *
 * A marker carries an id and arbitrary JSON. Neither is trusted: the id must be
 * a key of this map, and the JSON must parse against that widget's schema
 * before any component sees it. An unknown id and malformed arguments are
 * distinct, reportable outcomes — a pane that cannot render its widget says
 * which of the two happened rather than silently staying a terminal.
 */

export const MARKDOWN_WIDGET_ID = PANE_MARKDOWN_WIDGET_ID;
export const IMAGE_WIDGET_ID = PANE_IMAGE_WIDGET_ID;
export const CARD_WIDGET_ID = PANE_CARD_WIDGET_ID;
export const MarkdownWidgetArgsSchemaZ = PaneMarkdownWidgetArgsSchemaZ;
export type MarkdownWidgetArgs = PaneMarkdownWidgetArgs;
export type AssetMarkdownWidgetArgs = AssetPaneMarkdownWidgetArgs;

/**
 * Raster media only.
 *
 * `image/svg+xml` is deliberately absent: an SVG is a document that can carry
 * script and external references, so accepting one would turn "render the file
 * this pane named" into "execute the file this pane named". A GIF needs no
 * special handling — an `<img>` animates it.
 */
export const IMAGE_WIDGET_MEDIA_TYPES = PANE_IMAGE_WIDGET_MEDIA_TYPES;
export const ImageWidgetArgsSchemaZ = PaneImageWidgetArgsSchemaZ;
export type ImageWidgetArgs = PaneImageWidgetArgs;
export type InlineImageWidgetArgs = InlinePaneImageWidgetArgs;
export type AssetImageWidgetArgs = AssetPaneImageWidgetArgs;

export interface WidgetDefinition {
  readonly id: string;
  /** Shown in the pane's widget chrome, so it must read as a noun a user knows. */
  readonly label: string;
  readonly schema: z.ZodType<unknown>;
}

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  { id: MARKDOWN_WIDGET_ID, label: "Markdown", schema: MarkdownWidgetArgsSchemaZ },
  { id: IMAGE_WIDGET_ID, label: "Image", schema: ImageWidgetArgsSchemaZ },
  { id: CARD_WIDGET_ID, label: "Card", schema: RichCardWidgetArgsSchemaZ },
];

const BY_ID = new Map(WIDGET_DEFINITIONS.map((definition) => [definition.id, definition]));

export function widgetDefinition(id: string): WidgetDefinition | null {
  return BY_ID.get(id) ?? null;
}

export type WidgetResolution =
  | { readonly status: "ready"; readonly definition: WidgetDefinition; readonly args: unknown }
  | { readonly status: "unknown-widget"; readonly id: string }
  | { readonly status: "invalid-arguments"; readonly id: string; readonly message: string };

/**
 * Resolve a detected marker into something renderable, or into a named refusal.
 *
 * PURE. This is the whole trust boundary between "a pane printed some text" and
 * "the app renders a component": everything downstream of a `ready` result has
 * already been schema-validated.
 */
export function resolveWidget(marker: WidgetMarker): WidgetResolution {
  const definition = BY_ID.get(marker.id);
  if (!definition) return { status: "unknown-widget", id: marker.id };
  const parsed = definition.schema.safeParse(marker.args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".");
    return {
      status: "invalid-arguments",
      id: marker.id,
      message: first
        ? `${path && path.length > 0 ? `${path}: ` : ""}${first.message}`
        : "The widget arguments did not match its schema.",
    };
  }
  return { status: "ready", definition, args: parsed.data };
}

/** The `data:` URL for a validated image widget. Never built from raw marker JSON. */
export function imageWidgetDataUrl(args: InlineImageWidgetArgs): string {
  return `data:${args.media};base64,${args.data}`;
}

export function isAssetMarkdownWidget(args: MarkdownWidgetArgs): args is AssetMarkdownWidgetArgs {
  return AssetPaneMarkdownWidgetArgsSchemaZ.safeParse(args).success;
}

export function isAssetImageWidget(args: ImageWidgetArgs): args is AssetImageWidgetArgs {
  return AssetPaneImageWidgetArgsSchemaZ.safeParse(args).success;
}

export type { RichCardWidgetArgs };
