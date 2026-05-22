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

import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  Show,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { deriveChangedFilesFromToolCalls } from "../lib/changedFiles";
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
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
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
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { parseTerminalContextResource } from "../lib/userMessageTerminalContexts";
import { WorkingIndicator } from "./WorkingIndicator";

/** Host-injected async HTML upgrader (syntax highlighting). */
const HighlightContext = createContext<Accessor<((html: string) => Promise<string>) | undefined>>(
  () => undefined,
);

/**
 * Renders sanitized markdown HTML, then — if the host injected a
 * highlighter — swaps in the syntax-highlighted upgrade once the
 * async pass resolves. The synchronous HTML is shown first so there
 * is no flash of empty content and tests that assert on render don't
 * have to await a microtask. The effect re-runs on `html` change so
 * streaming chunks re-highlight.
 */
function MarkdownBody(props: {
  html: string;
  class: string;
  onClick?: (event: MouseEvent) => void;
}): JSX.Element {
  const highlighter = useContext(HighlightContext);
  const [enhanced, setEnhanced] = createSignal<string | null>(null);
  createEffect(
    on(
      () => props.html,
      (html) => {
        const fn = highlighter();
        if (!fn) {
          setEnhanced(null);
          return;
        }
        let stale = false;
        void fn(html)
          .then((next) => {
            if (!stale) setEnhanced(next);
          })
          .catch(() => {
            if (!stale) setEnhanced(null);
          });
        return () => {
          stale = true;
        };
      },
    ),
  );
  return (
    <div
      class={props.class}
      innerHTML={enhanced() ?? props.html}
      onClick={(event) => props.onClick?.(event)}
    />
  );
}

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
   * Optional async upgrade for rendered message HTML (syntax
   * highlighting). Injected by the host; threaded to every markdown
   * body via context so we don't prop-drill through five layers.
   */
  highlightMarkdown?: (html: string) => Promise<string>;
  /**
   * Fired when the user clicks the "Revert from here" button on a
   * user message annotated with `revertTurnCount`. Host owns the
   * actual rewind dispatch — chat-solid only surfaces the affordance.
   */
  onRevertFromMessage?: (userMessageId: string) => void;
  /**
   * Fired when the user saves an in-place edit of a prior user
   * message. Distinct from revert: the host truncates from that turn
   * AND regenerates with the new content (chat.session.editFromTurn).
   * Host owns the dispatch — chat-solid only surfaces the editor.
   */
  onEditMessage?: (userMessageId: string, content: ContentBlock[]) => void;
}) {
  const [container, setContainer] = createSignal<HTMLElement>();
  const [sentinel, setSentinel] = createSignal<HTMLElement>();
  const [expandedPreview, setExpandedPreview] = createSignal<ExpandedImagePreview | null>(null);
  // Autoscroll follow-signal. The streaming row is always the tail,
  // so subscribe to row count + the last row's growing length only —
  // not a signature mapped over every row. With the persistent
  // rowStore this re-fires O(1) per token (the streaming row's
  // `.text` length) instead of rebuilding an N-row signature string
  // each chunk.
  const followSignal = createMemo(() => {
    const rs = props.rows();
    const last = rs[rs.length - 1];
    if (!last) return `${rs.length}`;
    if (last.kind === "message") {
      const m = last.message;
      if (m.role === "assistant") {
        return `${rs.length}:a:${m.text.length}:${m.thoughtText?.length ?? 0}:${m.toolCalls.length}:${m.streaming}`;
      }
      return `${rs.length}:u:${m.content.length}`;
    }
    if (last.kind === "working") return `${rs.length}:w`;
    if (last.kind === "plan") return `${rs.length}:p:${last.entries.length}`;
    return `${rs.length}:work:${last.entries.length}`;
  });
  const terminalAssistantIds = createMemo(() => deriveTerminalAssistantMessageIds(props.rows()));
  useAutoScroll(container, sentinel, followSignal);

  // Virtualization removed for chat threads. The previous wiring
  // around `@tanstack/solid-virtual` rendered a correctly-sized
  // spacer but the For-loop body never iterated — getVirtualItems()
  // returned `[]` perpetually once the dist was rebuilt, leaving
  // the timeline empty in the browser. Typical chat threads run a
  // few dozen messages, so a plain For-each is the safer default
  // until we revisit virtualization with a chat-specific harness.

  // Single dialog mount hoisted to the timeline so user / assistant
  // / tool-call image clicks all open the same overlay. Closing seeds
  // `null` back into the signal so `<ExpandedImageDialog>` unmounts.
  const onExpand: ImageExpandHandler = (preview) => setExpandedPreview(preview);

  return (
    <HighlightContext.Provider value={() => props.highlightMarkdown}>
      <ImageExpandContext.Provider value={onExpand}>
        <Show
          when={props.rows().length > 0}
          fallback={
            <div
              data-testid="messages-timeline-empty"
              class="flex min-h-0 flex-1 items-center justify-center text-md text-[var(--fg-muted,var(--dim))]"
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
            <div data-testid="messages-timeline-spacer">
              <Index each={props.rows()}>
                {(rowAccessor, index) => {
                  // `Index` keys by position so the outer <div> stays
                  // mounted across rows() updates — token streams
                  // replace the underlying array but the slot's DOM
                  // node is preserved. The inner per-row memo dampens
                  // re-derivation: when a sibling row streams and the
                  // current row's signature is unchanged, the memo
                  // returns the previous row reference and TimelineRow
                  // skips work.
                  const row = createMemo<MessagesTimelineRow>(() => rowAccessor(), rowAccessor(), {
                    equals: (a, b) => rowSignature(a) === rowSignature(b),
                  });
                  return (
                    <div data-index={index}>
                      <div class="mx-auto flex w-full max-w-3xl flex-col px-4">
                        <TimelineRow
                          row={row()}
                          providerName={props.providerName}
                          cwd={props.cwd}
                          onOpenFile={props.onOpenFile}
                          onSendPlanRequest={props.onSendPlanRequest}
                          onRevertFromMessage={props.onRevertFromMessage}
                          onEditMessage={props.onEditMessage}
                          isTerminalAssistant={(id) => terminalAssistantIds().has(id)}
                        />
                      </div>
                    </div>
                  );
                }}
              </Index>
            </div>
            <div ref={setSentinel} />
          </div>
        </Show>
        <ExpandedImageDialog preview={expandedPreview} onClose={() => setExpandedPreview(null)} />
      </ImageExpandContext.Provider>
    </HighlightContext.Provider>
  );
}

interface TimelineRowProps {
  row: MessagesTimelineRow;
  providerName: Accessor<string>;
  cwd?: Accessor<string | undefined>;
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  onSendPlanRequest?: (markdown: string) => void;
  onRevertFromMessage?: (userMessageId: string) => void;
  onEditMessage?: (userMessageId: string, content: ContentBlock[]) => void;
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
  // Summary fragments shown after "Response •" in the divider pill:
  // turn duration, tool-call count, and a non-"end_turn" stop reason.
  // Mirrors upstream's "Response • {summary}" anchor between phases.
  const dividerSummary = (): string => {
    const m = message();
    if (m.role !== "assistant") return "";
    const parts: string[] = [];
    const start = messageRow().completionTurnStartedAt;
    const end = m.completedAt ?? messageRow().createdAt;
    const duration = start ? formatTurnDuration(start, end) : null;
    if (duration) parts.push(duration);
    const toolCount = m.toolCalls.length;
    if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
    if (m.stopReason && m.stopReason !== "end_turn") {
      parts.push(m.stopReason.replace(/_/g, " "));
    }
    return parts.join(" · ");
  };
  const dividerLabel = (): string => {
    const summary = dividerSummary();
    return summary ? `Response • ${summary}` : "Response";
  };
  return (
    <>
      <Show when={showDivider()}>
        <div
          data-testid="message-completion-divider"
          data-turn-started-at={messageRow().completionTurnStartedAt ?? ""}
          class="my-3 flex items-center gap-3"
          aria-label={dividerLabel()}
        >
          <span aria-hidden="true" class="h-px flex-1 bg-[var(--border-weak,var(--border))]" />
          <span class="shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-xs uppercase tracking-[0.14em] text-[var(--fg-muted,var(--dim))]">
            {dividerLabel()}
          </span>
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
        onEditMessage={props.onEditMessage}
      />
    </>
  );
}

// Per-kind glyph for a work entry. Mirrors upstream's icon intent
// (terminal vs file-read vs file-change vs thinking vs generic tool)
// without pulling an icon dependency into chat-solid — the transcript
// stays text-quiet, a single mono glyph is enough signal.
const WORK_KIND_GLYPH: Record<NonNullable<WorkLogEntry["kind"]>, string> = {
  tool: "⚒",
  "file-read": "👁",
  "file-write": "✎",
  terminal: "❯",
  thinking: "✻",
};

// Per-status badge. `completed` is the quiet default and renders no
// badge so finished work doesn't add noise; only in-flight / failed
// entries surface a chip.
const WORK_STATUS_BADGE: Record<
  NonNullable<WorkLogEntry["status"]>,
  { label: string; class: string } | null
> = {
  completed: null,
  in_progress: {
    label: "running",
    class: "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--accent)]",
  },
  failed: {
    label: "failed",
    class: "bg-[color-mix(in_oklab,var(--red)_18%,transparent)] text-[var(--red)]",
  },
};

function WorkGroupRow(props: { entries: ReadonlyArray<WorkLogEntry> }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const split = createMemo(() => splitWorkEntries(props.entries));
  const visible = () => (expanded() ? props.entries : split().visible);
  const overflow = () => (expanded() ? 0 : split().overflowCount);
  const failureCount = createMemo(() => props.entries.filter((e) => e.status === "failed").length);
  const runningCount = createMemo(
    () => props.entries.filter((e) => e.status === "in_progress").length,
  );

  return (
    <section
      data-testid="message-row"
      data-kind="work"
      class="group/work mb-3 rounded-md border border-[var(--border-weak,var(--border))] bg-[var(--bg-weak,var(--bg))] px-3 py-2"
    >
      <header class="flex items-center gap-2 text-sm uppercase tracking-[0.08em] text-[var(--fg-muted,var(--fg-secondary))]">
        <span aria-hidden="true">▾</span>
        <span data-testid="work-group-summary">
          Worked on {props.entries.length} step{props.entries.length === 1 ? "" : "s"}
        </span>
        <Show when={runningCount() > 0}>
          <span
            data-testid="work-group-running-badge"
            class="ml-1 inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] px-1.5 py-0.5 text-[9px] tracking-[0.08em] text-[var(--accent)]"
          >
            {runningCount()} running
          </span>
        </Show>
        <Show when={failureCount() > 0}>
          <span
            data-testid="work-group-failure-badge"
            class="ml-1 inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--red)_18%,transparent)] px-1.5 py-0.5 text-[9px] tracking-[0.08em] text-[var(--red)]"
          >
            {failureCount()} failed
          </span>
        </Show>
      </header>
      <ul class="mt-1.5 flex flex-col gap-0.5 text-base leading-relaxed text-[var(--fg-secondary)]">
        <For each={visible()}>
          {(entry) => {
            const badge = () => (entry.status ? WORK_STATUS_BADGE[entry.status] : null);
            return (
              <li
                data-testid="work-group-entry"
                data-entry-id={entry.id}
                data-entry-kind={entry.kind ?? ""}
                data-entry-status={entry.status ?? "completed"}
                class="flex items-center gap-2"
                classList={{ "text-[var(--red)]": entry.status === "failed" }}
              >
                <span
                  aria-hidden="true"
                  class="w-3.5 shrink-0 text-center text-xs"
                  classList={{
                    "text-[var(--accent)]": entry.status === "in_progress",
                  }}
                >
                  {entry.kind ? (WORK_KIND_GLYPH[entry.kind] ?? "•") : "•"}
                </span>
                <span class="min-w-0 truncate">{entry.label}</span>
                <Show when={badge()}>
                  {(b) => (
                    <span
                      data-testid="work-group-entry-status"
                      class={`ml-auto inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] ${b().class}`}
                    >
                      {b().label}
                    </span>
                  )}
                </Show>
              </li>
            );
          }}
        </For>
        <Show when={overflow() > 0}>
          <li>
            <button
              type="button"
              data-testid="work-group-expand"
              class="cursor-pointer rounded-sm text-sm text-[var(--accent)] hover:underline"
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
  onEditMessage?: (userMessageId: string, content: ContentBlock[]) => void;
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
        onEditMessage={props.onEditMessage}
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
  onEditMessage?: (userMessageId: string, content: ContentBlock[]) => void;
}): JSX.Element {
  const plainText = createMemo(() => extractUserPlainText(props.message.content));
  const imageEntries = createMemo(() => collectImageBlocks(props.message.content));
  const onExpand = useImageExpand();
  const showRevert = (): boolean =>
    typeof props.revertTurnCount === "number" &&
    props.revertTurnCount > 0 &&
    typeof props.onRevertFromMessage === "function";
  const [revertConfirming, setRevertConfirming] = createSignal(false);
  // Edit is text-only by design: editFromTurn replaces the turn with
  // a single text block, so we only offer it on purely-text messages
  // — silently dropping image/resource blocks on save would surprise.
  const isTextOnly = createMemo(() => props.message.content.every((b) => b.type === "text"));
  const canEdit = (): boolean =>
    typeof props.onEditMessage === "function" && isTextOnly() && plainText().trim().length > 0;
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  function beginEdit(): void {
    setDraft(plainText());
    setEditing(true);
  }
  function commitEdit(): void {
    const text = draft().trim();
    setEditing(false);
    if (text.length === 0 || text === plainText().trim()) return;
    props.onEditMessage?.(props.message.id, [{ type: "text", text }]);
  }
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
                    class="cursor-pointer rounded-sm border border-[var(--border-weak,var(--border))] px-1.5 py-0.5 text-xs text-[var(--fg-secondary)] opacity-0 transition-opacity hover:border-[var(--accent)] hover:text-[var(--accent)] group-hover/user:opacity-100"
                    onClick={() => setRevertConfirming(true)}
                    title={`Revert ${props.revertTurnCount} turn${props.revertTurnCount === 1 ? "" : "s"} from here`}
                  >
                    Revert {props.revertTurnCount} turn{props.revertTurnCount === 1 ? "" : "s"}
                  </button>
                }
              >
                <span
                  data-testid="message-revert-from-here-confirm"
                  class="inline-flex items-center gap-1 rounded-sm border border-[var(--red,#c33)] bg-[var(--red,#c33)]/10 px-1.5 py-0.5 text-xs text-[var(--red,#c33)]"
                  role="group"
                  aria-label={`Confirm revert of ${props.revertTurnCount} turn${props.revertTurnCount === 1 ? "" : "s"}`}
                >
                  <span>
                    Revert {props.revertTurnCount} turn{props.revertTurnCount === 1 ? "" : "s"}?
                  </span>
                  <button
                    type="button"
                    data-testid="message-revert-from-here-yes"
                    class="cursor-pointer rounded-sm border-0 bg-transparent px-1 text-xs font-semibold text-[var(--red,#c33)] hover:underline"
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
                    class="cursor-pointer rounded-sm border-0 bg-transparent px-1 text-xs text-[var(--fg-secondary)] hover:underline"
                    onClick={() => setRevertConfirming(false)}
                  >
                    No
                  </button>
                </span>
              </Show>
            </Show>
            <Show when={canEdit() && !editing()}>
              <button
                type="button"
                data-testid="message-edit"
                class="cursor-pointer rounded-sm border border-[var(--border-weak,var(--border))] px-1.5 py-0.5 text-xs text-[var(--fg-secondary)] opacity-0 transition-opacity hover:border-[var(--accent)] hover:text-[var(--accent)] group-hover/user:opacity-100"
                onClick={beginEdit}
                title="Edit this message and regenerate"
              >
                Edit
              </button>
            </Show>
            <MessageCopyButton text={plainText()} class="opacity-0 group-hover/user:opacity-100" />
          </span>
        }
      />
      <Show
        when={editing()}
        fallback={
          <div class="min-w-0 text-md leading-relaxed text-[var(--fg)]">
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
        }
      >
        <div data-testid="message-edit-form" class="min-w-0">
          <textarea
            data-testid="message-edit-input"
            class="w-full resize-y rounded-sm border border-[var(--accent)] bg-[var(--bg)] px-2 py-1.5 text-md leading-relaxed text-[var(--fg)] outline-none"
            rows={Math.min(12, Math.max(2, draft().split("\n").length))}
            value={draft()}
            autofocus
            onInput={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commitEdit();
              }
            }}
          />
          <div class="mt-1.5 flex items-center justify-end gap-1.5">
            <span class="mr-auto text-xs text-[var(--dim)]">⌘↵ to save · Esc to cancel</span>
            <button
              type="button"
              data-testid="message-edit-cancel"
              class="cursor-pointer rounded-sm border border-[var(--border-weak,var(--border))] px-2 py-0.5 text-xs text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="message-edit-save"
              class="cursor-pointer rounded-sm bg-[var(--accent)] px-2 py-0.5 text-xs text-[var(--bg)] transition-opacity hover:opacity-90"
              onClick={commitEdit}
            >
              Save &amp; regenerate
            </button>
          </div>
        </div>
      </Show>
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
  // Per-turn changed files, scoped to THIS assistant message's own
  // tool calls (gap 11). Only surfaced on the terminal message of a
  // turn so a multi-chunk turn shows the section once, at the end.
  const turnChangedFiles = createMemo(() =>
    props.isTerminal
      ? deriveChangedFilesFromToolCalls(
          props.message.toolCalls,
          props.message.completedAt ?? props.message.createdAt,
        )
      : [],
  );
  const turnDiffStat = createMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of turnChangedFiles()) {
      additions += f.totalAdditions;
      deletions += f.totalDeletions;
    }
    return { additions, deletions };
  });
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
          <MarkdownBody
            class="chat-solid-markdown chat-markdown text-md leading-relaxed text-[var(--fg)]"
            html={renderedText()}
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
          <summary class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm uppercase tracking-[0.08em] text-[var(--fg-muted,var(--fg-secondary))]">
            <span aria-hidden="true">▸</span>
            <span>Thought</span>
          </summary>
          <div class="border-t border-[var(--border)] px-3 py-2 text-base leading-relaxed text-[var(--fg-secondary)] whitespace-pre-wrap break-words">
            {props.message.thoughtText}
          </div>
        </details>
      </Show>

      <Show when={hasTools()}>
        <ToolCallsCluster toolCalls={toolCalls} />
      </Show>

      <Show when={turnChangedFiles().length > 0}>
        <section
          data-testid="assistant-changed-files"
          class="mt-2 rounded-md border border-[var(--border-weak,var(--border))] bg-[var(--bg-weak,var(--bg))] p-2.5"
        >
          <header class="mb-1.5 flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-[var(--fg-muted,var(--fg-secondary))]">
            <span>Changed files ({turnChangedFiles().length})</span>
            <Show when={hasNonZeroStat(turnDiffStat())}>
              <span aria-hidden="true">·</span>
              <DiffStatLabel
                additions={turnDiffStat().additions}
                deletions={turnDiffStat().deletions}
              />
            </Show>
          </header>
          <ChangedFilesTree files={turnChangedFiles} />
        </section>
      </Show>

      <Show when={!hasText() && !hasThought() && !hasTools() && !props.message.streaming}>
        <span data-testid="message-empty" class="text-base text-[var(--fg-muted,var(--dim))]">
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
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--fg-muted,var(--fg-secondary))] transition-colors hover:bg-[var(--surface-hover,var(--bg-strong))]"
      >
        <span aria-hidden="true" class="inline-block w-3 text-xs text-[var(--fg-muted,var(--dim))]">
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
      class="flex items-center gap-1.5 pt-1 text-sm text-[var(--fg-muted,var(--dim))]"
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
            class="text-base text-[var(--fg-muted,var(--dim))]"
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
  const terminalContext = parseTerminalContextResource(props.block);
  if (terminalContext) {
    return (
      <span class="my-0.5 inline-flex align-middle">
        <TerminalContextInlineChip
          label={terminalContext.label}
          tooltipText={terminalContext.tooltipText}
          expired={terminalContext.expired}
        />
      </span>
    );
  }
  if (props.block.type !== "text") return <ContentBlockView block={props.block} />;
  const block = props.block;
  const renderedText = createMemo(() => renderMarkdown(block.text, { cwd: props.cwd?.() }));
  return (
    <MarkdownBody
      class="chat-solid-markdown chat-markdown text-md leading-relaxed text-[var(--fg)]"
      html={renderedText()}
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
