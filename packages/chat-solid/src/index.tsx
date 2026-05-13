import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatThreadView } from "./components/ChatThreadView";
import "./styles.css";
import type { ChatHandle, ChatMountOptions } from "./types";

export type { ChatHandle, ChatMountOptions } from "./types";
export type { MentionCandidate, MentionSearchResult } from "./lib/mentionSearch";
export { detectMentionContext, type MentionContext } from "./lib/mentionCursor";
export { searchMentions } from "./lib/mentionSearch";
export {
  loadDraft,
  saveDraft,
  clearDraft,
  flushDrafts,
} from "./lib/composerDraftStore";
export type { MarkdownFileLinkMeta } from "./lib/markdownLinks";
export {
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./lib/markdownLinks";
export { renderMarkdown } from "./lib/markdown";
export {
  buildExpandedImagePreview,
  InlineImagePreview,
  type ExpandedImageItem,
  type ExpandedImagePreview,
} from "./components/ExpandedImagePreview";
export { ExpandedImageDialog } from "./components/ExpandedImageDialog";

export function mount(container: HTMLElement, opts: ChatMountOptions): ChatHandle {
  const [options, setOptions] = createSignal(opts);
  container.classList.add("chat-solid-root");
  const dispose = render(() => <ChatThreadView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("chat-solid-root");
    },
    setThreadId(threadId: string) {
      setOptions((current) => ({ ...current, threadId }));
    },
    setOptions(next) {
      setOptions((current) => ({ ...current, ...next }));
    },
  };
}
