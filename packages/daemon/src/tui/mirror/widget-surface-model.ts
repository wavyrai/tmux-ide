import {
  AssetPaneMarkdownWidgetArgsSchemaZ,
  InlinePaneMarkdownWidgetArgsSchemaZ,
  type WidgetMarker,
} from "@tmux-ide/contracts";

import type { StoredWidgetAsset } from "../../lib/widget-asset-store.ts";
import { tuiWidgetFallback } from "./widget-fallback.ts";

export interface TuiWidgetSurface {
  readonly kind: "markdown" | "fallback";
  readonly label: string;
  readonly title: string | null;
  readonly text: string;
}

export type TuiWidgetAssetReader = (assetId: string) => StoredWidgetAsset | null;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HTML_BLOCK_OPEN =
  /^<(address|article|aside|blockquote|body|caption|center|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frameset|h[1-6]|head|header|html|iframe|legend|li|main|menu|nav|noframes|ol|optgroup|option|p|picture|pre|script|search|section|style|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?:\s|>)/iu;
const HTML_VOID_LINE =
  /^<(?:base|basefont|col|frame|hr|img|input|link|meta|param|source|track)(?:\s|>|\/)/iu;
const INLINE_HTML_TAG = /<\/?[A-Za-z][^>\n]*>/gu;

/**
 * OpenTUI's Markdown renderer intentionally targets Markdown, not browser HTML.
 * Remove CommonMark HTML blocks before handing it a document so README badge
 * scaffolding cannot consume terminal cells or disturb later block geometry.
 * Fenced code remains byte-for-byte intact, including HTML examples.
 */
export function normalizeMarkdownForTui(source: string): string {
  const output: string[] = [];
  let fence: string | null = null;
  let htmlBlock: string | null = null;
  let htmlComment = false;

  for (const line of source.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = line.trim();
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      output.push(line);
      continue;
    }
    if (fence !== null) {
      output.push(line);
      continue;
    }

    if (htmlComment) {
      if (trimmed.includes("-->")) htmlComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) htmlComment = true;
      continue;
    }

    if (htmlBlock !== null) {
      if (new RegExp(`</${htmlBlock}\\s*>`, "iu").test(trimmed)) htmlBlock = null;
      continue;
    }

    const block = HTML_BLOCK_OPEN.exec(trimmed);
    if (block) {
      const tag = block[1]!.toLowerCase();
      if (!new RegExp(`</${tag}\\s*>`, "iu").test(trimmed)) htmlBlock = tag;
      continue;
    }
    if (HTML_VOID_LINE.test(trimmed)) continue;

    output.push(line.replace(INLINE_HTML_TAG, ""));
  }

  return output.join("\n").replace(/^\s*\n+/u, "");
}

/**
 * Host projection for the shared widget descriptor.
 *
 * OpenTUI has a native MarkdownRenderable, so both inline and asset-backed
 * Markdown become real structured terminal UI. Raster images remain an honest
 * capability fallback: the web/Electron hosts can animate GIFs, while an
 * arbitrary terminal has no guaranteed pixel protocol. Cards use their shared
 * text projection until a dedicated OpenTUI card component lands.
 */
export function resolveTuiWidgetSurface(
  marker: WidgetMarker,
  readAsset: TuiWidgetAssetReader,
): TuiWidgetSurface | null {
  if (marker.id === "markdown") {
    const inline = InlinePaneMarkdownWidgetArgsSchemaZ.safeParse(marker.args);
    if (inline.success) {
      return {
        kind: "markdown",
        label: "Markdown",
        title: inline.data.title ?? null,
        text: normalizeMarkdownForTui(inline.data.text),
      };
    }

    const assetArgs = AssetPaneMarkdownWidgetArgsSchemaZ.safeParse(marker.args);
    if (!assetArgs.success) return null;
    const asset = readAsset(assetArgs.data.assetId);
    if (!asset || asset.media !== "text/markdown") {
      return {
        kind: "fallback",
        label: "Markdown",
        title: assetArgs.data.title ?? null,
        text: "Markdown asset is unavailable. Re-run the widget command to publish it again.",
      };
    }
    try {
      return {
        kind: "markdown",
        label: "Markdown",
        title: assetArgs.data.title ?? asset.name,
        text: normalizeMarkdownForTui(
          new TextDecoder("utf-8", { fatal: true }).decode(asset.bytes),
        ),
      };
    } catch {
      return {
        kind: "fallback",
        label: "Markdown",
        title: assetArgs.data.title ?? asset.name,
        text: "Markdown asset is not valid UTF-8.",
      };
    }
  }

  const fallback = tuiWidgetFallback(marker);
  if (!fallback) return null;
  return {
    kind: "fallback",
    label: fallback.label,
    title: null,
    text:
      marker.id === "image"
        ? `${fallback.text}\n\nAnimated images render in the web GUI. This terminal has no negotiated pixel protocol.`
        : fallback.text,
  };
}
