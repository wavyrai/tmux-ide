import { z } from "zod";

import { RichCardWidgetArgsSchemaZ } from "./rich-card-widget.ts";
import { WidgetAssetIdSchemaZ } from "./widget-asset.ts";

export const PANE_MARKDOWN_WIDGET_ID = "markdown";
export const PANE_IMAGE_WIDGET_ID = "image";
export const PANE_CARD_WIDGET_ID = "card";

export const InlinePaneMarkdownWidgetArgsSchemaZ = z.strictObject({
  text: z.string().max(512 * 1024),
  title: z.string().max(200).optional(),
});
export const AssetPaneMarkdownWidgetArgsSchemaZ = z.strictObject({
  assetId: WidgetAssetIdSchemaZ,
  title: z.string().max(200).optional(),
});
export const PaneMarkdownWidgetArgsSchemaZ = z.union([
  InlinePaneMarkdownWidgetArgsSchemaZ,
  AssetPaneMarkdownWidgetArgsSchemaZ,
]);
export type PaneMarkdownWidgetArgs = z.infer<typeof PaneMarkdownWidgetArgsSchemaZ>;
export type AssetPaneMarkdownWidgetArgs = z.infer<typeof AssetPaneMarkdownWidgetArgsSchemaZ>;

export const PANE_IMAGE_WIDGET_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
export const InlinePaneImageWidgetArgsSchemaZ = z.strictObject({
  media: z.enum(PANE_IMAGE_WIDGET_MEDIA_TYPES),
  data: z
    .string()
    .min(1)
    .max(512 * 1024)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u, "The image payload is not base64."),
  name: z.string().max(200).optional(),
  alt: z.string().max(500).optional(),
});
export const AssetPaneImageWidgetArgsSchemaZ = z.strictObject({
  assetId: WidgetAssetIdSchemaZ,
  name: z.string().max(200).optional(),
  alt: z.string().max(500).optional(),
});
export const PaneImageWidgetArgsSchemaZ = z.union([
  InlinePaneImageWidgetArgsSchemaZ,
  AssetPaneImageWidgetArgsSchemaZ,
]);
export type PaneImageWidgetArgs = z.infer<typeof PaneImageWidgetArgsSchemaZ>;
export type InlinePaneImageWidgetArgs = z.infer<typeof InlinePaneImageWidgetArgsSchemaZ>;
export type AssetPaneImageWidgetArgs = z.infer<typeof AssetPaneImageWidgetArgsSchemaZ>;

export const PaneWidgetDescriptorSchemaZ = z.discriminatedUnion("id", [
  z
    .object({ id: z.literal(PANE_MARKDOWN_WIDGET_ID), args: PaneMarkdownWidgetArgsSchemaZ })
    .strict(),
  z.object({ id: z.literal(PANE_IMAGE_WIDGET_ID), args: PaneImageWidgetArgsSchemaZ }).strict(),
  z.object({ id: z.literal(PANE_CARD_WIDGET_ID), args: RichCardWidgetArgsSchemaZ }).strict(),
]);
export type PaneWidgetDescriptor = z.infer<typeof PaneWidgetDescriptorSchemaZ>;
