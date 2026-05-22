/**
 * MessageCopyButton render + clipboard tests.
 *
 * Uses the `write` injection prop instead of jsdom's clipboard so the
 * tests don't depend on the happy-dom clipboard polyfill state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { MessageCopyButton } from "../src/components/MessageCopyButton";

function mount(props: Parameters<typeof MessageCopyButton>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(() => <MessageCopyButton {...props} />, container);
  return { container, dispose };
}

let mounted: { container: HTMLElement; dispose: () => void } | null = null;
afterEach(() => {
  mounted?.dispose();
  if (mounted?.container.parentNode) {
    mounted.container.parentNode.removeChild(mounted.container);
  }
  mounted = null;
});

describe("MessageCopyButton", () => {
  it("does not render when text is empty / whitespace", () => {
    mounted = mount({ text: "   " });
    expect(mounted.container.querySelector('[data-testid="message-copy-button"]')).toBeNull();

    mounted!.dispose();
    mounted = mount({ text: "" });
    expect(mounted.container.querySelector('[data-testid="message-copy-button"]')).toBeNull();
  });

  it("renders an icon button with aria-label when text is non-empty", () => {
    mounted = mount({ text: "hello" });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="message-copy-button"]',
    );
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("aria-label")).toBe("Copy message");
    expect(btn!.getAttribute("data-copied")).toBe("false");
  });

  it("calls the injected writer with the text on click and flips to `copied`", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    mounted = mount({ text: "ship it", write });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="message-copy-button"]',
    )!;
    btn.click();
    // Allow the promise resolution to flush.
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith("ship it");
    expect(btn.getAttribute("data-copied")).toBe("true");
  });

  it("flips to `error` when the writer rejects", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    mounted = mount({ text: "ship it", write });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="message-copy-button"]',
    )!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve(); // catch-branch microtask
    expect(btn.getAttribute("data-error")).toBe("true");
    expect(btn.getAttribute("data-copied")).toBe("false");
  });

  it("respects a custom aria-label", () => {
    mounted = mount({ text: "abc", ariaLabel: "Copy answer" });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="message-copy-button"]',
    )!;
    expect(btn.getAttribute("aria-label")).toBe("Copy answer");
  });
});
