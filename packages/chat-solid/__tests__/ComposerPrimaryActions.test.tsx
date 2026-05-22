/**
 * Ported state-machine for the composer primary action button.
 *
 * Mirrors the upstream `ComposerPrimaryActions.test.ts` coverage
 * (label vocabulary for pending prompts) and adds Solid-render
 * coverage for the four branches a host depends on:
 *
 *   1. pending-action mode  → submit + optional previous button
 *   2. running mode         → circular Stop button → onInterrupt
 *   3. plan-follow-up mode  → Refine (with text) vs Implement split
 *                             button (no text, chevron → new-thread)
 *   4. default              → Send button gated on `hasSendableContent`
 *
 * Each branch asserts the data-testid attached to the rendered
 * button so a future restyle can't silently drop the semantics.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ComposerPrimaryActions,
  formatPendingPrimaryActionLabel,
  type PendingActionState,
} from "../src/components/ComposerPrimaryActions";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only one", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question with multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });
});

interface MountOpts {
  pendingAction?: PendingActionState | null;
  isRunning?: boolean;
  showPlanFollowUpPrompt?: boolean;
  promptHasText?: boolean;
  isSendBusy?: boolean;
  isConnecting?: boolean;
  isEnvironmentUnavailable?: boolean;
  isPreparingWorktree?: boolean;
  hasSendableContent?: boolean;
  compact?: boolean;
}

function mount(initial: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [pendingAction] = createSignal(initial.pendingAction ?? null);
  const [isRunning] = createSignal(initial.isRunning ?? false);
  const [showPlanFollowUpPrompt] = createSignal(initial.showPlanFollowUpPrompt ?? false);
  const [promptHasText] = createSignal(initial.promptHasText ?? false);
  const [isSendBusy] = createSignal(initial.isSendBusy ?? false);
  const [isConnecting] = createSignal(initial.isConnecting ?? false);
  const [isEnvironmentUnavailable] = createSignal(initial.isEnvironmentUnavailable ?? false);
  const [isPreparingWorktree] = createSignal(initial.isPreparingWorktree ?? false);
  const [hasSendableContent] = createSignal(initial.hasSendableContent ?? true);
  const [compact] = createSignal(initial.compact ?? false);

  const onPreviousPendingQuestion = vi.fn();
  const onInterrupt = vi.fn();
  const onImplementPlanInNewThread = vi.fn();

  const dispose = render(
    () => (
      <ComposerPrimaryActions
        compact={compact}
        pendingAction={pendingAction}
        isRunning={isRunning}
        showPlanFollowUpPrompt={showPlanFollowUpPrompt}
        promptHasText={promptHasText}
        isSendBusy={isSendBusy}
        isConnecting={isConnecting}
        isEnvironmentUnavailable={isEnvironmentUnavailable}
        isPreparingWorktree={isPreparingWorktree}
        hasSendableContent={hasSendableContent}
        onPreviousPendingQuestion={onPreviousPendingQuestion}
        onInterrupt={onInterrupt}
        onImplementPlanInNewThread={onImplementPlanInNewThread}
      />
    ),
    container,
  );

  return {
    container,
    dispose,
    handlers: { onPreviousPendingQuestion, onInterrupt, onImplementPlanInNewThread },
  };
}

describe("ComposerPrimaryActions branches", () => {
  it("renders the default Send button with sendable content", () => {
    const { container, dispose } = mount();
    const send = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-primary-send']",
    );
    expect(send).toBeTruthy();
    expect(send!.disabled).toBe(false);
    dispose();
  });

  it("disables Send when hasSendableContent is false", () => {
    const { container, dispose } = mount({ hasSendableContent: false });
    const send = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-primary-send']",
    );
    expect(send!.disabled).toBe(true);
    dispose();
  });

  it("renders Stop and dispatches onInterrupt when running", () => {
    const { container, dispose, handlers } = mount({ isRunning: true });
    const stop = container.querySelector<HTMLButtonElement>("[data-testid='composer-stop']");
    expect(stop).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-primary-send']")).toBeNull();
    stop!.click();
    expect(handlers.onInterrupt).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("renders Implement split button when plan-follow-up active with no text", () => {
    const { container, dispose, handlers } = mount({
      showPlanFollowUpPrompt: true,
      promptHasText: false,
    });
    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-implement-submit']",
    );
    const newThread = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-implement-new-thread']",
    );
    expect(submit).toBeTruthy();
    expect(newThread).toBeTruthy();
    newThread!.click();
    expect(handlers.onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("renders Refine when plan-follow-up active and text is staged", () => {
    const { container, dispose } = mount({
      showPlanFollowUpPrompt: true,
      promptHasText: true,
    });
    expect(container.querySelector("[data-testid='composer-refine']")).toBeTruthy();
    expect(container.querySelector("[data-testid='composer-implement-submit']")).toBeNull();
    dispose();
  });

  it("renders submit-only on the first pending question", () => {
    const { container, dispose } = mount({
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: false,
        canAdvance: true,
        isResponding: false,
        isComplete: false,
      },
    });
    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-submit']",
    );
    expect(submit).toBeTruthy();
    expect(submit!.textContent?.trim()).toBe("Next question");
    expect(container.querySelector("[data-testid='composer-pending-previous']")).toBeNull();
    dispose();
  });

  it("renders Previous + submit once past the first pending question", () => {
    const { container, dispose, handlers } = mount({
      pendingAction: {
        questionIndex: 2,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
    });
    const previous = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-previous']",
    );
    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-submit']",
    );
    expect(previous).toBeTruthy();
    expect(submit!.textContent?.trim()).toBe("Submit answers");
    previous!.click();
    expect(handlers.onPreviousPendingQuestion).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("disables pending submit when the last question is incomplete", () => {
    const { container, dispose } = mount({
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
      },
    });
    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-submit']",
    );
    expect(submit!.disabled).toBe(true);
    dispose();
  });

  it("disables pending submit on a non-last question without canAdvance", () => {
    const { container, dispose } = mount({
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: false,
        canAdvance: false,
        isResponding: false,
        isComplete: false,
      },
    });
    const submit = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-submit']",
    );
    expect(submit!.disabled).toBe(true);
    dispose();
  });
});
