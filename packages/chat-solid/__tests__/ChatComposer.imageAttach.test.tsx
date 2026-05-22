/**
 * ChatComposer wiring for paste / drop image attachments.
 *
 * Pins:
 *   1. Pasting an image File into the textarea stages it via
 *      onAddAttachment (kind: image, data URL).
 *   2. Pasting a non-image is a no-op (text paste falls through).
 *   3. Drag-enter/over toggles the drop overlay; drop ingests the
 *      images and clears the overlay.
 *   4. An over-cap / wrong-type file surfaces the inline error line
 *      and fires onAttachmentError.
 *   5. Drop with no image files surfaces the "only image files"
 *      error.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import { MAX_IMAGE_BYTES } from "../src/lib/composerImageAttach";
import type { AvailableCommand, ComposerAttachment, ContentBlock } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

function fakeFile(name: string, type: string, size: number): File {
  const file = new File(["xxxx"], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

function clipboardEventWith(files: File[]): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: { files: files as unknown as FileList, types: ["Files"] },
    configurable: true,
  });
  return event;
}

function dragEventOf(type: string, files: File[], types: string[] = ["Files"]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { files: files as unknown as FileList, types, dropEffect: "none" },
    configurable: true,
  });
  return event;
}

interface MountOpts {
  onAddAttachment?: (a: ComposerAttachment) => void;
  onAttachmentError?: (m: string) => void;
  disabled?: boolean;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [disabled] = createSignal(opts.disabled ?? false);
  const onAdd = vi.fn((a: ComposerAttachment) => {
    setAttachments((cur) => [...cur, a]);
    opts.onAddAttachment?.(a);
  });
  const onError = vi.fn((m: string) => opts.onAttachmentError?.(m));

  const dispose = render(
    () => (
      <ChatComposer
        disabled={disabled}
        availableCommands={() => [] as AvailableCommand[]}
        providerName={() => "Claude"}
        sessionName={() => "alpha"}
        projectDir={() => "/tmp/p"}
        attachments={attachments}
        terminalPanes={() => []}
        onAddAttachment={onAdd}
        onRemoveAttachment={vi.fn()}
        onAttachmentError={onError}
        onSend={vi.fn(async (_c: ContentBlock[]) => undefined)}
        onCancel={vi.fn()}
      />
    ),
    container,
  );
  return { container, dispose, onAdd, onError, attachments };
}

async function flushReaders(): Promise<void> {
  // FileReader.onload is async; let microtasks + a macrotask drain.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe("ChatComposer — paste image", () => {
  it("stages a pasted image as an image attachment", async () => {
    const { container, dispose, onAdd } = mount();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.dispatchEvent(clipboardEventWith([fakeFile("paste.png", "image/png", 128)]));
    await flushReaders();
    expect(onAdd).toHaveBeenCalledTimes(1);
    const arg = onAdd.mock.calls[0]![0];
    expect(arg.kind).toBe("image");
    if (arg.kind === "image") {
      expect(arg.label).toBe("paste.png");
      expect(arg.dataUrl.startsWith("data:")).toBe(true);
    }
    dispose();
  });

  it("ignores a paste with no image files", async () => {
    const { container, dispose, onAdd } = mount();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.dispatchEvent(clipboardEventWith([fakeFile("a.txt", "text/plain", 10)]));
    await flushReaders();
    expect(onAdd).not.toHaveBeenCalled();
    dispose();
  });

  it("surfaces the inline error + onAttachmentError for an oversized image", async () => {
    const { container, dispose, onError } = mount();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.dispatchEvent(clipboardEventWith([fakeFile("huge.png", "image/png", MAX_IMAGE_BYTES + 1)]));
    await flushReaders();
    const line = container.querySelector("[data-testid='composer-attach-error']");
    expect(line?.textContent).toContain("attachment limit");
    expect(onError).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("ChatComposer — drag/drop image", () => {
  it("toggles the drop overlay on dragenter and clears it on drop", async () => {
    const { container, dispose, onAdd } = mount();
    const surface = container.querySelector<HTMLElement>("[data-testid='composer-surface']")!;

    surface.dispatchEvent(dragEventOf("dragenter", [fakeFile("d.png", "image/png", 64)]));
    expect(surface.getAttribute("data-drag-over")).toBe("true");
    expect(container.querySelector("[data-testid='composer-drop-overlay']")).toBeTruthy();

    surface.dispatchEvent(dragEventOf("drop", [fakeFile("d.png", "image/png", 64)]));
    await flushReaders();
    expect(surface.getAttribute("data-drag-over")).toBe("false");
    expect(container.querySelector("[data-testid='composer-drop-overlay']")).toBeNull();
    expect(onAdd).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("errors when the drop carries no image files", async () => {
    const { container, dispose, onError } = mount();
    const surface = container.querySelector<HTMLElement>("[data-testid='composer-surface']")!;
    surface.dispatchEvent(dragEventOf("drop", [fakeFile("a.pdf", "application/pdf", 64)]));
    await flushReaders();
    expect(container.querySelector("[data-testid='composer-attach-error']")?.textContent).toContain(
      "Only image files",
    );
    expect(onError).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("ignores drag payloads that don't advertise Files", () => {
    const { container, dispose } = mount();
    const surface = container.querySelector<HTMLElement>("[data-testid='composer-surface']")!;
    surface.dispatchEvent(dragEventOf("dragenter", [], ["text/plain"]));
    expect(surface.getAttribute("data-drag-over")).toBe("false");
    dispose();
  });

  it("does not ingest while disabled", async () => {
    const { container, dispose, onAdd } = mount({ disabled: true });
    const ta = container.querySelector<HTMLTextAreaElement>("textarea")!;
    ta.dispatchEvent(clipboardEventWith([fakeFile("p.png", "image/png", 64)]));
    await flushReaders();
    expect(onAdd).not.toHaveBeenCalled();
    dispose();
  });
});
