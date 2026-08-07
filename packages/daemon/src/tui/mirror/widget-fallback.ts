import {
  AssetPaneImageWidgetArgsSchemaZ,
  AssetPaneMarkdownWidgetArgsSchemaZ,
  InlinePaneImageWidgetArgsSchemaZ,
  InlinePaneMarkdownWidgetArgsSchemaZ,
  PaneMarkdownWidgetArgsSchemaZ,
  RichCardWidgetArgsSchemaZ,
  richCardTextFallback,
  type WidgetMarker,
} from "@tmux-ide/contracts";

export interface TuiWidgetFallback {
  readonly label: string;
  readonly text: string;
  readonly interactive: false;
}

/**
 * Renderer-neutral widget projection for the OpenTUI client.
 *
 * Inline Markdown is ready for OpenTUI's `<markdown>` component. Asset-backed
 * documents remain named placeholders until the TUI receives the same asset
 * loader capability; images intentionally stay textual on terminals without a
 * negotiated Kitty/iTerm2/Sixel renderer.
 */
export function tuiWidgetFallback(marker: WidgetMarker): TuiWidgetFallback | null {
  if (marker.id === "markdown") {
    const parsed = PaneMarkdownWidgetArgsSchemaZ.safeParse(marker.args);
    if (!parsed.success) return null;
    const asset = AssetPaneMarkdownWidgetArgsSchemaZ.safeParse(parsed.data);
    if (asset.success) {
      return {
        label: "Markdown",
        text: `[Markdown: ${asset.data.title ?? asset.data.assetId.slice(0, 12)}]`,
        interactive: false,
      };
    }
    const inline = InlinePaneMarkdownWidgetArgsSchemaZ.parse(parsed.data);
    return { label: "Markdown", text: inline.text, interactive: false };
  }
  if (marker.id === "image") {
    const inline = InlinePaneImageWidgetArgsSchemaZ.safeParse(marker.args);
    const asset = AssetPaneImageWidgetArgsSchemaZ.safeParse(marker.args);
    if (inline.success) {
      return {
        label: "Image",
        text: `[Image: ${inline.data.name ?? "raster image"}]`,
        interactive: false,
      };
    }
    if (asset.success) {
      return {
        label: "Image",
        text: `[Image: ${asset.data.name ?? "raster image"}]`,
        interactive: false,
      };
    }
    return null;
  }
  if (marker.id === "card") {
    const card = RichCardWidgetArgsSchemaZ.safeParse(marker.args);
    if (!card.success) return null;
    return { label: "Card", text: richCardTextFallback(card.data), interactive: false };
  }
  return null;
}
