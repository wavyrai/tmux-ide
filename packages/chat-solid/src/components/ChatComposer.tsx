import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  untrack,
  type Accessor,
} from "solid-js";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import {
  buildImageAttachments,
  dragHasFiles,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
} from "../lib/composerImageAttach";
import { searchSlashCommands } from "../lib/slashCommandSearch";
import { detectSlashContext } from "../lib/slashCursor";
import { detectMentionContext } from "../lib/mentionCursor";
import {
  searchMentions,
  type MentionCandidate,
  type MentionSearchResult,
} from "../lib/mentionSearch";
import {
  clearDraft,
  loadDraft,
  loadDraftAttachments,
  saveDraft,
  subscribeDraft,
} from "../lib/composerDraftStore";
import type {
  AvailableCommand,
  ComposerAttachment,
  ComposerTerminalPane,
  ContentBlock,
} from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentCarousel } from "./AttachmentCarousel";
import { AttachmentPicker } from "./AttachmentPicker";
import { ComposerBannerStack, type ComposerBannerItem } from "./ComposerBannerStack";
import { ComposerPrimaryActions, type PendingActionState } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel, type PendingApproval } from "./ComposerPendingApprovalPanel";
import {
  ComposerPendingApprovalActions,
  type ProviderApprovalDecision,
} from "./ComposerPendingApprovalActions";
import {
  ComposerPendingUserInputPanel,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "./ComposerPendingUserInputPanel";
import { ComposerPendingTerminalContexts } from "./ComposerPendingTerminalContexts";
import {
  CompactComposerControlsMenu,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "./CompactComposerControlsMenu";
import { ComposerFooterStrip } from "./ComposerFooterStrip";
import type { TerminalContextDraft } from "../lib/terminalContext";
import type { JSX } from "solid-js";

export function ChatComposer(props: {
  disabled: Accessor<boolean>;
  availableCommands: Accessor<AvailableCommand[]>;
  providerName: Accessor<string>;
  sessionName: Accessor<string | null>;
  projectDir: Accessor<string | undefined>;
  attachments: Accessor<ComposerAttachment[]>;
  terminalPanes: Accessor<ComposerTerminalPane[]>;
  prefillPromptText?: Accessor<string | null>;
  /**
   * Identity for per-thread draft persistence. When provided, the
   * composer restores any saved prompt on mount / thread switch and
   * writes keystrokes back to localStorage (debounced). Null disables
   * persistence (e.g. pre-thread draft sessions handled by the host).
   */
  threadId?: Accessor<string | null>;
  /**
   * Candidate set for the @-mention autocomplete. Host owns sourcing:
   * project files, sibling threads, agents. Empty / undefined disables
   * the menu (the `@` token still types through plainly).
   */
  mentionCandidates?: Accessor<ReadonlyArray<MentionCandidate>>;
  onPrefillPromptConsumed?: () => void;
  onAddAttachment(attachment: ComposerAttachment): void;
  onRemoveAttachment(index: number): void;
  /**
   * Fired when a paste / drop image attachment is rejected (wrong
   * type, over the per-file size cap, or past the per-message
   * count). The composer also shows the message inline above the
   * textarea, but hosts can surface a toast too. Optional.
   */
  onAttachmentError?(message: string): void;
  /**
   * Optional reorder callback wired to the `AttachmentCarousel`
   * arrow buttons. Receives the source + destination indices; the
   * host applies the move to its underlying list. When omitted,
   * the carousel hides the reorder affordance entirely.
   */
  onReorderAttachment?: (fromIndex: number, toIndex: number) => void;
  onSend(content: ContentBlock[]): Promise<void>;
  onCancel(): Promise<void> | void;
  /**
   * Optional banner surfaces rendered between the timeline and the
   * textarea. Host composes the array from approval / plan-follow-up
   * / pending-user-input state and any project-specific banners.
   * When omitted (or empty), no banner row renders.
   */
  bannerItems?: Accessor<ReadonlyArray<ComposerBannerItem>>;
  /**
   * Optional pending tool-call approval. When set, the composer
   * renders `ComposerPendingApprovalPanel` (summary headline) and
   * `ComposerPendingApprovalActions` (cancel / decline / always
   * allow this session / approve once) between the banner stack
   * and the textarea. Null / undefined keeps both surfaces hidden.
   *
   * Host owns sourcing — typically derived from the daemon's
   * `chat.permission.request` event mapped to a coarse
   * `requestKind` (command / file-read / file-change).
   */
  pendingApproval?: Accessor<PendingApproval | null>;
  /**
   * Optional badge value rendered as "1/N" alongside the approval
   * headline when multiple approvals are queued. Defaults to 1.
   */
  pendingApprovalCount?: Accessor<number>;
  /**
   * Verdict callback wired to the four-button row. Receives the
   * request id and the chosen decision. Required when
   * `pendingApproval` is set — without it the buttons would be
   * inert.
   */
  onRespondToApproval?: (
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Promise<void> | void;
  /**
   * Drives the in-flight gate on the verdict row. When true, all
   * four approval buttons render disabled. Optional — defaults to
   * `disabled()` so a sending composer also locks the verdict row.
   */
  isRespondingToApproval?: Accessor<boolean>;
  /**
   * Optional richer state for `ComposerPrimaryActions`. When
   * omitted, the primary actions surface defaults to a plain
   * send/stop button mapped to `disabled()`.
   */
  pendingAction?: Accessor<PendingActionState | null>;
  showPlanFollowUpPrompt?: Accessor<boolean>;
  isSendBusy?: Accessor<boolean>;
  isConnecting?: Accessor<boolean>;
  isEnvironmentUnavailable?: Accessor<boolean>;
  isPreparingWorktree?: Accessor<boolean>;
  compactPrimaryActions?: Accessor<boolean>;
  onPreviousPendingQuestion?: () => void;
  onImplementPlanInNewThread?: () => void;
  /**
   * Optional multi-choice pending prompt(s) ("agent asks: pick one").
   * When set, `ComposerPendingUserInputPanel` mounts above the
   * textarea and surfaces option buttons with 1-9 keyboard
   * shortcuts. The host owns answer persistence / advance.
   */
  pendingUserInputs?: Accessor<ReadonlyArray<PendingUserInput>>;
  pendingUserInputAnswers?: Accessor<Record<string, PendingUserInputDraftAnswer>>;
  pendingUserInputRespondingIds?: Accessor<ReadonlyArray<string>>;
  pendingUserInputQuestionIndex?: Accessor<number>;
  onPendingUserInputToggleOption?: (questionId: string, optionLabel: string) => void;
  onPendingUserInputAdvance?: () => void;
  /**
   * Optional terminal-context drafts staged on the current thread.
   * Renders as a chip strip immediately above the attachment row;
   * each chip surfaces its terminal label + line range and tags
   * expired contexts (no body text) with the destructive variant.
   */
  pendingTerminalContexts?: Accessor<ReadonlyArray<TerminalContextDraft>>;
  onRemoveTerminalContext?: (id: string) => void;
  /**
   * Optional compact-controls menu state. When set, a "⋯" trigger
   * renders next to the primary actions and opens a popover with
   * mode / runtime / plan-sidebar entries.
   */
  showCompactControls?: Accessor<boolean>;
  /**
   * Opt into the responsive footer: when the form is wide enough,
   * render the inline `ComposerFooterStrip`; otherwise collapse to
   * the `CompactComposerControlsMenu` popover. Defaults to the
   * single-popover behavior when omitted — back-compat for hosts
   * that wired `showCompactControls` explicitly.
   *
   * The compactness threshold defaults to 560px (form's measured
   * width). Hosts can pin the chrome via `showCompactControls`,
   * which always wins regardless of width.
   */
  useResponsiveFooter?: Accessor<boolean>;
  interactionMode?: Accessor<ProviderInteractionMode>;
  runtimeMode?: Accessor<RuntimeMode>;
  activePlan?: Accessor<boolean>;
  planSidebarLabel?: Accessor<string>;
  planSidebarOpen?: Accessor<boolean>;
  showInteractionModeToggle?: Accessor<boolean>;
  traitsMenuContent?: Accessor<JSX.Element | null>;
  onToggleInteractionMode?: () => void;
  onTogglePlanSidebar?: () => void;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
}) {
  const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
  const [value, setValue] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [hiddenSlash, setHiddenSlash] = createSignal<{
    slashIndex: number;
    query: string;
  } | null>(null);
  const [hiddenMention, setHiddenMention] = createSignal<{
    atIndex: number;
    query: string;
  } | null>(null);
  const [commandHighlight, setCommandHighlight] = createSignal(0);
  const [mentionHighlight, setMentionHighlight] = createSignal(0);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  // Paste / drop image-attachment state. `dragDepth` mirrors the
  // upstream ref trick — dragenter/leave fire per descendant, so a
  // plain boolean flickers; counting depth keeps the overlay stable
  // until the cursor truly leaves the composer surface.
  const [dragOver, setDragOver] = createSignal(false);
  const [attachError, setAttachError] = createSignal<string | null>(null);
  let dragDepth = 0;
  let attachErrorTimer: ReturnType<typeof setTimeout> | null = null;

  function raiseAttachError(message: string | null): void {
    if (attachErrorTimer) {
      clearTimeout(attachErrorTimer);
      attachErrorTimer = null;
    }
    setAttachError(message);
    if (message) {
      props.onAttachmentError?.(message);
      // Auto-dismiss the inline line so it doesn't linger forever.
      attachErrorTimer = setTimeout(() => {
        attachErrorTimer = null;
        setAttachError(null);
      }, 6000);
    }
  }

  async function ingestImageFiles(files: ReadonlyArray<File>): Promise<void> {
    if (files.length === 0) return;
    const { attachments, error } = await buildImageAttachments(files, props.attachments().length);
    for (const attachment of attachments) {
      props.onAddAttachment(attachment);
    }
    raiseAttachError(error);
  }

  function handleComposerPaste(event: ClipboardEvent): void {
    if (props.disabled()) return;
    const images = imageFilesFromClipboard(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    void ingestImageFiles(images);
  }

  function handleComposerDragEnter(event: DragEvent): void {
    if (props.disabled() || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    setDragOver(true);
  }

  function handleComposerDragOver(event: DragEvent): void {
    if (props.disabled() || !dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleComposerDragLeave(event: DragEvent): void {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(next)
    ) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragOver(false);
  }

  function handleComposerDrop(event: DragEvent): void {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragOver(false);
    if (props.disabled()) return;
    const images = imageFilesFromDataTransfer(event.dataTransfer);
    if (images.length === 0) {
      raiseAttachError("Only image files can be dropped here.");
      return;
    }
    void ingestImageFiles(images);
    textarea()?.focus();
  }

  onCleanup(() => {
    if (attachErrorTimer) clearTimeout(attachErrorTimer);
  });
  const slashContext = createMemo(() => detectSlashContext(value(), caret()));
  const commandQuery = createMemo(() => {
    const context = slashContext();
    return context.active ? context.query : "";
  });
  const searchResults = createMemo(() =>
    searchSlashCommands(props.availableCommands(), commandQuery()),
  );
  const showCommands = createMemo(() => {
    const context = slashContext();
    if (!context.active || props.availableCommands().length === 0) return false;
    const hidden = hiddenSlash();
    return hidden?.slashIndex !== context.slashIndex || hidden.query !== context.query;
  });

  const mentionContext = createMemo(() => detectMentionContext(value(), caret()));
  const mentionQuery = createMemo(() => {
    const context = mentionContext();
    return context.active ? context.query : "";
  });
  const mentionResults = createMemo<MentionSearchResult[]>(() =>
    props.mentionCandidates ? searchMentions(props.mentionCandidates(), mentionQuery()) : [],
  );
  const showMentions = createMemo(() => {
    if (showCommands()) return false;
    const context = mentionContext();
    if (!context.active) return false;
    if (!props.mentionCandidates || props.mentionCandidates().length === 0) return false;
    const hidden = hiddenMention();
    return hidden?.atIndex !== context.atIndex || hidden.query !== context.query;
  });
  const hasContent = () => value().trim().length > 0 || props.attachments().length > 0;
  const canSend = () => hasContent() && !props.disabled();

  createEffect(() => {
    commandQuery();
    props.availableCommands();
    setCommandHighlight(0);
  });

  createEffect(() => {
    mentionQuery();
    if (props.mentionCandidates) props.mentionCandidates();
    setMentionHighlight(0);
  });

  // Per-thread draft persistence: restore on thread switch, clear
  // local state when threadId goes null. Skips during prefill
  // (handled below). When a draft has persisted file / terminal
  // attachments, re-stage them via the host's `onAddAttachment` hook
  // so the chip strip rebuilds across reloads. Image attachments
  // are intentionally skipped (data URLs too heavy for localStorage).
  createEffect(
    on(
      () => props.threadId?.() ?? null,
      (id) => {
        if (!id) {
          setValue("");
          setCaret(0);
          setHiddenSlash(null);
          setHiddenMention(null);
          return;
        }
        // Restore must fire ONLY on thread-identity change. Reading
        // the draft / attachment list untracked keeps a debounced
        // save, an attachment edit, or a cross-tab store tick from
        // re-running this and re-applying a stale draft over what the
        // user is currently typing.
        untrack(() => {
          const draft = loadDraft(id);
          setValue(draft);
          setHiddenSlash(null);
          setHiddenMention(null);
          setTextareaCaret(draft.length);
          const persistedAttachments = loadDraftAttachments(id);
          if (persistedAttachments.length > 0 && props.attachments().length === 0) {
            for (const attachment of persistedAttachments) {
              props.onAddAttachment(attachment);
            }
          }
        });
      },
    ),
  );

  // The last prompt this composer wrote via its own debounced
  // save. A sibling tab adopting our flush re-persists the same
  // text, which storage-events back to us; without this guard that
  // echo would `setValue` our own content and bounce the caret.
  let lastSelfWrite: string | null = null;

  // Cross-tab sync: when ANOTHER browser tab updates this thread's
  // draft, adopt it — but never while the user is editing here. The
  // store's storage-event listener fans out via `subscribeDraft`; we
  // install the watcher per-thread so sibling threads' updates don't
  // trample the local input. The subscription tears down on thread
  // switch via `onCleanup` inside the `on()` callback.
  createEffect(
    on(
      () => props.threadId?.() ?? null,
      (id) => {
        if (!id) return;
        const unsubscribe = subscribeDraft(id, (entry) => {
          const incoming = entry?.prompt ?? "";
          // Our own debounced flush, echoed back via a sibling tab —
          // ignore so an A→B→A loop can't revert local edits.
          if (incoming === lastSelfWrite) return;
          // Already in sync — nothing to adopt.
          if (incoming === value()) return;
          // Never overwrite the box while the user is actively
          // typing into it: only adopt cross-tab updates when this
          // composer's textarea is unfocused (idle / other tab).
          const el = textarea();
          if (el && typeof document !== "undefined" && document.activeElement === el) return;
          setValue(incoming);
          setTextareaCaret(incoming.length);
        });
        onCleanup(unsubscribe);
      },
    ),
  );

  // Save keystrokes (+ the live attachment list) to the per-thread
  // draft. The store debounces writes internally so this is cheap
  // to fire on every value change. Record the value so the cross-tab
  // watcher can recognize and skip our own echoed flush.
  createEffect(() => {
    const id = props.threadId?.() ?? null;
    if (!id) return;
    const current = value();
    lastSelfWrite = current;
    saveDraft(id, current, props.attachments());
  });

  createEffect(() => {
    const next = props.prefillPromptText?.();
    if (next === undefined || next === null) return;
    setValue(next);
    setHiddenSlash(null);
    setHiddenMention(null);
    setCommandHighlight(0);
    setMentionHighlight(0);
    setTextareaCaret(next.length);
    props.onPrefillPromptConsumed?.();
  });

  function syncCaret(element = textarea()) {
    if (!element) return;
    setCaret(element.selectionStart ?? value().length);
  }

  async function send() {
    const text = value().trim();
    // The plan follow-up "Implement" button submits with an empty
    // draft — the host substitutes the implementation prompt for the
    // empty content. Bypass the empty-content guard in that case.
    const planFollowUp = props.showPlanFollowUpPrompt?.() ?? false;
    if ((!hasContent() && !planFollowUp) || props.disabled()) return;
    setValue("");
    setCaret(0);
    setHiddenSlash(null);
    setHiddenMention(null);
    const id = props.threadId?.() ?? null;
    if (id) clearDraft(id);
    await props.onSend(text ? [{ type: "text", text }] : []);
    textarea()?.focus();
  }

  function setTextareaCaret(nextCaret: number) {
    queueMicrotask(() => {
      const element = textarea();
      if (!element) return;
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  }

  function selectCommand(command: AvailableCommand) {
    const context = slashContext();
    if (!context.active) return;

    const tail = value().slice(caret());
    const tokenTailLength = tail.search(/\s/);
    const replaceEnd = tokenTailLength === -1 ? value().length : caret() + tokenTailLength;
    const replacement = `${command.name} `;
    const nextValue =
      value().slice(0, context.slashIndex) + replacement + value().slice(replaceEnd);
    const nextCaret = context.slashIndex + replacement.length;

    setValue(nextValue);
    setHiddenSlash(null);
    setCommandHighlight(0);
    setTextareaCaret(nextCaret);
  }

  function closeCommandMenu() {
    const context = slashContext();
    if (!context.active) return;
    const nextCaret = caret();
    setHiddenSlash({ slashIndex: context.slashIndex, query: context.query });
    setTextareaCaret(nextCaret);
  }

  function selectMention(candidate: MentionCandidate) {
    const context = mentionContext();
    if (!context.active) return;

    const tail = value().slice(caret());
    const tokenTailLength = tail.search(/\s/);
    const replaceEnd = tokenTailLength === -1 ? value().length : caret() + tokenTailLength;
    const replacement = `@${candidate.value} `;
    const nextValue = value().slice(0, context.atIndex) + replacement + value().slice(replaceEnd);
    const nextCaret = context.atIndex + replacement.length;

    setValue(nextValue);
    setHiddenMention(null);
    setMentionHighlight(0);
    setTextareaCaret(nextCaret);
  }

  function closeMentionMenu() {
    const context = mentionContext();
    if (!context.active) return;
    const nextCaret = caret();
    setHiddenMention({ atIndex: context.atIndex, query: context.query });
    setTextareaCaret(nextCaret);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (showCommands()) {
      const results = searchResults();
      if (event.key === "ArrowDown" && results.length > 0) {
        event.preventDefault();
        setCommandHighlight((commandHighlight() + 1) % results.length);
        return;
      }

      if (event.key === "ArrowUp" && results.length > 0) {
        event.preventDefault();
        setCommandHighlight((commandHighlight() - 1 + results.length) % results.length);
        return;
      }

      if ((event.key === "Tab" || event.key === "Enter") && results.length > 0) {
        event.preventDefault();
        const selected = results[Math.min(commandHighlight(), results.length - 1)];
        if (selected) selectCommand(selected.command);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandMenu();
        return;
      }
    }

    if (showMentions()) {
      const results = mentionResults();
      if (event.key === "ArrowDown" && results.length > 0) {
        event.preventDefault();
        setMentionHighlight((mentionHighlight() + 1) % results.length);
        return;
      }

      if (event.key === "ArrowUp" && results.length > 0) {
        event.preventDefault();
        setMentionHighlight((mentionHighlight() - 1 + results.length) % results.length);
        return;
      }

      if ((event.key === "Tab" || event.key === "Enter") && results.length > 0) {
        event.preventDefault();
        const selected = results[Math.min(mentionHighlight(), results.length - 1)];
        if (selected) selectMention(selected.candidate);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }

  const bannerItemsAccessor = (): ReadonlyArray<ComposerBannerItem> =>
    props.bannerItems ? props.bannerItems() : [];

  // Responsive footer measurement. When `useResponsiveFooter` is
  // on, a ResizeObserver tracks the form's measured width and the
  // composer swaps between the inline `ComposerFooterStrip` and
  // the `CompactComposerControlsMenu` popover. Threshold matches the
  // upstream measurement: below 560px → compact. Hosts that pin the
  // chrome via `showCompactControls` always win.
  const FOOTER_COMPACT_THRESHOLD_PX = 560;
  const [formWidth, setFormWidth] = createSignal<number | null>(null);
  function attachFormResizeObserver(form: HTMLFormElement): void {
    if (typeof ResizeObserver === "undefined") {
      setFormWidth(form.clientWidth);
      return;
    }
    setFormWidth(form.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        setFormWidth((previous) => (previous === width ? previous : width));
      }
    });
    ro.observe(form);
    onCleanup(() => ro.disconnect());
  }
  const responsiveFooterEnabled = (): boolean => props.useResponsiveFooter?.() ?? false;
  const isFooterCompact = createMemo<boolean>(() => {
    if (props.showCompactControls?.() === true) return true;
    if (!responsiveFooterEnabled()) return false;
    const width = formWidth();
    if (width === null) return false;
    return width < FOOTER_COMPACT_THRESHOLD_PX;
  });
  const showInlineFooter = createMemo<boolean>(
    () => responsiveFooterEnabled() && !isFooterCompact(),
  );
  const showCompactMenu = createMemo<boolean>(() => {
    if (props.showCompactControls?.() === true) return true;
    if (!responsiveFooterEnabled()) return false;
    return isFooterCompact();
  });

  return (
    <form
      ref={attachFormResizeObserver}
      data-footer-compact={isFooterCompact() ? "true" : "false"}
      class="flex-shrink-0 border-t border-border-weak bg-bg p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <ComposerBannerStack items={bannerItemsAccessor} />
      <Show when={(props.pendingUserInputs?.()?.length ?? 0) > 0}>
        <div class="mb-2 rounded-md border border-border-weak bg-surface/40">
          <ComposerPendingUserInputPanel
            pendingUserInputs={() => props.pendingUserInputs?.() ?? []}
            respondingRequestIds={() => props.pendingUserInputRespondingIds?.() ?? []}
            answers={() => props.pendingUserInputAnswers?.() ?? {}}
            questionIndex={() => props.pendingUserInputQuestionIndex?.() ?? 0}
            onToggleOption={(questionId, optionLabel) =>
              props.onPendingUserInputToggleOption?.(questionId, optionLabel)
            }
            onAdvance={() => props.onPendingUserInputAdvance?.()}
          />
        </div>
      </Show>
      <Show when={props.pendingApproval?.() ?? null}>
        {(approval) => (
          <div data-testid="composer-pending-approval-surface" class="mb-2">
            <ComposerPendingApprovalPanel
              approval={approval()}
              pendingCount={props.pendingApprovalCount?.() ?? 1}
            />
            <Show when={props.onRespondToApproval}>
              {(onRespond) => (
                <ComposerPendingApprovalActions
                  requestId={() => approval().requestId}
                  isResponding={() => props.isRespondingToApproval?.() ?? props.disabled()}
                  onRespondToApproval={onRespond()}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
      <Show when={(props.pendingTerminalContexts?.()?.length ?? 0) > 0}>
        <ComposerPendingTerminalContexts
          contexts={() => props.pendingTerminalContexts?.() ?? []}
          onRemove={props.onRemoveTerminalContext}
          class="mb-2"
        />
      </Show>
      <Show when={props.attachments().length > 0}>
        <Show
          when={props.attachments().length >= 3 || hasImageAttachment(props.attachments())}
          fallback={
            <div class="mb-2 flex flex-wrap gap-1.5">
              <For each={props.attachments()}>
                {(attachment, index) => (
                  <AttachmentChip
                    attachment={attachment}
                    onRemove={() => props.onRemoveAttachment(index())}
                  />
                )}
              </For>
            </div>
          }
        >
          <AttachmentCarousel
            attachments={props.attachments}
            onRemove={props.onRemoveAttachment}
            onReorder={props.onReorderAttachment}
            class="mb-2"
          />
        </Show>
      </Show>
      <Show when={attachError()}>
        {(message) => (
          <div
            data-testid="composer-attach-error"
            role="status"
            class="mb-2 rounded-md border border-red/40 bg-red/10 px-2.5 py-1.5 text-base text-red"
          >
            {message()}
          </div>
        )}
      </Show>
      <div
        data-testid="composer-surface"
        data-drag-over={dragOver() ? "true" : "false"}
        class={`relative flex min-h-[88px] gap-2 rounded-md border bg-surface p-2 focus-within:border-accent ${
          dragOver() ? "border-accent bg-accent/5" : "border-border"
        }`}
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
      >
        <Show when={dragOver()}>
          <div
            data-testid="composer-drop-overlay"
            class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-accent bg-bg/80 text-base font-medium text-accent"
          >
            Drop images to attach
          </div>
        </Show>
        <ComposerCommandMenu
          open={showCommands}
          results={searchResults}
          highlightedIndex={commandHighlight}
          onHighlight={setCommandHighlight}
          onSelect={selectCommand}
          anchor={textarea}
        />
        <ComposerMentionMenu
          open={showMentions}
          results={mentionResults}
          highlightedIndex={mentionHighlight}
          onHighlight={setMentionHighlight}
          onSelect={selectMention}
          anchor={textarea}
        />
        <textarea
          ref={setTextarea}
          class="min-h-[68px] flex-1 resize-none border-0 bg-transparent text-md leading-relaxed text-fg outline-none placeholder:text-dim"
          value={value()}
          disabled={props.disabled()}
          placeholder={`Message ${props.providerName()}`}
          rows={3}
          aria-label="Chat message"
          onInput={(event) => {
            setValue(event.currentTarget.value);
            syncCaret(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onClick={(event) => syncCaret(event.currentTarget)}
          onSelect={(event) => syncCaret(event.currentTarget)}
          onPaste={handleComposerPaste}
        />
        <div class="relative flex flex-shrink-0 flex-col justify-end gap-2">
          <button
            class="h-7 w-8 cursor-pointer rounded-md border border-border bg-surface text-[16px] leading-none text-fg-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
            type="button"
            aria-label="Add context attachment"
            disabled={props.disabled()}
            onClick={(event) => {
              event.stopPropagation();
              setPickerOpen((open) => !open);
            }}
          >
            +
          </button>
          <AttachmentPicker
            open={pickerOpen}
            sessionName={props.sessionName}
            projectDir={props.projectDir}
            terminalPanes={props.terminalPanes}
            onAdd={props.onAddAttachment}
            onClose={() => setPickerOpen(false)}
          />
          <Show when={showCompactMenu()}>
            <CompactComposerControlsMenu
              activePlan={() => props.activePlan?.() ?? false}
              interactionMode={() => props.interactionMode?.() ?? "default"}
              planSidebarLabel={() => props.planSidebarLabel?.() ?? "plan"}
              planSidebarOpen={() => props.planSidebarOpen?.() ?? false}
              runtimeMode={() => props.runtimeMode?.() ?? "approval-required"}
              showInteractionModeToggle={() => props.showInteractionModeToggle?.() ?? true}
              traitsMenuContent={
                props.traitsMenuContent ? () => props.traitsMenuContent!() : undefined
              }
              onToggleInteractionMode={() => props.onToggleInteractionMode?.()}
              onTogglePlanSidebar={() => props.onTogglePlanSidebar?.()}
              onRuntimeModeChange={(mode) => props.onRuntimeModeChange?.(mode)}
            />
          </Show>
          <ComposerPrimaryActions
            compact={() => props.compactPrimaryActions?.() ?? false}
            pendingAction={() => props.pendingAction?.() ?? null}
            isRunning={() => props.disabled()}
            showPlanFollowUpPrompt={() => props.showPlanFollowUpPrompt?.() ?? false}
            promptHasText={() => value().trim().length > 0}
            isSendBusy={() => props.isSendBusy?.() ?? false}
            isConnecting={() => props.isConnecting?.() ?? false}
            isEnvironmentUnavailable={() => props.isEnvironmentUnavailable?.() ?? false}
            isPreparingWorktree={() => props.isPreparingWorktree?.() ?? false}
            hasSendableContent={() => canSend()}
            onPreviousPendingQuestion={() => props.onPreviousPendingQuestion?.()}
            onInterrupt={() => void props.onCancel()}
            onImplementPlanInNewThread={() => props.onImplementPlanInNewThread?.()}
          />
        </div>
      </div>
      <Show when={showInlineFooter()}>
        <div data-testid="composer-footer-row" class="mt-2 flex flex-wrap items-center gap-1">
          <ComposerFooterStrip
            activePlan={() => props.activePlan?.() ?? false}
            interactionMode={() => props.interactionMode?.() ?? "default"}
            planSidebarLabel={() => props.planSidebarLabel?.() ?? "plan"}
            planSidebarOpen={() => props.planSidebarOpen?.() ?? false}
            runtimeMode={() => props.runtimeMode?.() ?? "approval-required"}
            showInteractionModeToggle={() => props.showInteractionModeToggle?.() ?? true}
            onToggleInteractionMode={() => props.onToggleInteractionMode?.()}
            onTogglePlanSidebar={() => props.onTogglePlanSidebar?.()}
            onRuntimeModeChange={(mode) => props.onRuntimeModeChange?.(mode)}
          />
          <Show when={props.traitsMenuContent?.()}>
            {(content) => (
              <>
                <span class="mx-0.5 hidden h-3.5 w-px bg-border-weak sm:block" aria-hidden="true" />
                {content()}
              </>
            )}
          </Show>
        </div>
      </Show>
    </form>
  );
}

function hasImageAttachment(attachments: ReadonlyArray<ComposerAttachment>): boolean {
  for (const attachment of attachments) {
    if (attachment.kind === "image") return true;
  }
  return false;
}
