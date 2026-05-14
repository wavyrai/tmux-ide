/**
 * Multi-choice prompt panel rendered between the banner stack and
 * the textarea. Mounts when the daemon raises a `pendingUserInput`
 * event ("agent asks: pick one of these"). Supports:
 *
 *   - Single-select with 200ms auto-advance after a click
 *   - Multi-select with explicit toggle behavior (no advance)
 *   - 1-9 keyboard shortcuts on each option (when the corresponding
 *     digit key is pressed outside an editable element)
 *   - Per-question counter `n/N` when the prompt has more than one
 *     question staged
 *
 * The active draft answers and questionIndex stay with the host —
 * this component is pure render plus a single advance side-effect.
 *
 * Pure-render boundary: every state mutation flows through
 * `onToggleOption` / `onAdvance` so the host owns the wire shape
 * (and the auto-clear behavior when the agent dispatches the
 * follow-up turn).
 */

import {
  createEffect,
  createMemo,
  For,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";

export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  options: ReadonlyArray<UserInputOption>;
}

export interface PendingUserInput {
  requestId: string;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface ComposerPendingUserInputPanelProps {
  pendingUserInputs: Accessor<ReadonlyArray<PendingUserInput>>;
  /** Request ids the host is currently dispatching answers for. */
  respondingRequestIds: Accessor<ReadonlyArray<string>>;
  /** Map of `questionId` → draft answer. */
  answers: Accessor<Record<string, PendingUserInputDraftAnswer>>;
  questionIndex: Accessor<number>;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onAdvance: () => void;
}

const AUTO_ADVANCE_MS = 200;

function selectedLabelsFor(
  question: UserInputQuestion | null,
  draft: PendingUserInputDraftAnswer | undefined,
): string[] {
  if (!question) return [];
  const labels = draft?.selectedOptionLabels;
  if (!Array.isArray(labels)) return [];
  return labels.filter((entry): entry is string => typeof entry === "string");
}

const STAR_CHECK_PATH = "M3 8.5l3 3 7-7";

export function ComposerPendingUserInputPanel(
  props: ComposerPendingUserInputPanelProps,
): JSX.Element {
  const activePrompt = createMemo<PendingUserInput | null>(
    () => props.pendingUserInputs()[0] ?? null,
  );

  const isResponding = createMemo<boolean>(() => {
    const prompt = activePrompt();
    if (!prompt) return false;
    return props.respondingRequestIds().includes(prompt.requestId);
  });

  const activeQuestion = createMemo<UserInputQuestion | null>(() => {
    const prompt = activePrompt();
    if (!prompt) return null;
    return prompt.questions[props.questionIndex()] ?? null;
  });

  const draftAnswer = createMemo<PendingUserInputDraftAnswer | undefined>(() => {
    const question = activeQuestion();
    if (!question) return undefined;
    return props.answers()[question.id];
  });

  const selectedLabels = createMemo<string[]>(() =>
    selectedLabelsFor(activeQuestion(), draftAnswer()),
  );

  let autoAdvanceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAutoAdvance = (): void => {
    if (autoAdvanceTimer !== null) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  };
  onCleanup(clearAutoAdvance);

  function handleSelect(question: UserInputQuestion, optionLabel: string): void {
    props.onToggleOption(question.id, optionLabel);
    if (question.multiSelect) return;
    clearAutoAdvance();
    autoAdvanceTimer = setTimeout(() => {
      autoAdvanceTimer = null;
      props.onAdvance();
    }, AUTO_ADVANCE_MS);
  }

  // 1-9 digit keys select the corresponding option as long as focus
  // isn't inside an editable element (textarea / input /
  // contenteditable). Wired only while we have an active question
  // and the host isn't already mid-dispatch.
  createEffect(
    on([activeQuestion, isResponding], ([question, responding]) => {
      if (!question || responding) return;
      const handler = (event: globalThis.KeyboardEvent): void => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          return;
        }
        if (
          target instanceof HTMLElement &&
          target.closest('[contenteditable]:not([contenteditable="false"])')
        ) {
          return;
        }
        const digit = Number.parseInt(event.key, 10);
        if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
        const optionIndex = digit - 1;
        if (optionIndex >= question.options.length) return;
        const option = question.options[optionIndex];
        if (!option) return;
        event.preventDefault();
        handleSelect(question, option.label);
      };
      document.addEventListener("keydown", handler);
      onCleanup(() => document.removeEventListener("keydown", handler));
    }),
  );

  const renderable = createMemo(() => {
    const prompt = activePrompt();
    const question = activeQuestion();
    if (!prompt || !question) return null;
    return { prompt, question };
  });

  return (
    <Show when={renderable()}>
      {(getCurrent) => {
        const prompt = (): PendingUserInput => getCurrent().prompt;
        const question = (): UserInputQuestion => getCurrent().question;
        return (
          <div
            data-testid="composer-pending-user-input-panel"
            data-request-id={prompt().requestId}
            class="px-4 py-3 sm:px-5"
          >
            <div class="flex items-center gap-2">
              <Show when={prompt().questions.length > 1}>
                <span class="inline-flex h-5 items-center rounded-md bg-surface px-1.5 text-[10px] font-medium tabular-nums text-fg-secondary">
                  {props.questionIndex() + 1}/{prompt().questions.length}
                </span>
              </Show>
              <span class="text-[11px] font-semibold uppercase tracking-[0.2em] text-dim">
                {question().header}
              </span>
            </div>
            <p class="mt-1.5 text-[13px] text-fg">{question().question}</p>
            <Show when={question().multiSelect}>
              <p
                data-testid="composer-pending-user-input-multi-hint"
                class="mt-1 text-[11px] text-dim"
              >
                Select one or more options.
              </p>
            </Show>
            <div class="mt-3 flex flex-col gap-1">
              <For each={question().options}>
                {(option, index) => {
                  const isSelected = (): boolean =>
                    selectedLabels().includes(option.label);
                  const shortcutKey = (): number | null =>
                    index() < 9 ? index() + 1 : null;
                  return (
                    <button
                      type="button"
                      data-testid="composer-pending-user-input-option"
                      data-question-id={question().id}
                      data-option-label={option.label}
                      data-shortcut={shortcutKey() ?? ""}
                      data-selected={isSelected() ? "true" : "false"}
                      disabled={isResponding()}
                      class={
                        "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors " +
                        (isSelected()
                          ? "border-accent/40 bg-accent/10 text-fg"
                          : "border-transparent bg-surface/40 text-fg hover:bg-surface/70") +
                        (isResponding() ? " cursor-not-allowed opacity-50" : "")
                      }
                      onClick={() => handleSelect(question(), option.label)}
                    >
                      <Show when={shortcutKey()}>
                        {(key) => (
                          <kbd
                            data-testid="composer-pending-user-input-shortcut"
                            class={
                              "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums " +
                              (isSelected()
                                ? "bg-accent/20 text-accent"
                                : "bg-surface text-dim")
                            }
                          >
                            {key()}
                          </kbd>
                        )}
                      </Show>
                      <div class="min-w-0 flex-1">
                        <span class="text-[13px] font-medium">{option.label}</span>
                        <Show when={option.description && option.description !== option.label}>
                          <span class="ml-2 text-[11px] text-dim">{option.description}</span>
                        </Show>
                      </div>
                      <Show when={isSelected()}>
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.6"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          class="shrink-0 text-accent"
                          aria-hidden="true"
                        >
                          <path d={STAR_CHECK_PATH} />
                        </svg>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
