/**
 * MessagesTimeline — flat-transcript renderer for chat-solid.
 *
 * Replaces the bubble UI with a quiet, full-width transcript that
 * mirrors a production-grade IDE chat: each turn is a row carrying a
 * compact role header, the message body at full row width, and (for
 * assistant rows) collapsible tool-call clusters underneath. No
 * bubbles. Tone is conveyed by a single glyph + name in the header
 * strip; the body itself stays on the thread background so the eye
 * can scan multi-turn threads without bubble whiplash.
 *
 * Splits into two files (matching the reference layering):
 *   - MessagesTimeline.logic.ts  pure helpers (signature, copy-state,
 *                                terminal-message detection, tone)
 *   - MessagesTimeline.tsx       Solid render only (this file)
 *
 * Tool calls collapse by default into a "Tool calls (N)" chip
 * header; click to expand. The chip color hints at status — danger
 * tone if any failed, accent tone if any in-flight, otherwise quiet.
 */

import { createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { deriveChangedFiles } from "../lib/changedFiles";
import { collectImageBlocks, previewAt } from "../lib/imageBlocks";
import { ImageExpandContext, useImageExpand, type ImageExpandHandler } from "../lib/imageExpand";
import { renderMarkdown } from "../lib/markdown";
import { resolveMarkdownFileLinkMeta } from "../lib/markdownLinks";
import type {
  ChatMessage,
  ContentBlock,
  MarkdownFileLinkMeta,
  MessagesTimelineRow,
  ThreadMessage,
  ToolCallView,
  WorkLogEntry,
} from "../types";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { InlineImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { MessageCopyButton } from "./MessageCopyButton";
import { MessageRoleHeader } from "./MessageRoleHeader";
import {
  deriveMessageTone,
  deriveTerminalAssistantMessageIds,
  formatTurnDuration,
  resolveAssistantCopyState,
  rowSignature,
  splitWorkEntries,
  summarizeToolCalls,
} from "./MessagesTimeline.logic";
import { PlanCard } from "./PlanCard";
import { ContentBlockView, ToolCallCard } from "./ToolCallCard";
import { WorkingIndicator } from "./WorkingIndicator";

export function MessagesTimeline(props: {
  rows: Accessor<MessagesTimelineRow[]>;
  messages: Accessor<ThreadMessage[]>;
  providerName: Accessor<string>;
  /** Project dir for markdown relative-link resolution. */
  cwd?: Accessor<string | undefined>;
  /** Fired when a markdown file link inside a message is clicked. */
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  onSendPlanRequest?: (markdown: string) => void;
  /**
   * Fired when the user clicks the "Revert from here" button on a
   * user message annotated with `revertTurnCount`. Host owns the
   * actual rewind dispatch — chat-solid only surfaces the affordance.
   */
  onRevertFromMessage?: (userMessageId: string) => void;
}) {
  const [container, setContainer] = createSignal<HTMLElement>();
  const [sentinel, setSentinel] = createSignal<HTMLElement>();
  const [expandedPreview, setExpandedPreview] = createSignal<ExpandedImagePreview | null>(null);
  const changedFiles = createMemo(() => deriveChangedFiles(props.messages()));
  const followSignal = createMemo(() => props.rows().map(rowSignature).join("|"));
  const terminalAssistantIds = createMemo(() => deriveTerminalAssistantMessageIds(props.rows()));
  useAutoScroll(container, sentinel, followSignal);

  // Variable-height virtualizer: each row reports its real size via
  // `measureElement` (the virtualizer wires a ResizeObserver per row so
  // streaming growth re-measures automatically). The estimate is the
  // average IDE chat row at first paint; the cache fills in real sizes
  // as rows enter the viewport.
  const virtualizer = createVirtualizer({
    get count() {
      return props.rows().length;
    },
    getScrollElement: () => container() ?? null,
    estimateSize: () => 90,
    overscan: 4,
  });

  // Single dialog mount hoisted to the timeline so user / assistant
  // / tool-call image clicks all open the same overlay. Closing seeds
  // `null` back into the signal so `<ExpandedImageDialog>` unmounts.
  const onExpand: ImageExpandHandler = (preview) => setExpandedPreview(preview);

  return (
    <ImageExpandContext.Provider value={onExpand}>
      <Show
        when={props.rows().length > 0}
        fallback={
          <div
            data-testid="messages-timeline-empty"
            class="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[var(--fg-muted,var(--dim))]"
          >
            Send a message to start this chat.
          </div>
        }
      >
        <div
          ref={setContainer}
          data-testid="messages-timeline"
          class="min-h-0 flex-1 overflow-auto bg-[var(--bg)]"
          style={{ position: "relative" }}
        >
          <Show when={changedFiles().length > 0}>
            <div class="mx-auto w-full max-w-3xl px-4 pt-5">
              <ChangedFilesTree files={changedFiles} />
            </div>
          </Show>
          <div
            data-testid="messages-timeline-spacer"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            <For each={virtualizer.getVirtualItems()}>
              {(vItem) => {
                // Per-row memo keyed on `rowSignature`: when a sibling
                // row streams and a new `rows()` array is produced,
                // unchanged rows keep their previous reference here so
                // the TimelineRow subtree skips re-derivation.
                const row = createMemo(() => props.rows()[vItem.index]!, undefined, {
                  equals: (a, b) => !!a && !!b && rowSignature(a) === rowSignature(b),
                });
                return (
                  <div
                    data-index={vItem.index}
                    ref={(el) => virtualizer.measureElement(el)}
                    style={{
                      position: "absolute",
                      top: "0",
                      left: "0",
                      width: "100%",
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    <div class="mx-auto flex w-full max-w-3xl flex-col px-4">
                      <TimelineRow
                        row={row()}
                        providerName={props.providerName}
                        cwd={props.cwd}
                        onOpenFile={props.onOpenFile}
                        onSendPlanRequest={props.onSendPlanRequest}
                        onRevertFromMessage={props.onRevertFromMessage}
                        isTerminalAssistant={(id) => terminalAssistantIds().has(id)}
                      />
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
          <div ref={setSentinel} />
        </div>
      </Show>
      <ExpandedImageDialog preview={expandedPreview} onClose={() => setExpandedPreview(null)} />
    </ImageExpandContext.Provider>
  );
}

interface TimelineRowProps {
  row: MessagesTimelineRow;
  providerName: Accessor<string>;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  onSendPlanRequest?: (markdown: string) => void;
  onRevertFromMessage?: (userMessageId: string) => void;
  isTerminalAssistant: (id: string) => boolean;
}

function TimelineRow(props: TimelineRowProps): JSX.Element {
  if (props.row.kind === "plan") {
    return (
      <div
        data-testid="message-row"
        data-kind="plan"
        class="border-l-2 border-[var(--border)] pl-3 py-3"
      >
        <PlanCard entries={props.row.entries} onSendPlanRequest={props.onSendPlanRequest} />
      </div>
    );
  }
  if (props.row.kind === "working") {
    return (
      <div data-testid="message-row" data-kind="working" class="py-2 pl-1">
        <WorkingIndicator />
      </div>
    );
  }
  if (props.row.kind === "work") {
    return <WorkGroupRow entries={props.row.entries} />;
  }
  // Re-read the row through a memo so token updates re-evaluate
  // every getter below. The old code did `const messageRow =
  // props.row` which captured the value once — subsequent token
  // arrivals replaced `props.row` but the local stayed pinned to
  // the original object and the rendered message went stale.
  type MessageRowVariant = Extract<MessagesTimelineRow, { kind: "message" }>;
  const messageRow = createMemo<MessageRowVariant>(() => props.row as MessageRowVariant);
  const message = createMemo(() => messageRow().message);
  const showDivider = (): boolean =>
    message().role === "assistant" && Boolean(messageRow().showCompletionDivider);
  const dividerLabel = (): string => {
    if (!showDivider()) return "Completed turn";
    const start = messageRow().completionTurnStartedAt;
    const m = message();
    const end =
      m.role === "assistant"
        ? (m.completedAt ?? messageRow().createdAt)
        : messageRow().createdAt;
    if (!start) return "Completed turn";
    const duration = formatTurnDuration(start, end);
    return duration ? `Completed in ${duration}` : "Completed turn";
  };
  return (
    <>
      <Show when={showDivider()}>
        <div
          data-testid="message-completion-divider"
          data-turn-started-at={messageRow().completionTurnStartedAt ?? ""}
          class="my-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-[var(--fg-muted,var(--dim))]"
          aria-label={dividerLabel()}
        >
          <span aria-hidden="true" class="h-px flex-1 bg-[var(--border-weak,var(--border))]" />
          <span class="shrink-0">{dividerLabel()}</span>
          <span aria-hidden="true" class="h-px flex-1 bg-[var(--border-weak,var(--border))]" />
        </div>
      </Show>
      <MessageRow
        message={message()}
        providerName={props.providerName}
        cwd={props.cwd}
        onOpenFile={props.onOpenFile}
        isTerminal={props.isTerminalAssistant(message().id)}
        revertTurnCount={messageRow().revertTurnCount}
        onRevertFromMessage={props.onRevertFromMessage}
      />
    </>
  );
}

const WORK_KIND_GLYPH: Record<NonNullable<WorkLogEntry["kind"]>, string> = {
  tool: "·",
  "file-read": "·",
  "file-write": "·",
  terminal: "·",
  thinking: "·",
};

function WorkGroupRow(props: { entries: ReadonlyArray<WorkLogEntry> }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const split = createMemo(() => splitWorkEntries(props.entries));
  const visible = () => (expanded() ? props.entries : split().visible);
  const overflow = () => (expanded() ? 0 : split().overflowCount);

  return (
    <section
      data-testid="message-row"
      data-kind="work"
      class="group/work mb-3 rounded-md border border-[var(--border-weak,var(--border))] bg-[var(--bg-weak,var(--bg))] px-3 py-2"
    >
      <header class="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-[var(--fg-muted,var(--fg-secondary))]">
        <span aria-hidden="true">▾</span>
        <span data-testid="work-group-summary">
          Worked on {props.entries.length} step{props.entries.length === 1 ? "" : "s"}
        </span>
      </header>
      <ul class="mt-1.5 flex flex-col gap-0.5 text-[12px] leading-relaxed text-[var(--fg-secondary)]">
        <For each={visible()}>
          {(entry) => (
            <li
              data-testid="work-group-entry"
              data-entry-id={entry.id}
              data-entry-kind={entry.kind ?? ""}
              data-entry-status={entry.status ?? "completed"}
              class="flex items-center gap-2"
            >
              <span aria-hidden="true" class="shrink-0 text-[10px]">
                {entry.kind ? (WORK_KIND_GLYPH[entry.kind] ?? "•") : "•"}
              </span>
              <span class="min-w-0 truncate">{entry.label}</span>
            </li>
          )}
        </For>
        <Show when={overflow() > 0}>
          <li>
            <button
              type="button"
              data-testid="work-group-expand"
              class="cursor-pointer rounded-sm text-[11px] text-[var(--accent)] hover:underline"
              onClick={() => setExpanded(true)}
            >
              +{overflow()} more
            </button>
          </li>
        </Show>
      </ul>
    </section>
  );
}

function MessageRow(props: {
  message: ChatMessage;
  providerName: Accessor<string>;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  isTerminal: boolean;
  revertTurnCount?: number;
  onRevertFromMessage?: (userMessageId: string) => void;
}): JSX.Element {
  const tone = createMemo(() => deriveMessageTone(props.message));
  if (props.message.role === "user") {
    return (
      <UserRow
        message={props.message}
        tone={tone}
        cwd={props.cwd}
        onOpenFile={props.onOpenFile}
        revertTurnCount={props.revertTurnCount}
        onRevertFromMessage={props.onRevertFromMessage}
      />
    );
  }
  return (
    <AssistantRow
      message={props.message as Extract<ChatMessage, { role: "assistant" }>}
      tone={tone}
      providerName={props.providerName}
      cwd={props.cwd}
      onOpenFile={props.onOpenFile}
      isTerminal={props.isTerminal}
    />
  );
}

function UserRow(props: {
  message: Extract<ChatMessage, { role: "user" }>;
  tone: Accessor<"user" | "assistant" | "system" | "tool">;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  revertTurnCount?: number;
  onRevertFromMessage?: (userMessageId: string) => void;
}): JSX.Element {
  const plainText = createMemo(() => extractUserPlainText(props.message.content));
  const imageEntries = createMemo(() => collectImageBlocks(props.message.content));
  const onExpand = useImageExpand();
  const showRevert = (): boolean =>
    typeof props.revertTurnCount === "number" &&
    props.revertTurnCount > 0 &&
    typeof props.onRevertFromMessage === "function";
  const [revertConfirming, setRevertConfirming] = createSignal(false);
  return (
    <section
      data-testid="message-row"
      data-role="user"
      data-message-id={props.message.id}
      class="group/user mb-3 rounded-md bg-[var(--bg-weak,var(--bg))] px-3 py-2"
    >
      <MessageRoleHeader
        tone={props.tone()}
        name="You"
        timestamp={props.message.createdAt}
        actions={
          <span class="flex items-center gap-1.5">
            <Show when={showRevert()}>
              <Show
                when={revertConfirming()}
                fallback={
                  <button
                    type="button"
                    data-testid="message-revert-from-here"
                    data-revert-count={props.revertTurnCount ?? 0}
                    class="cursor-pointer rounded-sm border border-[var(--border-weak,var(--border))] px-1.5 py-0.5 text-[10px] text-[var(--fg-secondary)] opacity-0 transition-opacity hover:border-[var(--accent)] hover:text-[var(--accent)] group-hover/user:opacity-100"
                    onClick={() => setRevertConfirming(true)}
                    title={`Revert ${props.revertTurnCount} turn${props.revertTurnCount === 1 ? "" : "s"} from here`}
                  >
                    Revert {props.revertTurnCount} turn{props.revertTurnCount === 1 ? "" : "s"}
                  </button>
                }
              >
                <span
                  data-testid="message-revert-from-here-confirm"
                  class="inline-flex items-center gap-1 rounded-sm border border-[var(--red,#c33)] bg-[var(--red,#c33)]/10 px-1.5 py-0.5 text-[10px] text-[var(--red,#c33)]"
                  role="group"
                  aria-label={`Confirm revert of ${props.revertTurnCount} turn${props.revertTurnCount === 1 ? "" : "s"}`}
                >
                  <span>
                    Revert {props.revertTurnCount} turn{props.revertTurnCount === 1 ? "" : "s"}?
                  </span>
                  <button
                    type="button"
                    data-testid="message-revert-from-here-yes"
                    class="cursor-pointer rounded-sm border-0 bg-transparent px-1 text-[10px] font-semibold text-[var(--red,#c33)] hover:underline"
                    onClick={() => {
                      props.onRevertFromMessage?.(props.message.id);
                      setRevertConfirming(false);
                    }}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    data-testid="message-revert-from-here-no"
                    class="cursor-pointer rounded-sm border-0 bg-transparent px-1 text-[10px] text-[var(--fg-secondary)] hover:underline"
                    onClick={() => setRevertConfirming(false)}
                  >
                    No
                  </button>
                </span>
              </Show>
            </Show>
            <MessageCopyButton text={plainText()} class="opacity-0 group-hover/user:opacity-100" />
          </span>
        }
      />
      <div class="min-w-0 text-[13px] leading-relaxed text-[var(--fg)]">
        <For each={props.message.content}>
          {(block, index) => (
            <UserContentBlockView
              block={block}
              cwd={props.cwd}
              onOpenFile={props.onOpenFile}
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
      </div>
    </section>
  );
}

function AssistantRow(props: {
  message: Extract<ChatMessage, { role: "assistant" }>;
  tone: Accessor<"user" | "assistant" | "system" | "tool">;
  providerName: Accessor<string>;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  isTerminal: boolean;
}): JSX.Element {
  const renderedText = createMemo(() => renderMarkdown(props.message.text, { cwd: props.cwd?.() }));
  const hasText = () => props.message.text.length > 0;
  const hasThought = () =>
    Boolean(props.message.thoughtText && props.message.thoughtText.length > 0);
  const toolCalls = () => props.message.toolCalls;
  const hasTools = () => toolCalls().length > 0;
  const copyState = createMemo(() =>
    resolveAssistantCopyState({
      text: props.message.text,
      showCopyButton: props.isTerminal,
      streaming: props.message.streaming,
    }),
  );

  return (
    <section
      data-testid="message-row"
      data-role="assistant"
      data-message-id={props.message.id}
      data-streaming={props.message.streaming ? "true" : "false"}
      class="group/assistant mb-3 min-w-0 px-1 py-1"
    >
      <MessageRoleHeader
        tone={props.tone()}
        name={props.providerName()}
        timestamp={props.message.completedAt ?? props.message.createdAt}
        {...(props.message.stopReason ? { badge: props.message.stopReason } : {})}
        actions={
          <Show when={copyState().visible && copyState().text}>
            {(text) => (
              <MessageCopyButton
                text={text()}
                class="opacity-0 group-hover/assistant:opacity-100"
              />
            )}
          </Show>
        }
      />

      <Show when={hasText()}>
        <div class="min-w-0">
          <div
            class="chat-solid-markdown chat-markdown text-[13px] leading-relaxed text-[var(--fg)]"
            innerHTML={renderedText()}
            onClick={(event) => handleFileLinkClick(event, props.cwd?.(), props.onOpenFile)}
          />
          <Show when={props.message.streaming}>
            <span class="chat-solid-caret ml-1" />
          </Show>
        </div>
      </Show>

      <Show when={!hasText() && props.message.streaming && !hasThought() && !hasTools()}>
        <WorkingDots />
      </Show>

      <Show when={hasThought()}>
        <details
          data-testid="message-thought"
          class="mt-2 rounded-md border border-[var(--border)] bg-[var(--bg-weak)]"
        >
          <summary class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--fg-muted,var(--fg-secondary))]">
            <span aria-hidden="true">▸</span>
            <span>Thought</span>
          </summary>
          <div class="border-t border-[var(--border)] px-3 py-2 text-[12px] leading-relaxed text-[var(--fg-secondary)] whitespace-pre-wrap break-words">
            {props.message.thoughtText}
          </div>
        </details>
      </Show>

      <Show when={hasTools()}>
        <ToolCallsCluster toolCalls={toolCalls} />
      </Show>

      <Show when={!hasText() && !hasThought() && !hasTools() && !props.message.streaming}>
        <span data-testid="message-empty" class="text-[12px] text-[var(--fg-muted,var(--dim))]">
          No assistant output.
        </span>
      </Show>
    </section>
  );
}

/**
 * Collapsed-by-default cluster for tool calls under an assistant
 * message. The chip header shows the count + a status hint so the
 * user knows at a glance whether the turn touched tools and whether
 * any failed. Clicking expands the inline list (rendered through the
 * existing `ToolCallCard` component, unchanged).
 */
function ToolCallsCluster(props: {
  toolCalls: Accessor<ReadonlyArray<ToolCallView>>;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const summary = createMemo(() => summarizeToolCalls(props.toolCalls()));

  return (
    <div
      data-testid="tool-calls-cluster"
      data-open={open() ? "true" : "false"}
      class="mt-2 overflow-hidden rounded-md border border-[var(--border-weak,var(--border))] bg-[var(--bg-weak,var(--bg))]"
    >
      <button
        type="button"
        data-testid="tool-calls-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open()}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-[var(--fg-muted,var(--fg-secondary))] transition-colors hover:bg-[var(--surface-hover,var(--bg-strong))]"
      >
        <span
          aria-hidden="true"
          class="inline-block w-3 text-[10px] text-[var(--fg-muted,var(--dim))]"
        >
          {open() ? "▾" : "▸"}
        </span>
        <span class="font-medium text-[var(--fg)]">Tool calls ({summary().count})</span>
        <Show when={summary().hasFailure}>
          <span
            data-testid="tool-calls-failure-badge"
            class="ml-1 inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--red)_18%,transparent)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--red)]"
          >
            failed
          </span>
        </Show>
        <Show when={summary().hasInProgress && !summary().hasFailure}>
          <span
            data-testid="tool-calls-running-badge"
            class="ml-1 inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--accent)]"
          >
            running
          </span>
        </Show>
      </button>
      <Show when={open()}>
        <div
          data-testid="tool-calls-list"
          class="border-t border-[var(--border-weak,var(--border))] px-2 py-2"
        >
          <For each={props.toolCalls()}>{(toolCall) => <ToolCallCard toolCall={toolCall} />}</For>
        </div>
      </Show>
    </div>
  );
}

function WorkingDots(): JSX.Element {
  return (
    <div
      data-testid="message-working"
      class="flex items-center gap-1.5 pt-1 text-[11px] text-[var(--fg-muted,var(--dim))]"
    >
      <span class="h-1 w-1 rounded-full bg-[var(--fg-muted,var(--dim))] animate-pulse" />
      <span class="h-1 w-1 rounded-full bg-[var(--fg-muted,var(--dim))] animate-pulse [animation-delay:200ms]" />
      <span class="h-1 w-1 rounded-full bg-[var(--fg-muted,var(--dim))] animate-pulse [animation-delay:400ms]" />
    </div>
  );
}

function UserContentBlockView(props: {
  block: ContentBlock;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  /** Set by the parent `UserRow` for image blocks. Anchors the modal
   *  cursor at this block within the message's image siblings. */
  onExpandImage?: () => void;
}): JSX.Element {
  if (props.block.type === "image") {
    const block = props.block;
    const src = createMemo(() => {
      if (typeof block.data !== "string" || block.data.length === 0) return "";
      const mime = block.mimeType || "image/png";
      return `data:${mime};base64,${block.data}`;
    });
    return (
      <Show
        when={src().length > 0}
        fallback={
          <p
            data-testid="user-image-block-missing"
            class="text-[12px] text-[var(--fg-muted,var(--dim))]"
          >
            (image attachment unavailable)
          </p>
        }
      >
        <div data-testid="user-image-block" class="my-1.5 inline-block max-w-[400px]">
          <InlineImagePreview
            src={src}
            alt={() => `image (${block.mimeType || "image"})`}
            onExpand={props.onExpandImage}
          />
        </div>
      </Show>
    );
  }
  if (props.block.type !== "text") return <ContentBlockView block={props.block} />;
  const block = props.block;
  const renderedText = createMemo(() => renderMarkdown(block.text, { cwd: props.cwd?.() }));
  return (
    <div
      class="chat-solid-markdown chat-markdown text-[13px] leading-relaxed text-[var(--fg)]"
      innerHTML={renderedText()}
      onClick={(event) => handleFileLinkClick(event, props.cwd?.(), props.onOpenFile)}
    />
  );
}

function extractUserPlainText(content: ReadonlyArray<ContentBlock>): string {
  return content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Click-delegation handler for the rendered markdown surface.
 * Mirrors the previous bubble version verbatim — the file-link
 * affordance is unchanged, just hosted on the flat row.
 */
function handleFileLinkClick(
  event: MouseEvent,
  cwd: string | undefined,
  onOpenFile: ((meta: MarkdownFileLinkMeta) => void) | undefined,
) {
  if (!onOpenFile) return;
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const anchor = target.closest<HTMLAnchorElement>("a.chat-file-link");
  if (!anchor) return;
  event.preventDefault();
  const filePath = anchor.dataset.filePath ?? anchor.getAttribute("href") ?? "";
  const lineRaw = anchor.dataset.fileLine;
  const colRaw = anchor.dataset.fileColumn;
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : Number.NaN;
  const column = colRaw ? Number.parseInt(colRaw, 10) : Number.NaN;
  const meta =
    resolveMarkdownFileLinkMeta(anchor.getAttribute("href") ?? undefined, cwd) ??
    ({
      filePath,
      targetPath: filePath,
      displayPath: filePath,
      basename: filePath.slice(filePath.lastIndexOf("/") + 1),
      ...(Number.isFinite(line) ? { line } : {}),
      ...(Number.isFinite(column) ? { column } : {}),
    } as MarkdownFileLinkMeta);
  onOpenFile(meta);
}
