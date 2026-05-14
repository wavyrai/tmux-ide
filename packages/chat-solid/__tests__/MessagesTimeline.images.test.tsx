/**
 * W3 — Inline image rendering in the chat transcript.
 *
 * These tests cover the wire from a user message containing an `image`
 * content block all the way to the single `ExpandedImageDialog` mount
 * at the `MessagesTimeline` root:
 *
 *   1. Placeholder renders before IntersectionObserver fires (lazy).
 *   2. After IO reports intersection, the `<img>` materializes with
 *      the expected `data:` URL.
 *   3. Clicking the thumbnail opens the fullscreen dialog with a
 *      cursor that includes every image in the message and is
 *      anchored at the clicked one.
 *
 * The IntersectionObserver mock matches the shape used by
 * `ExpandedImagePreview.test.tsx` so the lazy-load gating behaves
 * deterministically in jsdom.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow } from "../src/types";

let observers: Array<{
  callback: IntersectionObserverCallback;
  observed: Element[];
}> = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    observers.push({ callback: cb, observed: this.observed });
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.observed.length = 0;
  }
  unobserve() {
    /* noop */
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  observers = [];
  (
    globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }
  ).IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function userImageMessage(
  id: string,
  images: Array<{ data: string; mimeType: string }>,
): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-05-13T08:00:00.000Z",
    content: images.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    })),
  };
}

function row(message: ChatMessage): MessagesTimelineRow {
  return { kind: "message", id: message.id, createdAt: message.createdAt, message };
}

function mountTimeline(initialRows: MessagesTimelineRow[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [rows] = createSignal<MessagesTimelineRow[]>(initialRows);
  const [messages] = createSignal([]);
  const dispose = render(
    () => <MessagesTimeline rows={rows} messages={messages} providerName={() => "Claude"} />,
    container,
  );
  return { container, dispose };
}

describe("MessagesTimeline image content blocks (W3)", () => {
  it("renders a lazy placeholder before IntersectionObserver fires", () => {
    const message = userImageMessage("u1", [{ data: "AAAA", mimeType: "image/png" }]);
    const { container, dispose } = mountTimeline([row(message)]);

    const wrapper = container.querySelector('[data-testid="user-image-block"]');
    expect(wrapper).toBeTruthy();
    const preview = wrapper!.querySelector('[data-testid="inline-image-preview"]');
    expect(preview?.getAttribute("data-loaded")).toBe("false");
    expect(
      container.querySelector('[data-testid="inline-image-preview-placeholder"]'),
    ).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();

    dispose();
  });

  it("renders the <img> with a data: URL after IO intersection", () => {
    const message = userImageMessage("u2", [{ data: "BBBB", mimeType: "image/jpeg" }]);
    const { container, dispose } = mountTimeline([row(message)]);

    // MessagesTimeline also spawns an IntersectionObserver for its
    // auto-scroll sentinel. Find the one watching the inline-image
    // preview button (carries `data-testid="inline-image-preview"`).
    const previewButton = container.querySelector('[data-testid="inline-image-preview"]');
    expect(previewButton).toBeTruthy();
    const imageObserver = observers.find((o) => o.observed.includes(previewButton!));
    expect(imageObserver).toBeTruthy();
    imageObserver!.callback(
      [{ isIntersecting: true, target: previewButton! } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
    expect(
      container.querySelector('[data-testid="inline-image-preview"]')?.getAttribute("data-loaded"),
    ).toBe("true");

    dispose();
  });

  it("opens the fullscreen dialog with the clicked image as the anchor", () => {
    const message = userImageMessage("u3", [
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/png" },
      { data: "CCCC", mimeType: "image/png" },
    ]);
    const { container, dispose } = mountTimeline([row(message)]);

    // Sanity: three thumbnails rendered, no dialog yet.
    const thumbs = container.querySelectorAll('[data-testid="inline-image-preview"]');
    expect(thumbs.length).toBe(3);
    expect(document.querySelector('[data-testid="expanded-image-dialog"]')).toBeNull();

    // Click the middle thumbnail.
    (thumbs[1] as HTMLButtonElement).click();

    const dialog = document.querySelector('[data-testid="expanded-image-dialog"]');
    expect(dialog).toBeTruthy();
    const image = dialog!.querySelector(
      '[data-testid="expanded-image-dialog-image"]',
    ) as HTMLImageElement | null;
    expect(image).toBeTruthy();
    expect(image!.getAttribute("src")).toBe("data:image/png;base64,BBBB");

    // ←/→ navigators present because the message has 3 images.
    expect(document.querySelector('[data-testid="expanded-image-dialog-prev"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="expanded-image-dialog-next"]')).toBeTruthy();

    dispose();
  });

  it("renders a 'unavailable' fallback when the image block has no data", () => {
    const message = userImageMessage("u4", [{ data: "", mimeType: "image/png" }]);
    const { container, dispose } = mountTimeline([row(message)]);

    expect(container.querySelector('[data-testid="user-image-block-missing"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="user-image-block"]')).toBeNull();

    dispose();
  });
});
