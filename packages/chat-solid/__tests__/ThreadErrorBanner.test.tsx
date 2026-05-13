import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ThreadErrorBanner, type ThreadError } from "../src/components/ThreadErrorBanner";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(initial: ThreadError | null, onDismiss?: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [error, setError] = createSignal<ThreadError | null>(initial);
  render(() => <ThreadErrorBanner error={error} onDismiss={onDismiss} />, container);
  return { container, setError };
}

describe("ThreadErrorBanner", () => {
  it("renders nothing when error is null", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="thread-error-banner"]')).toBeNull();
  });

  it("renders the error message when error is set", () => {
    const { container } = mount({ message: "Failed to send: connection refused" });
    const banner = container.querySelector('[data-testid="thread-error-banner"]');
    expect(banner).toBeTruthy();
    expect(
      container.querySelector('[data-testid="thread-error-banner-message"]')?.textContent,
    ).toContain("connection refused");
  });

  it("hides the Details toggle when no stack is provided", () => {
    const { container } = mount({ message: "boom" });
    expect(container.querySelector('[data-testid="thread-error-banner-toggle"]')).toBeNull();
    expect(container.querySelector('[data-testid="thread-error-banner-stack"]')).toBeNull();
  });

  it("toggles the stack trace when Details is clicked", () => {
    const { container } = mount({
      message: "boom",
      stack: "Error: boom\n    at fetch (api.ts:138:9)",
    });
    const toggle = container.querySelector(
      '[data-testid="thread-error-banner-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(container.querySelector('[data-testid="thread-error-banner-stack"]')).toBeNull();

    toggle.click();
    expect(
      container.querySelector('[data-testid="thread-error-banner-stack"]')?.textContent,
    ).toContain("fetch (api.ts:138:9)");

    toggle.click();
    expect(container.querySelector('[data-testid="thread-error-banner-stack"]')).toBeNull();
  });

  it("fires onDismiss when the × button is clicked", () => {
    const onDismiss = vi.fn();
    const { container } = mount({ message: "boom" }, onDismiss);
    const dismiss = container.querySelector(
      '[data-testid="thread-error-banner-dismiss"]',
    ) as HTMLButtonElement;
    expect(dismiss).toBeTruthy();
    dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides the dismiss button when onDismiss is omitted (read-only mode)", () => {
    const { container } = mount({ message: "boom" });
    expect(container.querySelector('[data-testid="thread-error-banner-dismiss"]')).toBeNull();
  });

  it("re-renders when the error signal changes", () => {
    const { container, setError } = mount(null);
    expect(container.querySelector('[data-testid="thread-error-banner"]')).toBeNull();
    setError({ message: "now broken" });
    expect(
      container.querySelector('[data-testid="thread-error-banner-message"]')?.textContent,
    ).toContain("now broken");
  });
});
