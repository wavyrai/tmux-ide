/**
 * Helpers that turn a sequence of `ContentBlock`s (or
 * `ToolCallContent`s) into the `ExpandedImageItem` shape the inline
 * preview + fullscreen dialog speak, plus a `previewAt` lookup that
 * anchors the modal cursor at a clicked image while keeping siblings
 * available for ←/→ navigation.
 */

import type { ContentBlock, ToolCallContent } from "../types";
import type { ExpandedImageItem, ExpandedImagePreview } from "../components/ExpandedImagePreview";

export interface ImageBlockEntry {
  /** Index of the source block in the *original* content array. */
  blockIdx: number;
  /** `data:` URL ready for `<img src>`. */
  src: string;
  /** Friendly alt / display name. */
  name: string;
  /** Pre-built modal item — same `src` + `name` as above. */
  item: ExpandedImageItem;
}

/**
 * Walk a content-block array and emit one `ImageBlockEntry` per
 * renderable image block. Skips blocks with missing `data` so the
 * inline preview never points at an empty `data:` URL.
 */
export function collectImageBlocks(blocks: ReadonlyArray<ContentBlock>): ImageBlockEntry[] {
  const entries: ImageBlockEntry[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block?.type !== "image") continue;
    if (typeof block.data !== "string" || block.data.length === 0) continue;
    const mimeType = block.mimeType || "image/png";
    const name = `image-${entries.length + 1}`;
    const src = `data:${mimeType};base64,${block.data}`;
    entries.push({ blockIdx: i, src, name, item: { src, name } });
  }
  return entries;
}

/**
 * Walk a tool-call content array (which wraps content blocks under a
 * `{ type: "content", content: ContentBlock }` discriminator) and
 * emit one entry per image block. Preserves the original tool-call
 * content index so `previewAt` works against the same array the
 * caller iterates.
 */
export function collectToolImageBlocks(
  toolContent: ReadonlyArray<ToolCallContent>,
): ImageBlockEntry[] {
  const entries: ImageBlockEntry[] = [];
  for (let i = 0; i < toolContent.length; i += 1) {
    const entry = toolContent[i];
    if (entry?.type !== "content") continue;
    const block = entry.content;
    if (block?.type !== "image") continue;
    if (typeof block.data !== "string" || block.data.length === 0) continue;
    const mimeType = block.mimeType || "image/png";
    const name = `image-${entries.length + 1}`;
    const src = `data:${mimeType};base64,${block.data}`;
    entries.push({ blockIdx: i, src, name, item: { src, name } });
  }
  return entries;
}

/**
 * Anchor a fullscreen preview cursor at the entry whose original
 * `blockIdx` matches. Returns `null` when the clicked block isn't in
 * the entries list (e.g. it was filtered out for missing data) — the
 * caller should treat that as "don't open the modal".
 */
export function previewAt(
  entries: ReadonlyArray<ImageBlockEntry>,
  blockIdx: number,
): ExpandedImagePreview | null {
  const index = entries.findIndex((entry) => entry.blockIdx === blockIdx);
  if (index < 0) return null;
  return {
    images: entries.map((entry) => entry.item),
    index,
  };
}
