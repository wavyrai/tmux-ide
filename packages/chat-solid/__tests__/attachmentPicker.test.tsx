import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPicker } from "../src/components/AttachmentPicker";
import type { ComposerAttachment } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AttachmentPicker", () => {
  it("populates terminal panes and adds the selected pane", () => {
    const added: ComposerAttachment[] = [];
    const onClose = vi.fn();
    const [open] = createSignal(true);
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(
      () => (
        <AttachmentPicker
          open={open}
          sessionName={() => "alpha"}
          projectDir={() => "/Users/thijs/Developer/tmux-ide"}
          terminalPanes={() => [
            {
              paneId: "%1",
              paneTitle: "Dev Server",
              sessionName: "alpha",
              currentCommand: "pnpm",
            },
          ]}
          onAdd={(attachment) => added.push(attachment)}
          onClose={onClose}
        />
      ),
      container,
    );

    expect(container.textContent).toContain("Dev Server");
    container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      if (button.textContent?.includes("Dev Server")) {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });

    expect(added).toEqual([
      { kind: "terminal", paneId: "%1", paneTitle: "Dev Server", sessionName: "alpha" },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("adds a file attachment on Enter", () => {
    const added: ComposerAttachment[] = [];
    const [open] = createSignal(true);
    const container = document.createElement("div");
    document.body.appendChild(container);

    render(
      () => (
        <AttachmentPicker
          open={open}
          sessionName={() => "alpha"}
          projectDir={() => "/Users/thijs/Developer/tmux-ide"}
          terminalPanes={() => []}
          onAdd={(attachment) => added.push(attachment)}
          onClose={() => undefined}
        />
      ),
      container,
    );

    container.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      if (button.textContent === "File") {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });
    const input = container.querySelector<HTMLInputElement>("input[aria-label='File path']");
    expect(input).toBeTruthy();
    input!.value = "~/notes.md";
    input!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(added).toEqual([{ kind: "file", path: "/Users/thijs/notes.md", label: "notes.md" }]);
  });
});
