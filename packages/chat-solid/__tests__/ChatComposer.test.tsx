import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import type { AvailableCommand, ContentBlock } from "../src/types";

const commands: AvailableCommand[] = [
  { name: "copy", description: "Copy text" },
  { name: "commit", description: "Create commit" },
  { name: "deploy", description: "Deploy app" },
];

afterEach(() => {
  document.body.innerHTML = "";
});

function mountComposer(
  options: {
    onSend?: (content: ContentBlock[]) => Promise<void>;
    availableCommands?: AvailableCommand[];
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onSend = vi.fn(options.onSend ?? (async () => undefined));

  render(
    () => (
      <ChatComposer
        disabled={() => false}
        availableCommands={() => options.availableCommands ?? commands}
        providerName={() => "Codex"}
        sessionName={() => "alpha"}
        projectDir={() => "/tmp/project"}
        attachments={() => []}
        terminalPanes={() => []}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
      />
    ),
    container,
  );

  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("textarea missing");
  return { container, textarea, onSend };
}

function typeText(textarea: HTMLTextAreaElement, value: string, caret = value.length) {
  textarea.value = value;
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
}

function key(textarea: HTMLTextAreaElement, keyValue: string) {
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: keyValue,
    }),
  );
}

describe("ChatComposer slash commands", () => {
  it("opens a filtered menu when typing a slash command query", () => {
    const { container, textarea } = mountComposer();

    typeText(textarea, "/co");

    expect(container.querySelector("[role='listbox']")).toBeTruthy();
    expect(container.textContent).toContain("copy");
    expect(container.textContent).toContain("commit");
    expect(container.textContent).not.toContain("deploy");
  });

  it("moves highlight with ArrowDown without moving the caret", () => {
    const { container, textarea } = mountComposer();
    typeText(textarea, "/co");
    const caretBefore = textarea.selectionStart;

    key(textarea, "ArrowDown");

    expect(textarea.selectionStart).toBe(caretBefore);
    expect(container.querySelector("[data-command-index='1']")?.className).toContain(
      "bg-surface-hover",
    );
  });

  it("selects the highlighted command with Enter and rewrites the textarea", async () => {
    const { textarea } = mountComposer();
    typeText(textarea, "/co");

    key(textarea, "ArrowDown");
    key(textarea, "Enter");
    await Promise.resolve();

    expect(textarea.value).toBe("commit ");
    expect(textarea.selectionStart).toBe("commit ".length);
  });

  it("closes on Escape without consuming the next Enter", async () => {
    const { container, textarea, onSend } = mountComposer();
    typeText(textarea, "/co");

    key(textarea, "Escape");
    expect(container.querySelector("[role='listbox']")).toBeFalsy();

    key(textarea, "Enter");
    await Promise.resolve();

    expect(onSend).toHaveBeenCalledWith([{ type: "text", text: "/co" }]);
  });

  it("focuses the textarea after selecting a command", async () => {
    const { textarea } = mountComposer();
    typeText(textarea, "/co");

    key(textarea, "Enter");
    await Promise.resolve();

    expect(document.activeElement).toBe(textarea);
  });
});
