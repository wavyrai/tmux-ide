import { WidgetAssetSchemaZ, type WidgetAsset } from "@tmux-ide/contracts";

import { resolveHostCapabilities } from "../../host-capabilities.ts";

export type WidgetAssetLoader = (assetId: string) => Promise<WidgetAsset>;

export const loadWidgetAsset: WidgetAssetLoader = async (assetId) => {
  const result = await resolveHostCapabilities().daemon.fetchWidgetAsset({ assetId });
  if (result.status === "error") throw new Error(result.error.reason);
  return WidgetAssetSchemaZ.parse(result.asset);
};

export function widgetAssetDataUrl(asset: WidgetAsset): string {
  return `data:${asset.media};base64,${asset.data}`;
}

export function widgetAssetText(asset: WidgetAsset): string {
  const binary = atob(asset.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
