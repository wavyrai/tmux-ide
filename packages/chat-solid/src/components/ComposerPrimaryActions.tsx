/**
 * Composer primary-action state machine.
 *
 * Ported from the upstream chat surface. Encodes four mutually
 * exclusive button shapes in priority order:
 *
 *   1. `pendingAction` — multi-question pending prompt. Renders
 *      "Previous" (when questionIndex > 0) + the submit/next button.
 *   2. `isRunning` — assistant is generating. Renders a circular
 *      Stop button that calls `onInterrupt`.
 *   3. `showPlanFollowUpPrompt` — a pending plan is staged. With text
 *      in the textarea, the submit reads "Refine"; without text, a
 *      split button reads "Implement" with a chevron menu for
 *      "Implement in a new thread".
 *   4. Default — idle send button, spinner while connecting/sending.
 *
 * Pure render — every interaction is a callback the host owns. The
 * component does not introspect `pendingAction.canAdvance` /
 * `isComplete` beyond passing them through to disable logic.
 *
 * Adapted to Solid:
 *   - React `memo` dropped (Solid's fine-grained reactivity makes it
 *     unnecessary).
 *   - Plain Solid `Show` for branching; no JSX-conditional bundles.
 *   - Inline SVG for the chevron / stop / send icons so this file
 *     stays free of an icon-library dep.
 *
 * Sibling exports: `formatPendingPrimaryActionLabel` mirrors the
 * upstream helper so unit tests can pin the label vocabulary.
 */

import { Show, type Accessor, type JSX } from "solid-js";

export interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

export interface ComposerPrimaryActionsProps {
  compact: Accessor<boolean>;
  pendingAction: Accessor<PendingActionState | null>;
  isRunning: Accessor<boolean>;
  showPlanFollowUpPrompt: Accessor<boolean>;
  promptHasText: Accessor<boolean>;
  isSendBusy: Accessor<boolean>;
  isConnecting: Accessor<boolean>;
  isEnvironmentUnavailable: Accessor<boolean>;
  isPreparingWorktree: Accessor<boolean>;
  hasSendableContent: Accessor<boolean>;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  /**
   * Mirrors the upstream `preserveComposerFocusOnPointerDown` flag —
   * when true, each button cancels its pointer-down so focus stays in
   * the textarea. Host opts in when the composer textarea must keep
   * caret position while a sibling control is clicked.
   */
  preserveComposerFocusOnPointerDown?: boolean;
}

export function formatPendingPrimaryActionLabel(input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}): string {
  if (input.isResponding) return "Submitting...";
  if (input.compact) return input.isLastQuestion ? "Submit" : "Next";
  if (!input.isLastQuestion) return "Next question";
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
}

function preventPointerFocus(event: PointerEvent): void {
  event.preventDefault();
}

const BUTTON_BASE =
  "inline-flex items-center justify-center rounded-full border border-border bg-surface px-3 text-base font-medium text-fg-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45";

const BUTTON_PRIMARY =
  "inline-flex items-center justify-center rounded-full border border-transparent bg-accent px-4 text-base font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30";

const BUTTON_ICON_SM =
  "inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-fg-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45";

export function ComposerPrimaryActions(props: ComposerPrimaryActionsProps): JSX.Element {
  const pointerHandler = (): { onPointerDown?: (event: PointerEvent) => void } =>
    props.preserveComposerFocusOnPointerDown ? { onPointerDown: preventPointerFocus } : {};

  const pendingLabel = (): string => {
    const pending = props.pendingAction();
    if (!pending) return "";
    return formatPendingPrimaryActionLabel({
      compact: props.compact(),
      isLastQuestion: pending.isLastQuestion,
      isResponding: pending.isResponding,
      questionIndex: pending.questionIndex,
    });
  };

  const pendingSubmitDisabled = (): boolean => {
    const pending = props.pendingAction();
    if (!pending) return true;
    if (props.isEnvironmentUnavailable()) return true;
    if (pending.isResponding) return true;
    return pending.isLastQuestion ? !pending.isComplete : !pending.canAdvance;
  };

  return (
    <div data-testid="composer-primary-actions">
      <Show
        when={props.pendingAction()}
        fallback={
          <Show
            when={props.isRunning()}
            fallback={
              <Show
                when={props.showPlanFollowUpPrompt()}
                fallback={
                  <button
                    type="submit"
                    data-testid="composer-primary-send"
                    class="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-bg transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
                    {...pointerHandler()}
                    disabled={
                      props.isSendBusy() ||
                      props.isConnecting() ||
                      props.isEnvironmentUnavailable() ||
                      !props.hasSendableContent()
                    }
                    aria-label={
                      props.isEnvironmentUnavailable()
                        ? "Environment disconnected"
                        : props.isConnecting()
                          ? "Connecting"
                          : props.isPreparingWorktree()
                            ? "Preparing worktree"
                            : props.isSendBusy()
                              ? "Sending"
                              : "Send message"
                    }
                  >
                    <Show
                      when={props.isConnecting() || props.isSendBusy()}
                      fallback={
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      }
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        fill="none"
                        class="animate-spin"
                        aria-hidden="true"
                      >
                        <circle
                          cx="7"
                          cy="7"
                          r="5.5"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-dasharray="20 12"
                        />
                      </svg>
                    </Show>
                  </button>
                }
              >
                <Show
                  when={props.promptHasText()}
                  fallback={
                    <div
                      data-testid="composer-implement-split"
                      class="flex items-stretch overflow-hidden rounded-full"
                    >
                      <button
                        type="submit"
                        data-testid="composer-implement-submit"
                        class="inline-flex h-8 items-center rounded-l-full rounded-r-none border border-transparent bg-accent px-4 text-base font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
                        {...pointerHandler()}
                        disabled={
                          props.isSendBusy() ||
                          props.isConnecting() ||
                          props.isEnvironmentUnavailable()
                        }
                      >
                        {props.isConnecting() || props.isSendBusy() ? "Sending..." : "Implement"}
                      </button>
                      <button
                        type="button"
                        data-testid="composer-implement-new-thread"
                        aria-label="Implementation actions"
                        class="inline-flex h-8 items-center rounded-l-none rounded-r-full border border-transparent border-l-white/10 bg-accent px-2 text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
                        {...pointerHandler()}
                        disabled={
                          props.isSendBusy() ||
                          props.isConnecting() ||
                          props.isEnvironmentUnavailable()
                        }
                        onClick={() => void props.onImplementPlanInNewThread()}
                        title="Implement in a new thread"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M3.5 5.5L7 9L10.5 5.5"
                            stroke="currentColor"
                            stroke-width="1.6"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  }
                >
                  <button
                    type="submit"
                    data-testid="composer-refine"
                    class={BUTTON_PRIMARY + " h-8"}
                    {...pointerHandler()}
                    disabled={
                      props.isSendBusy() || props.isConnecting() || props.isEnvironmentUnavailable()
                    }
                  >
                    {props.isConnecting() || props.isSendBusy() ? "Sending..." : "Refine"}
                  </button>
                </Show>
              </Show>
            }
          >
            <button
              type="button"
              data-testid="composer-stop"
              class="flex h-8 w-8 items-center justify-center rounded-full bg-red text-bg transition-opacity hover:opacity-90"
              {...pointerHandler()}
              onClick={() => props.onInterrupt()}
              aria-label="Stop generation"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="currentColor"
                aria-hidden="true"
              >
                <rect x="2" y="2" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          </Show>
        }
      >
        {(pending) => (
          <div
            class={`flex items-center justify-end ${props.compact() ? "gap-1.5" : "gap-2"}`}
            data-testid="composer-pending-actions"
          >
            <Show when={pending().questionIndex > 0}>
              <Show
                when={props.compact()}
                fallback={
                  <button
                    type="button"
                    data-testid="composer-pending-previous"
                    class={BUTTON_BASE + " h-8"}
                    {...pointerHandler()}
                    onClick={() => props.onPreviousPendingQuestion()}
                    disabled={pending().isResponding}
                  >
                    Previous
                  </button>
                }
              >
                <button
                  type="button"
                  data-testid="composer-pending-previous"
                  class={BUTTON_ICON_SM}
                  {...pointerHandler()}
                  onClick={() => props.onPreviousPendingQuestion()}
                  disabled={pending().isResponding}
                  aria-label="Previous question"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path
                      d="M8.5 3.5L5 7L8.5 10.5"
                      stroke="currentColor"
                      stroke-width="1.6"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              </Show>
            </Show>
            <button
              type="submit"
              data-testid="composer-pending-submit"
              class={`${BUTTON_PRIMARY} h-8 ${props.compact() ? "px-3" : "px-4"}`}
              {...pointerHandler()}
              disabled={pendingSubmitDisabled()}
            >
              {pendingLabel()}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
