/**
 * Solid context for hoisting the inline-image "expand" callback to a
 * single fullscreen `ExpandedImageDialog` mount at the
 * `MessagesTimeline` root.
 *
 * Descendants (user content blocks, tool-call content blocks) build a
 * `ExpandedImagePreview` cursor over their local image siblings and
 * call the consumer to open the dialog. Plumbing this as context
 * avoids prop-drilling through `TimelineRow` → `MessageRow` →
 * `AssistantRow` → `ToolCallsCluster` → `ToolCallCard` →
 * `ContentBlockView`, which would touch the entire render tree.
 *
 * When no provider wraps the tree (defensive default for tests /
 * standalone uses of `ToolCallCard`), `useImageExpand()` returns
 * `undefined` and image blocks render as static thumbnails without an
 * onClick — the inline preview component already handles that.
 */

import { createContext, useContext } from "solid-js";
import type { ExpandedImagePreview } from "../components/ExpandedImagePreview";

export type ImageExpandHandler = (preview: ExpandedImagePreview) => void;

export const ImageExpandContext = createContext<ImageExpandHandler | undefined>(undefined);

export function useImageExpand(): ImageExpandHandler | undefined {
  return useContext(ImageExpandContext);
}
