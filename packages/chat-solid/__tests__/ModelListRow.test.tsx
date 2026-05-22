/**
 * Single model row inside the content panel. Covers:
 *
 *   1. Public testid contract: `provider-model-picker-option` +
 *      `data-kind` / `data-active` / `data-available` so the legacy
 *      flat-picker tests keep working when each provider is rendered
 *      as a synthetic single-model row.
 *   2. Click dispatches onSelect, and is suppressed when
 *      `available=false`.
 *   3. Favorite toggle button (when supplied) bubbles its own click
 *      without firing onSelect.
 *   4. NEW / RECOMMENDED chips and jump-label kbd render on demand.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { ModelListRow } from "../src/components/ModelListRow";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(opts: {
  isActive?: boolean;
  isFavorite?: boolean;
  showNewBadge?: boolean;
  showRecommendedBadge?: boolean;
  jumpLabel?: string | null;
  available?: boolean;
  withFavoriteHandler?: boolean;
  showProvider?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onSelect = vi.fn();
  const onToggleFavorite = vi.fn();
  const dispose = render(
    () => (
      <ModelListRow
        index={0}
        model={{ slug: "opus-4-7", name: "Claude Opus 4.7", shortName: "opus-4-7" }}
        instanceId="claude-code"
        driverKind="claude-code"
        providerDisplayName="Claude Code"
        isActive={() => opts.isActive ?? false}
        isFavorite={() => opts.isFavorite ?? false}
        showProvider={opts.showProvider ?? true}
        showNewBadge={opts.showNewBadge ?? false}
        showRecommendedBadge={opts.showRecommendedBadge ?? false}
        jumpLabel={opts.jumpLabel ?? null}
        available={opts.available ?? true}
        onSelect={onSelect}
        onToggleFavorite={opts.withFavoriteHandler === false ? undefined : onToggleFavorite}
      />
    ),
    container,
  );
  return { container, dispose, onSelect, onToggleFavorite };
}

describe("ModelListRow", () => {
  it("renders the legacy testid contract for provider-only callers", () => {
    const { container, dispose } = mount({ isActive: true });
    const row = container.querySelector<HTMLButtonElement>(
      "[data-testid='provider-model-picker-option']",
    );
    expect(row).toBeTruthy();
    expect(row!.getAttribute("data-kind")).toBe("claude-code");
    expect(row!.getAttribute("data-active")).toBe("true");
    expect(row!.getAttribute("data-available")).toBe("true");
    dispose();
  });

  it("dispatches onSelect on click", () => {
    const { container, dispose, onSelect } = mount({});
    const row = container.querySelector<HTMLButtonElement>(
      "[data-testid='provider-model-picker-option']",
    );
    row!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("suppresses click and reports data-available='false' when unavailable", () => {
    const { container, dispose, onSelect } = mount({ available: false });
    const row = container.querySelector<HTMLButtonElement>(
      "[data-testid='provider-model-picker-option']",
    );
    expect(row!.getAttribute("data-available")).toBe("false");
    row!.click();
    expect(onSelect).not.toHaveBeenCalled();
    dispose();
  });

  it("renders the favorite affordance and forwards clicks without firing onSelect", () => {
    const { container, dispose, onSelect, onToggleFavorite } = mount({
      withFavoriteHandler: true,
    });
    const fav = container.querySelector<HTMLElement>("[data-testid='model-list-row-favorite']");
    expect(fav).toBeTruthy();
    fav!.click();
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    dispose();
  });

  it("omits the favorite affordance when no handler is supplied", () => {
    const { container, dispose } = mount({ withFavoriteHandler: false });
    expect(container.querySelector("[data-testid='model-list-row-favorite']")).toBeNull();
    dispose();
  });

  it("renders NEW + RECOMMENDED chips on demand", () => {
    const { container, dispose } = mount({
      showNewBadge: true,
      showRecommendedBadge: true,
    });
    expect(container.querySelector("[data-testid='model-list-row-new-badge']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='model-list-row-recommended-badge']"),
    ).toBeTruthy();
    dispose();
  });

  it("renders the jump-label kbd when supplied", () => {
    const { container, dispose } = mount({ jumpLabel: "⌘1" });
    const label = container.querySelector("[data-testid='model-list-row-jump-label']");
    expect(label?.textContent).toBe("⌘1");
    dispose();
  });

  it("hides the provider footer when showProvider=false", () => {
    const { container, dispose } = mount({ showProvider: false });
    expect(container.textContent).not.toContain("Claude Code");
    dispose();
  });
});
