/**
 * ChatComposer wire coverage for the three new surfaces:
 *
 *   - Pending user-input panel renders above the textarea when
 *     `pendingUserInputs` has at least one prompt.
 *   - Terminal-context chip strip renders above the attachments row
 *     when `pendingTerminalContexts` is non-empty.
 *   - CompactComposerControlsMenu's trigger renders next to the
 *     primary actions when `showCompactControls` is true.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import type { AvailableCommand, ContentBlock } from "../src/types";
import type {
  PendingUserInput,
  PendingUserInputDraftAnswer,
} from "../src/components/ComposerPendingUserInputPanel";
import type { TerminalContextDraft } from "../src/lib/terminalContext";

const commands: AvailableCommand[] = [{ name: "deploy", description: "Deploy" }];

afterEach(() => {
  document.body.innerHTML = "";
});

interface MountOpts {
  pendingUserInputs?: PendingUserInput[];
  pendingUserInputAnswers?: Record<string, PendingUserInputDraftAnswer>;
  pendingTerminalContexts?: TerminalContextDraft[];
  showCompactControls?: boolean;
  onPendingUserInputToggleOption?: (questionId: string, optionLabel: string) => void;
  onRemoveTerminalContext?: (id: string) => void;
  onRuntimeModeChange?: (mode: string) => void;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const [pendingPrompts] = createSignal<ReadonlyArray<PendingUserInput>>(
    opts.pendingUserInputs ?? [],
  );
  const [pendingAnswers] = createSignal<Record<string, PendingUserInputDraftAnswer>>(
    opts.pendingUserInputAnswers ?? {},
  );
  const [pendingTerm] = createSignal<ReadonlyArray<TerminalContextDraft>>(
    opts.pendingTerminalContexts ?? [],
  );
  const [showCompact] = createSignal(opts.showCompactControls ?? false);

  const onSend = vi.fn(async (_content: ContentBlock[]) => undefined);

  const dispose = render(
    () => (
      <ChatComposer
        disabled={() => false}
        availableCommands={() => commands}
        providerName={() => "Claude"}
        sessionName={() => "alpha"}
        projectDir={() => "/tmp/p"}
        attachments={() => []}
        terminalPanes={() => []}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
        pendingUserInputs={pendingPrompts}
        pendingUserInputAnswers={pendingAnswers}
        pendingUserInputRespondingIds={() => []}
        pendingUserInputQuestionIndex={() => 0}
        onPendingUserInputToggleOption={opts.onPendingUserInputToggleOption ?? vi.fn()}
        onPendingUserInputAdvance={vi.fn()}
        pendingTerminalContexts={pendingTerm}
        onRemoveTerminalContext={opts.onRemoveTerminalContext}
        showCompactControls={showCompact}
        interactionMode={() => "default"}
        runtimeMode={() => "approval-required"}
        onToggleInteractionMode={vi.fn()}
        onTogglePlanSidebar={vi.fn()}
        onRuntimeModeChange={(mode) => opts.onRuntimeModeChange?.(mode)}
      />
    ),
    container,
  );
  return { container, dispose };
}

describe("ChatComposer — pending user-input wiring", () => {
  it("does not mount the panel when the queue is empty", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='composer-pending-user-input-panel']")).toBeNull();
    dispose();
  });

  it("mounts the panel and forwards option clicks", () => {
    const onToggle = vi.fn();
    const { container, dispose } = mount({
      pendingUserInputs: [
        {
          requestId: "req-1",
          createdAt: "2026-05-14T08:00:00.000Z",
          questions: [
            {
              id: "q1",
              header: "Pick one",
              question: "Choose",
              options: [{ label: "Alpha" }, { label: "Bravo" }],
            },
          ],
        },
      ],
      onPendingUserInputToggleOption: onToggle,
    });
    expect(
      container.querySelector("[data-testid='composer-pending-user-input-panel']"),
    ).toBeTruthy();
    const opt = container.querySelector<HTMLButtonElement>(
      "[data-testid='composer-pending-user-input-option'][data-option-label='Bravo']",
    );
    opt!.click();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("q1", "Bravo");
    dispose();
  });
});

describe("ChatComposer — terminal-context chip wiring", () => {
  it("renders the chip strip with one chip per context", () => {
    const { container, dispose } = mount({
      pendingTerminalContexts: [
        {
          id: "ctx-1",
          threadId: "t1",
          terminalId: "term-1",
          terminalLabel: "Dev",
          lineStart: 1,
          lineEnd: 5,
          text: "build output",
          createdAt: "2026-05-14T08:00:00.000Z",
        },
      ],
    });
    const strip = container.querySelector("[data-testid='composer-pending-terminal-contexts']");
    expect(strip).toBeTruthy();
    expect(container.querySelectorAll("[data-testid='terminal-context-inline-chip']").length).toBe(
      1,
    );
    dispose();
  });

  it("forwards × clicks to onRemoveTerminalContext", () => {
    const onRemove = vi.fn();
    const { container, dispose } = mount({
      pendingTerminalContexts: [
        {
          id: "ctx-99",
          threadId: "t1",
          terminalId: "term-1",
          terminalLabel: "Dev",
          lineStart: 1,
          lineEnd: 5,
          text: "x",
          createdAt: "2026-05-14T08:00:00.000Z",
        },
      ],
      onRemoveTerminalContext: onRemove,
    });
    container
      .querySelector<HTMLButtonElement>("[data-testid='terminal-context-inline-chip-remove']")!
      .click();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("ctx-99");
    dispose();
  });
});

describe("ChatComposer — compact-controls wiring", () => {
  it("does not render the trigger when showCompactControls is false", () => {
    const { container, dispose } = mount({ showCompactControls: false });
    expect(container.querySelector("[data-testid='compact-composer-controls']")).toBeNull();
    dispose();
  });

  it("renders the trigger and surfaces the runtime menu when opened", () => {
    const onRuntime = vi.fn();
    const { container, dispose } = mount({
      showCompactControls: true,
      onRuntimeModeChange: onRuntime,
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-trigger']",
    );
    expect(trigger).toBeTruthy();
    trigger!.click();
    const fullAccess = container.querySelector<HTMLButtonElement>(
      "[data-testid='compact-composer-controls-runtime-option'][data-value='full-access']",
    );
    expect(fullAccess).toBeTruthy();
    fullAccess!.click();
    expect(onRuntime).toHaveBeenCalledExactlyOnceWith("full-access");
    dispose();
  });
});
