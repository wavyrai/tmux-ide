import { createMemo, createSignal, For, Show } from "solid-js";
import type { ContentBlock, ToolCallContent, ToolCallStatus, ToolCallView } from "../types";
import { collectToolImageBlocks, previewAt } from "../lib/imageBlocks";
import { useImageExpand } from "../lib/imageExpand";
import { InlineImagePreview } from "./ExpandedImagePreview";
import { MessageCopyButton } from "./MessageCopyButton";

/**
 * Single tool-call cluster. Header shows the title + kind + a
 * status badge (running / done / error). Body lazy-renders the
 * tool output — clamped to a few lines on long outputs with a
 * "Show full output" toggle, and a copy-output button on hover.
 *
 *   ┌─ ToolCallCard ─────────────────────────────────────┐
 *   │ ▸ Run tests   pytest    ● running         [copy]   │
 *   ├─────────────────────────────────────────────────────┤
 *   │ pytest -q                                           │
 *   │ ........                                            │
 *   │ ...                                  +12 lines hidden│
 *   │                                  Show full output → │
 *   └─────────────────────────────────────────────────────┘
 *
 * Status mapping:
 *   - pending / in_progress  → "running" (accent, animated dot)
 *   - completed              → "done"     (green check)
 *   - failed                 → "error"    (red x)
 *   - undefined              → "queued"   (dim, neutral)
 */

const TRUNCATE_LINE_LIMIT = 12;
const TRUNCATE_CHAR_LIMIT = 1_400;

interface StatusBadgeMeta {
  label: string;
  variant: "running" | "done" | "error" | "queued";
  glyph: string;
}

export function statusBadgeMeta(status: ToolCallStatus | null | undefined): StatusBadgeMeta {
  if (status === "completed") return { label: "done", variant: "done", glyph: "✓" };
  if (status === "failed") return { label: "error", variant: "error", glyph: "✕" };
  if (status === "in_progress" || status === "pending") {
    return { label: "running", variant: "running", glyph: "●" };
  }
  return { label: "queued", variant: "queued", glyph: "·" };
}

const BADGE_CLASS: Record<StatusBadgeMeta["variant"], string> = {
  running:
    "inline-flex items-center gap-1 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--accent)]",
  done:
    "inline-flex items-center gap-1 rounded border border-[var(--green,#0a0)]/40 bg-[var(--green,#0a0)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--green,#0a0)]",
  error:
    "inline-flex items-center gap-1 rounded border border-[var(--red,#c33)]/40 bg-[var(--red,#c33)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--red,#c33)]",
  queued:
    "inline-flex items-center gap-1 rounded border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--dim)]",
};

/**
 * Extract a copyable text representation from a tool-call's content
 * blocks. Concatenates every `text` block, includes diff paths +
 * new-text for `diff` entries, and returns "" when nothing usable
 * is present.
 */
export function toolCallCopyText(toolCall: ToolCallView): string {
  const parts: string[] = [];
  for (const entry of toolCall.content) {
    if (entry.type === "content") {
      const block = entry.content;
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "resource" && block.resource.text) {
        parts.push(block.resource.text);
      }
      continue;
    }
    if (entry.type === "diff") {
      parts.push(`# ${entry.path}\n${entry.newText}`);
      continue;
    }
    if (entry.type === "terminal") {
      parts.push(`[terminal ${entry.terminalId}]`);
    }
  }
  return parts.join("\n").trim();
}

interface TruncatedTextResult {
  visible: string;
  hiddenLines: number;
  truncated: boolean;
}

export function truncateToolText(
  text: string,
  options: { maxLines?: number; maxChars?: number } = {},
): TruncatedTextResult {
  const maxLines = options.maxLines ?? TRUNCATE_LINE_LIMIT;
  const maxChars = options.maxChars ?? TRUNCATE_CHAR_LIMIT;
  if (text.length === 0) {
    return { visible: "", hiddenLines: 0, truncated: false };
  }
  const lines = text.split(/\r?\n/);
  let truncated = false;
  let visibleLines = lines;
  let hiddenLines = 0;
  if (lines.length > maxLines) {
    visibleLines = lines.slice(0, maxLines);
    hiddenLines = lines.length - maxLines;
    truncated = true;
  }
  let visible = visibleLines.join("\n");
  if (visible.length > maxChars) {
    visible = `${visible.slice(0, maxChars)}…`;
    truncated = true;
  }
  return { visible, hiddenLines, truncated };
}

export function ToolCallCard(props: { toolCall: ToolCallView }) {
  const imageEntries = createMemo(() => collectToolImageBlocks(props.toolCall.content));
  const onExpand = useImageExpand();
  const [expanded, setExpanded] = createSignal(false);
  const [showFullOutput, setShowFullOutput] = createSignal(false);

  const badge = createMemo(() => statusBadgeMeta(props.toolCall.status));
  const copyText = createMemo(() => toolCallCopyText(props.toolCall));
  const hasCopyText = createMemo(() => copyText().length > 0);

  return (
    <details
      data-testid="tool-call-card"
      data-status={badge().variant}
      class="group/tool mt-2 rounded-md border border-border-weak bg-bg"
      open={expanded()}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-[12px] text-fg-secondary">
        <span data-testid="tool-call-card-chevron" aria-hidden="true">
          {expanded() ? "▾" : "▸"}
        </span>
        <strong class="min-w-0 flex-1 truncate text-fg">{props.toolCall.title}</strong>
        <Show when={props.toolCall.kind}>
          {(kind) => <span class="text-[11px] text-dim">{kind()}</span>}
        </Show>
        <span
          data-testid="tool-call-card-status"
          data-status={badge().variant}
          class={BADGE_CLASS[badge().variant]}
        >
          <span
            aria-hidden="true"
            class={badge().variant === "running" ? "animate-pulse" : undefined}
          >
            {badge().glyph}
          </span>
          <span>{badge().label}</span>
        </span>
        <Show when={hasCopyText() && expanded()}>
          <span
            data-testid="tool-call-card-copy"
            class="opacity-0 transition-opacity group-hover/tool:opacity-100"
          >
            <MessageCopyButton text={copyText()} />
          </span>
        </Show>
      </summary>
      <div
        data-testid="tool-call-card-body"
        class="border-t border-border-weak px-2.5 py-2 text-[12px] text-fg-secondary"
      >
        <Show
          when={props.toolCall.content.length > 0}
          fallback={<div class="text-dim">No tool output yet.</div>}
        >
          <For each={props.toolCall.content}>
            {(content, index) => (
              <ToolContent
                content={content}
                showFullOutput={showFullOutput}
                onShowFullOutput={() => setShowFullOutput(true)}
                onExpandImage={
                  onExpand
                    ? () => {
                        const cursor = previewAt(imageEntries(), index());
                        if (cursor) onExpand(cursor);
                      }
                    : undefined
                }
              />
            )}
          </For>
        </Show>
      </div>
    </details>
  );
}

function ToolContent(props: {
  content: ToolCallContent;
  showFullOutput: () => boolean;
  onShowFullOutput: () => void;
  onExpandImage?: () => void;
}) {
  if (props.content.type === "content") {
    return (
      <ContentBlockView
        block={props.content.content}
        showFullOutput={props.showFullOutput}
        onShowFullOutput={props.onShowFullOutput}
        onExpandImage={props.onExpandImage}
      />
    );
  }
  if (props.content.type === "diff") {
    return (
      <div data-testid="tool-call-card-diff" class="font-mono text-[11px]">
        <span class="text-dim">{props.content.path}</span>
      </div>
    );
  }
  return (
    <div data-testid="tool-call-card-terminal" class="font-mono text-[11px] text-dim">
      Terminal: {props.content.terminalId}
    </div>
  );
}

export function ContentBlockView(props: {
  block: ContentBlock;
  showFullOutput?: () => boolean;
  onShowFullOutput?: () => void;
  /** Optional: when present and the block is an image, clicking the
   *  inline preview opens the fullscreen dialog with a cursor anchored
   *  at this image. Parent computes the cursor. */
  onExpandImage?: () => void;
}) {
  switch (props.block.type) {
    case "text": {
      const text = props.block.text;
      const showFull = (): boolean => props.showFullOutput?.() ?? true;
      const result = createMemo<TruncatedTextResult>(() =>
        showFull()
          ? { visible: text, hiddenLines: 0, truncated: false }
          : truncateToolText(text),
      );
      return (
        <div>
          <p
            data-testid="tool-call-text"
            class="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg"
          >
            {result().visible}
          </p>
          <Show when={!showFull() && result().truncated}>
            <button
              type="button"
              data-testid="tool-call-show-more"
              data-hidden-lines={result().hiddenLines}
              class="mt-1 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-accent hover:underline"
              onClick={() => props.onShowFullOutput?.()}
            >
              Show full output
              <Show when={result().hiddenLines > 0}>
                <span class="ml-1 text-dim">
                  (+{result().hiddenLines} line{result().hiddenLines === 1 ? "" : "s"} hidden)
                </span>
              </Show>
            </button>
          </Show>
        </div>
      );
    }
    case "image": {
      const block = props.block;
      const src = createMemo(() => {
        if (typeof block.data !== "string" || block.data.length === 0) return "";
        const mime = block.mimeType || "image/png";
        return `data:${mime};base64,${block.data}`;
      });
      return (
        <Show
          when={src().length > 0}
          fallback={<p class="text-[12px] text-dim">Image attachment ({props.block.mimeType})</p>}
        >
          <div data-testid="tool-image-block" class="my-1.5 inline-block max-w-[400px]">
            <InlineImagePreview
              src={src}
              alt={() => `image (${block.mimeType || "image"})`}
              onExpand={props.onExpandImage}
            />
          </div>
        </Show>
      );
    }
    case "audio":
      return <p class="text-[12px] text-dim">Audio attachment ({props.block.mimeType})</p>;
    case "resource":
      return (
        <p class="text-[12px] text-dim">{props.block.resource.text ?? props.block.resource.uri}</p>
      );
    case "resource_link":
      return (
        <a href={props.block.uri} class="text-accent hover:underline">
          {props.block.name ?? props.block.uri}
        </a>
      );
  }
}
