import { z } from "zod";

import { DesktopDaemonCapabilityErrorSchemaZ } from "./desktop-host.ts";

/** Content-addressed id minted by the local widget asset store. */
export const WidgetAssetIdSchemaZ = z.string().regex(/^[0-9a-f]{64}$/u);
export type WidgetAssetId = z.infer<typeof WidgetAssetIdSchemaZ>;

/** Deliberately excludes SVG and every executable/document media type. */
export const WIDGET_ASSET_MEDIA_TYPES = [
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
export const WidgetAssetMediaTypeSchemaZ = z.enum(WIDGET_ASSET_MEDIA_TYPES);
export type WidgetAssetMediaType = z.infer<typeof WidgetAssetMediaTypeSchemaZ>;

export const WidgetAssetRequestSchemaZ = z.object({ assetId: WidgetAssetIdSchemaZ }).strict();
export type WidgetAssetRequest = z.infer<typeof WidgetAssetRequestSchemaZ>;

export const WidgetAssetSchemaZ = z
  .object({
    assetId: WidgetAssetIdSchemaZ,
    media: WidgetAssetMediaTypeSchemaZ,
    name: z.string().min(1).max(200),
    /** Standard base64. The renderer builds a data URL only after validation. */
    data: z
      .string()
      .min(1)
      .max(24 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  })
  .strict();
export type WidgetAsset = z.infer<typeof WidgetAssetSchemaZ>;

export const WidgetAssetResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), asset: WidgetAssetSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);
export type WidgetAssetResult = z.infer<typeof WidgetAssetResultSchemaZ>;
