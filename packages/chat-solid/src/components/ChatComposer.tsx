import { createEffect, createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import { ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerMentionMenu } from "./ComposerMentionMenu";
import { searchSlashCommands } from "../lib/slashCommandSearch";
import { detectSlashContext } from "../lib/slashCursor";
import { detectMentionContext } from "../lib/mentionCursor";
import {
  searchMentions,
  type MentionCandidate,
  type MentionSearchResult,
} from "../lib/mentionSearch";
import { clearDraft, loadDraft, saveDraft } from "../lib/composerDraftStore";
import type {
  AvailableCommand,
  ComposerAttachment,
  ComposerTerminalPane,
  ContentBlock,
} from "../types";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentPicker } from "./AttachmentPicker";
import { ComposerBannerStack, type ComposerBannerItem } from "./ComposerBannerStack";

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
  onSend(content: ContentBlock[]): Promise<void>;
  onCancel(): Promise<void> | void;
  /**
   * Optional banner surfaces rendered between the timeline and the
   * textarea. Host composes the array from approval / plan-follow-up
   * / pending-user-input state and any project-specific banners.
   * When omitted (or empty), no banner row renders.
   */
  bannerItems?: Accessor<ReadonlyArray<ComposerBannerItem>>;
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

  // Per-thread draft persistence: restore on thread switch, clear local
  // state when threadId goes null. Skips during prefill (handled below).
  createEffect(() => {
    const id = props.threadId?.() ?? null;
    if (!id) {
      setValue("");
      setCaret(0);
      setHiddenSlash(null);
      setHiddenMention(null);
      return;
    }
    const draft = loadDraft(id);
    setValue(draft);
    setHiddenSlash(null);
    setHiddenMention(null);
    setTextareaCaret(draft.length);
  });

  // Save keystrokes to the per-thread draft. The store debounces writes
  // internally so this is cheap to fire on every value change.
  createEffect(() => {
    const id = props.threadId?.() ?? null;
    if (!id) return;
    saveDraft(id, value());
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
    if (!hasContent() || props.disabled()) return;
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
    const nextValue =
      value().slice(0, context.atIndex) + replacement + value().slice(replaceEnd);
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

  return (
    <form
      class="flex-shrink-0 border-t border-border-weak bg-bg p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <ComposerBannerStack items={bannerItemsAccessor} />
      <Show when={props.attachments().length > 0}>
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
      </Show>
      <div class="relative flex min-h-[88px] gap-2 rounded-md border border-border bg-surface p-2 focus-within:border-accent">
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
          class="min-h-[68px] flex-1 resize-none border-0 bg-transparent text-[13px] leading-relaxed text-fg outline-none placeholder:text-dim"
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
          <Show when={props.disabled()}>
            <button
              class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-accent hover:text-accent"
              type="button"
              onClick={() => void props.onCancel()}
            >
              Stop
            </button>
          </Show>
          <button
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-3 text-[12px] text-fg-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
            type="submit"
            disabled={!canSend()}
          >
            Send
          </button>
        </div>
      </div>
    </form>
  );
}
