/**
 * Pending user-input panel — covers:
 *
 *   1. Renders nothing when the queue is empty.
 *   2. Renders the first prompt's active question + options.
 *   3. Click on an option dispatches `onToggleOption(questionId,
 *      label)`. Single-select schedules an auto-advance; multi-
 *      select does not.
 *   4. Numeric keys 1-9 (outside editable elements) dispatch the
 *      corresponding option.
 *   5. Numeric keys are ignored when responding.
 *   6. `n/N` counter renders only when the prompt has multiple
 *      questions.
 *   7. `data-selected="true"` mirrors the active draft answer.
 *   8. The multi-select hint renders when `multiSelect=true`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ComposerPendingUserInputPanel,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../src/components/ComposerPendingUserInputPanel";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function singlePrompt(overrides: Partial<PendingUserInput> = {}): PendingUserInput {
  return {
    requestId: "req-1",
    createdAt: "2026-05-14T08:00:00.000Z",
    questions: [
      {
        id: "q1",
        header: "Which framework?",
        question: "Pick the framework you want to use",
        options: [{ label: "React" }, { label: "Solid" }, { label: "Vue" }],
      },
    ],
    ...overrides,
  };
}

interface MountOpts {
  prompts?: PendingUserInput[];
  responding?: string[];
  answers?: Record<string, PendingUserInputDraftAnswer>;
  questionIndex?: number;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [prompts] = createSignal<ReadonlyArray<PendingUserInput>>(opts.prompts ?? []);
  const [responding] = createSignal<ReadonlyArray<string>>(opts.responding ?? []);
  const [answers, setAnswers] = createSignal<Record<string, PendingUserInputDraftAnswer>>(
    opts.answers ?? {},
  );
  const [questionIndex, setQuestionIndex] = createSignal(opts.questionIndex ?? 0);

  const onToggleOption = vi.fn((questionId: string, optionLabel: string) => {
    setAnswers((current) => {
      const existing = current[questionId]?.selectedOptionLabels ?? [];
      const next = existing.includes(optionLabel)
        ? existing.filter((label) => label !== optionLabel)
        : [...existing, optionLabel];
      return { ...current, [questionId]: { selectedOptionLabels: next } };
    });
  });
  const onAdvance = vi.fn(() => setQuestionIndex((value) => value + 1));

  const dispose = render(
    () => (
      <ComposerPendingUserInputPanel
        pendingUserInputs={prompts}
        respondingRequestIds={responding}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
      />
    ),
    container,
  );

  return { container, dispose, onToggleOption, onAdvance };
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders nothing when the queue is empty", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='composer-pending-user-input-panel']")).toBeNull();
    dispose();
  });

  it("renders the first prompt with all its options", () => {
    const { container, dispose } = mount({ prompts: [singlePrompt()] });
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-panel']"),
    ).toBeTruthy();
    const options = container.querySelectorAll(
      "[data-testid='composer-pending-user-input-option']",
    );
    expect(options.length).toBe(3);
    expect(Array.from(options).map((opt) => opt.getAttribute("data-option-label"))).toEqual([
      "React",
      "Solid",
      "Vue",
    ]);
    dispose();
  });

  it("dispatches onToggleOption when an option is clicked", () => {
    const { container, dispose, onToggleOption } = mount({ prompts: [singlePrompt()] });
    const solid = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-user-input-option'][data-option-label='Solid']",
    );
    solid!.click();
    expect(onToggleOption).toHaveBeenCalledExactlyOnceWith("q1", "Solid");
    dispose();
  });

  it("schedules onAdvance after 200ms on single-select", () => {
    vi.useFakeTimers();
    const { container, dispose, onAdvance } = mount({ prompts: [singlePrompt()] });
    const solid = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-user-input-option'][data-option-label='Solid']",
    );
    solid!.click();
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(onAdvance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does NOT schedule onAdvance for multi-select prompts", () => {
    vi.useFakeTimers();
    const prompt = singlePrompt({
      questions: [
        {
          id: "qm",
          header: "Pick traits",
          question: "Pick one or more",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });
    const { container, dispose, onAdvance } = mount({ prompts: [prompt] });
    container
      .querySelector<HTMLButtonElement>(
        "[data-testid='composer-pending-user-input-option'][data-option-label='A']",
      )!
      .click();
    vi.advanceTimersByTime(500);
    expect(onAdvance).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-multi-hint']"),
    ).toBeTruthy();
    dispose();
  });

  it("number key 2 selects the second option (outside editable focus)", () => {
    const { container, dispose, onToggleOption } = mount({ prompts: [singlePrompt()] });
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-panel']"),
    ).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    expect(onToggleOption).toHaveBeenCalledExactlyOnceWith("q1", "Solid");
    dispose();
  });

  it("ignores numeric shortcuts while responding", () => {
    const { container, dispose, onToggleOption } = mount({
      prompts: [singlePrompt()],
      responding: ["req-1"],
    });
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-panel']"),
    ).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    expect(onToggleOption).not.toHaveBeenCalled();
    dispose();
  });

  it("ignores numeric shortcuts when focus is inside a textarea", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    const { container, dispose, onToggleOption } = mount({ prompts: [singlePrompt()] });
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-panel']"),
    ).toBeTruthy();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onToggleOption).not.toHaveBeenCalled();
    dispose();
  });

  it("renders the n/N counter only when the prompt has multiple questions", () => {
    const prompt = singlePrompt({
      questions: [
        { id: "qa", header: "A", question: "?", options: [{ label: "x" }] },
        { id: "qb", header: "B", question: "?", options: [{ label: "y" }] },
      ],
    });
    const { container, dispose } = mount({ prompts: [prompt] });
    expect(container.textContent).toContain("1/2");
    dispose();
  });

  it("flags the selected option via data-selected='true'", () => {
    const { container, dispose } = mount({
      prompts: [singlePrompt()],
      answers: { q1: { selectedOptionLabels: ["Solid"] } },
    });
    const selected = container.querySelector(
      "[data-testid='composer-pending-user-input-option'][data-selected='true']",
    );
    expect(selected?.getAttribute("data-option-label")).toBe("Solid");
    dispose();
  });
});
