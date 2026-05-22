/**
 * Wire coverage for the horizontal attachment-preview strip:
 *
 *   1. Renders nothing when the attachment list is empty.
 *   2. One card per attachment, keyed on its kind.
 *   3. Image attachments render a thumbnail <img> with the supplied
 *      data URL; non-image attachments render a glyph fallback.
 *   4. Remove × dispatches `onRemove(index)`.
 *   5. Reorder arrows render only when `onReorder` is supplied, and
 *      dispatch (from, to) with the right indices; endpoints are
 *      disabled.
 *   6. Image size badge surfaces formatted byte counts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { AttachmentCarousel, formatAttachmentSize } from "../src/components/AttachmentCarousel";
import type { ComposerAttachment } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

function imageAttachment(label: string, sizeBytes?: number): ComposerAttachment {
  return {
    kind: "image",
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    label,
    mimeType: "image/png",
    sizeBytes,
  };
}

function fileAttachment(path: string): ComposerAttachment {
  return { kind: "file", path, label: path };
}

function terminalAttachment(): ComposerAttachment {
  return {
    kind: "terminal",
    paneId: "p-1",
    paneTitle: "Dev server",
    sessionName: "alpha",
  };
}

interface MountOpts {
  attachments?: ComposerAttachment[];
  withReorder?: boolean;
}

function mount(opts: MountOpts = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [attachments] = createSignal<ReadonlyArray<ComposerAttachment>>(
    opts.attachments ?? [imageAttachment("hero.png", 12 * 1024), fileAttachment("src/foo.ts")],
  );
  const onRemove = vi.fn();
  const onReorder = vi.fn();
  const dispose = render(
    () => (
      <AttachmentCarousel
        attachments={attachments}
        onRemove={onRemove}
        onReorder={opts.withReorder ? onReorder : undefined}
      />
    ),
    container,
  );
  return { container, dispose, onRemove, onReorder };
}

describe("formatAttachmentSize", () => {
  it("falls back to empty for non-positive sizes", () => {
    expect(formatAttachmentSize(0)).toBe("");
    expect(formatAttachmentSize(-1)).toBe("");
  });
  it("formats bytes / KB / MB with sensible precision", () => {
    expect(formatAttachmentSize(512)).toBe("512 B");
    expect(formatAttachmentSize(12 * 1024)).toBe("12 KB");
    expect(formatAttachmentSize(2_500_000)).toBe("2.4 MB");
  });
});

describe("AttachmentCarousel", () => {
  it("renders nothing for an empty list", () => {
    const { container, dispose } = mount({ attachments: [] });
    expect(container.querySelector("[data-testid='attachment-carousel']")).toBeNull();
    dispose();
  });

  it("renders one card per attachment with its kind exposed", () => {
    const { container, dispose } = mount({
      attachments: [imageAttachment("a.png"), fileAttachment("b.ts"), terminalAttachment()],
    });
    const cards = container.querySelectorAll("[data-testid='attachment-carousel-card']");
    expect(Array.from(cards).map((c) => c.getAttribute("data-kind"))).toEqual([
      "image",
      "file",
      "terminal",
    ]);
    dispose();
  });

  it("renders the image thumbnail for image attachments", () => {
    const { container, dispose } = mount({ attachments: [imageAttachment("hero.png", 1024)] });
    const thumb = container.querySelector<HTMLImageElement>(
      "[data-testid='attachment-carousel-thumbnail']",
    );
    expect(thumb?.getAttribute("src")).toMatch(/^data:image\/png/);
    dispose();
  });

  it("renders the size badge for image attachments with sizeBytes", () => {
    const { container, dispose } = mount({ attachments: [imageAttachment("hero.png", 5 * 1024)] });
    expect(container.querySelector("[data-testid='attachment-carousel-size']")?.textContent).toBe(
      "5 KB",
    );
    dispose();
  });

  it("dispatches onRemove with the clicked index", () => {
    const { container, dispose, onRemove } = mount({
      attachments: [imageAttachment("hero.png"), fileAttachment("a.ts")],
    });
    const removes = container.querySelectorAll<HTMLButtonElement>(
      "[data-testid='attachment-carousel-remove']",
    );
    removes[1]!.click();
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(1);
    dispose();
  });

  it("hides the reorder affordance when no onReorder is supplied", () => {
    const { container, dispose } = mount();
    expect(container.querySelector("[data-testid='attachment-carousel-reorder']")).toBeNull();
    dispose();
  });

  it("dispatches reorder(from, to) and disables endpoint arrows", () => {
    const { container, dispose, onReorder } = mount({
      withReorder: true,
      attachments: [imageAttachment("a.png"), fileAttachment("b.ts"), terminalAttachment()],
    });
    const lefts = container.querySelectorAll<HTMLButtonElement>(
      "[data-testid='attachment-carousel-reorder-left']",
    );
    const rights = container.querySelectorAll<HTMLButtonElement>(
      "[data-testid='attachment-carousel-reorder-right']",
    );
    expect(lefts[0]!.disabled).toBe(true);
    expect(rights[rights.length - 1]!.disabled).toBe(true);
    rights[0]!.click();
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(0, 1);
    dispose();
  });
});
