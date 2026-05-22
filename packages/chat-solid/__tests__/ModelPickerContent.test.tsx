/**
 * Content panel — search input + filtered model list with optional
 * sidebar. Exercises:
 *
 *   1. Provider-only mode (no modelsByInstance map): one synthetic
 *      row per instance, sidebar collapsed.
 *   2. Rich mode (modelsByInstance map): sidebar appears, list
 *      filters by selected instance.
 *   3. Search input filters across instances and disables the
 *      sidebar.
 *   4. Empty-state placeholder when no models match.
 *   5. Active row reflects the `active` accessor.
 *   6. onSelect fires with the (instanceId, slug) tuple of the
 *      clicked row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ModelPickerContent,
  type ModelPickerSelection,
} from "../src/components/ModelPickerContent";
import type { ProviderInstanceSummary } from "../src/components/ModelPickerSidebar";
import type { ModelListRowModel } from "../src/components/ModelListRow";

afterEach(() => {
  document.body.innerHTML = "";
});

const instancesFixture: ProviderInstanceSummary[] = [
  {
    instanceId: "claude-code",
    driverKind: "claude-code",
    displayName: "Claude Code",
    available: true,
    status: "ready",
  },
  {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    available: true,
    status: "ready",
  },
];

const modelsFixture = new Map<string, ReadonlyArray<ModelListRowModel>>([
  [
    "claude-code",
    [
      { slug: "claude-opus-4-7", name: "Claude Opus 4.7", shortName: "opus-4-7" },
      { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5", shortName: "haiku-4-5" },
    ],
  ],
  ["codex", [{ slug: "gpt-5-codex", name: "GPT-5 Codex", shortName: "gpt-5" }]],
]);

function mount(opts: {
  instances?: ProviderInstanceSummary[];
  models?: Map<string, ReadonlyArray<ModelListRowModel>>;
  active?: ModelPickerSelection | null;
  favorites?: ModelPickerSelection[];
  lockedDriverKind?: string | null;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [instances] = createSignal(opts.instances ?? instancesFixture);
  const [active] = createSignal(opts.active ?? null);
  const [favorites] = createSignal(opts.favorites ?? []);
  const [locked] = createSignal(opts.lockedDriverKind ?? null);
  const onSelect = vi.fn();
  const onToggleFavorite = vi.fn();
  const models = opts.models;

  const dispose = render(
    () => (
      <ModelPickerContent
        instances={instances}
        modelsByInstance={models ? () => models : undefined}
        active={active}
        favorites={favorites}
        lockedDriverKind={locked}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
      />
    ),
    container,
  );
  return { container, dispose, onSelect, onToggleFavorite };
}

describe("ModelPickerContent — provider-only mode", () => {
  it("renders one synthetic row per instance and hides the sidebar", () => {
    const { container, dispose } = mount({});
    const rows = container.querySelectorAll("[data-testid='provider-model-picker-option']");
    expect(rows.length).toBe(2);
    expect(Array.from(rows).map((row) => row.getAttribute("data-kind"))).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(container.querySelector("[data-testid='model-picker-sidebar']")).toBeNull();
    dispose();
  });

  it("dispatches onSelect with the synthetic (instanceId, slug=instanceId) tuple", () => {
    const { container, dispose, onSelect } = mount({});
    const codexRow = container.querySelector<HTMLButtonElement>(
      "[data-testid='provider-model-picker-option'][data-kind='codex']",
    );
    codexRow!.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ instanceId: "codex", slug: "codex" });
    dispose();
  });

  it("renders the empty placeholder when no instances are supplied", () => {
    const { container, dispose } = mount({ instances: [] });
    expect(container.querySelector("[data-testid='provider-model-picker-empty']")).toBeTruthy();
    dispose();
  });
});

describe("ModelPickerContent — rich mode", () => {
  it("renders the sidebar when modelsByInstance is supplied", () => {
    const { container, dispose } = mount({ models: modelsFixture });
    expect(container.querySelector("[data-testid='model-picker-sidebar']")).toBeTruthy();
    dispose();
  });

  it("filters the list to the active sidebar selection", () => {
    const { container, dispose } = mount({
      models: modelsFixture,
      active: { instanceId: "claude-code", slug: "claude-opus-4-7" },
    });
    const slugs = Array.from(
      container.querySelectorAll("[data-testid='provider-model-picker-option']"),
    ).map((row) => row.getAttribute("data-slug"));
    // Default sidebar selection lands on the first available instance
    // (claude-code) because favorites is empty.
    expect(slugs).toEqual(["claude-opus-4-7", "claude-haiku-4-5"]);
    dispose();
  });

  it("marks the active row with data-active='true'", () => {
    const { container, dispose } = mount({
      models: modelsFixture,
      active: { instanceId: "claude-code", slug: "claude-haiku-4-5" },
    });
    const active = container.querySelector(
      "[data-testid='provider-model-picker-option'][data-active='true']",
    );
    expect(active?.getAttribute("data-slug")).toBe("claude-haiku-4-5");
    dispose();
  });

  it("search filters across every instance and hides the sidebar", () => {
    const { container, dispose } = mount({ models: modelsFixture });
    const search = container.querySelector<HTMLInputElement>(
      "[data-testid='model-picker-content-search']",
    );
    search!.value = "gpt";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const rows = container.querySelectorAll("[data-testid='provider-model-picker-option']");
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute("data-kind")).toBe("codex");
    expect(container.querySelector("[data-testid='model-picker-sidebar']")).toBeNull();
    dispose();
  });

  it("renders the empty 'no models match' state on a no-result search", () => {
    const { container, dispose } = mount({ models: modelsFixture });
    const search = container.querySelector<HTMLInputElement>(
      "[data-testid='model-picker-content-search']",
    );
    search!.value = "zzz-no-match";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(container.querySelector("[data-testid='provider-model-picker-empty']")).toBeTruthy();
    dispose();
  });
});

describe("ModelPickerContent — locked", () => {
  it("filters instances to the locked driver kind", () => {
    const { container, dispose } = mount({
      models: modelsFixture,
      lockedDriverKind: "codex",
    });
    const slugs = Array.from(
      container.querySelectorAll("[data-testid='provider-model-picker-option']"),
    ).map((row) => row.getAttribute("data-slug"));
    expect(slugs).toEqual(["gpt-5-codex"]);
    dispose();
  });
});
