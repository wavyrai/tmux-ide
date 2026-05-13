import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  buildExpandedImagePreview,
  InlineImagePreview,
} from "../src/components/ExpandedImagePreview";

let observers: Array<{
  observe: (el: Element) => void;
  disconnect: () => void;
  callback: IntersectionObserverCallback;
  observed: Element[];
}> = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    observers.push({
      observe: (el) => this.observed.push(el),
      disconnect: () => {
        this.observed.length = 0;
      },
      callback: cb,
      observed: this.observed,
    });
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
  (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
    MockIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildExpandedImagePreview", () => {
  it("returns null when no attachment is previewable (no previewUrl)", () => {
    const result = buildExpandedImagePreview(
      [{ id: "a", name: "doc.pdf" }],
      "a",
    );
    expect(result).toBeNull();
  });

  it("returns null when the selected id is not previewable", () => {
    const result = buildExpandedImagePreview(
      [
        { id: "a", name: "ok.png", previewUrl: "blob:1" },
        { id: "b", name: "doc.pdf" },
      ],
      "b",
    );
    expect(result).toBeNull();
  });

  it("anchors index at the selected image among previewable entries", () => {
    const result = buildExpandedImagePreview(
      [
        { id: "x", name: "doc.pdf" },
        { id: "a", name: "first.png", previewUrl: "blob:1" },
        { id: "b", name: "second.png", previewUrl: "blob:2", sizeBytes: 2048 },
        { id: "y", name: "doc.pdf" },
        { id: "c", name: "third.png", previewUrl: "blob:3" },
      ],
      "b",
    );
    expect(result).not.toBeNull();
    expect(result!.images.length).toBe(3); // non-previewable filtered out
    expect(result!.images.map((i) => i.name)).toEqual([
      "first.png",
      "second.png",
      "third.png",
    ]);
    expect(result!.index).toBe(1); // 'b' is the 2nd previewable
    expect(result!.images[1].sizeLabel).toBe("2.0 KB");
  });
});

describe("InlineImagePreview", () => {
  it("renders the placeholder before the IO observer fires", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [src] = createSignal("blob:x");
    const [alt] = createSignal("screenshot.png");
    render(() => <InlineImagePreview src={src} alt={alt} />, container);

    expect(container.querySelector('[data-testid="inline-image-preview-placeholder"]')).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[data-testid="inline-image-preview"]')?.getAttribute("data-loaded"),
    ).toBe("false");
  });

  it("loads the <img> after the observer reports intersection", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [src] = createSignal("blob:x");
    const [alt] = createSignal("screenshot.png");
    render(() => <InlineImagePreview src={src} alt={alt} />, container);

    const observer = observers[0];
    expect(observer).toBeTruthy();
    observer.callback(
      [
        { isIntersecting: true, target: observer.observed[0] } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:x");
    expect(
      container.querySelector('[data-testid="inline-image-preview"]')?.getAttribute("data-loaded"),
    ).toBe("true");
  });

  it("renders the <img> immediately when `eager` is set", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [src] = createSignal("blob:eager");
    const [alt] = createSignal("logo.png");
    render(() => <InlineImagePreview src={src} alt={alt} eager />, container);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:eager");
  });

  it("fires onExpand when the thumbnail is clicked", () => {
    const onExpand = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [src] = createSignal("blob:x");
    const [alt] = createSignal("a.png");
    render(
      () => <InlineImagePreview src={src} alt={alt} eager onExpand={onExpand} />,
      container,
    );
    (container.querySelector('[data-testid="inline-image-preview"]') as HTMLButtonElement).click();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("falls back to immediate render when IntersectionObserver is absent", () => {
    delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [src] = createSignal("blob:noio");
    const [alt] = createSignal("nope.png");
    render(() => <InlineImagePreview src={src} alt={alt} />, container);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:noio");
  });
});
