import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  ComposerBannerStack,
  type ComposerBannerItem,
} from "../src/components/ComposerBannerStack";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(items: () => ReadonlyArray<ComposerBannerItem>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(() => <ComposerBannerStack items={items} />, container);
  return container;
}

describe("ComposerBannerStack", () => {
  it("renders nothing when items is empty", () => {
    const container = mount(() => []);
    expect(container.querySelector("[data-testid='composer-banner-stack']")).toBeNull();
  });

  it("renders the first item with chrome and no cap when only one", () => {
    const container = mount(() => [
      {
        id: "plan",
        variant: "info",
        title: "Plan ready",
        description: "Review plan A",
      },
    ]);
    const stack = container.querySelector("[data-testid='composer-banner-stack']");
    expect(stack).not.toBeNull();
    const card = container.querySelector("[data-testid='composer-banner-plan']");
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-variant")).toBe("info");
    expect(card?.textContent).toContain("Plan ready");
    expect(card?.textContent).toContain("Review plan A");
    expect(container.querySelector("[data-testid='composer-banner-stack-cap']")).toBeNull();
  });

  it("renders a stack cap when there are more banners", () => {
    const container = mount(() => [
      { id: "a", variant: "info", title: "A" },
      { id: "b", variant: "warning", title: "B" },
      { id: "c", variant: "error", title: "C" },
    ]);
    expect(container.querySelector("[data-testid='composer-banner-a']")).not.toBeNull();
    // Front item only; rest are collapsed.
    expect(container.querySelector("[data-testid='composer-banner-b']")).toBeNull();
    expect(container.querySelector("[data-testid='composer-banner-c']")).toBeNull();
    const cap = container.querySelector("[data-testid='composer-banner-stack-cap']");
    expect(cap?.textContent).toContain("+2 more banners");
  });

  it("dismiss button calls the item's onDismiss", () => {
    const onDismiss = vi.fn();
    const container = mount(() => [
      { id: "x", variant: "info", title: "X", onDismiss },
    ]);
    const btn = container.querySelector(
      "[data-testid='composer-banner-x-dismiss']",
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("updates when the items signal changes", () => {
    const [items, setItems] = createSignal<ReadonlyArray<ComposerBannerItem>>([
      { id: "a", variant: "info", title: "First" },
    ]);
    const container = mount(items);
    expect(container.querySelector("[data-testid='composer-banner-a']")).not.toBeNull();
    setItems([{ id: "b", variant: "warning", title: "Second" }]);
    expect(container.querySelector("[data-testid='composer-banner-a']")).toBeNull();
    expect(container.querySelector("[data-testid='composer-banner-b']")).not.toBeNull();
  });
});
