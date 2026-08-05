import { z } from "zod";

import type { WidgetMarker } from "@tmux-ide/contracts";

/**
 * The widget registry: the closed set of ids a marker may name.
 *
 * A marker carries an id and arbitrary JSON. Neither is trusted: the id must be
 * a key of this map, and the JSON must parse against that widget's schema
 * before any component sees it. An unknown id and malformed arguments are
 * distinct, reportable outcomes — a pane that cannot render its widget says
 * which of the two happened rather than silently staying a terminal.
 */

export const MARKDOWN_WIDGET_ID = "markdown";
export const IMAGE_WIDGET_ID = "image";

export const MarkdownWidgetArgsSchemaZ = z.strictObject({
  text: z.string().max(512 * 1024),
  title: z.string().max(200).optional(),
});
export type MarkdownWidgetArgs = z.infer<typeof MarkdownWidgetArgsSchemaZ>;

/**
 * Raster media only.
 *
 * `image/svg+xml` is deliberately absent: an SVG is a document that can carry
 * script and external references, so accepting one would turn "render the file
 * this pane named" into "execute the file this pane named". A GIF needs no
 * special handling — an `<img>` animates it.
 */
export const IMAGE_WIDGET_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export const ImageWidgetArgsSchemaZ = z.strictObject({
  media: z.enum(IMAGE_WIDGET_MEDIA_TYPES),
  /** Standard base64 (not base64url): it goes straight into a `data:` URL. */
  data: z
    .string()
    .min(1)
    .max(512 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u, "The image payload is not base64."),
  name: z.string().max(200).optional(),
  alt: z.string().max(500).optional(),
});
export type ImageWidgetArgs = z.infer<typeof ImageWidgetArgsSchemaZ>;

export interface WidgetDefinition {
  readonly id: string;
  /** Shown in the pane's widget chrome, so it must read as a noun a user knows. */
  readonly label: string;
  readonly schema: z.ZodType<unknown>;
}

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  { id: MARKDOWN_WIDGET_ID, label: "Markdown", schema: MarkdownWidgetArgsSchemaZ },
  { id: IMAGE_WIDGET_ID, label: "Image", schema: ImageWidgetArgsSchemaZ },
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
export function imageWidgetDataUrl(args: ImageWidgetArgs): string {
  return `data:${args.media};base64,${args.data}`;
}
