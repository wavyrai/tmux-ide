/**
 * Sidebar rail — vertical instance picker. Tests cover:
 *
 *   1. Each configured instance renders one rail button keyed on
 *      `instanceId`.
 *   2. The active rail item gets `data-selected="true"`; clicking a
 *      sibling fires `onSelectInstance` with its id.
 *   3. Unavailable instances render disabled and ignore clicks.
 *   4. Favorites + coming-soon entries gate on their respective
 *      props.
 *   5. The "new" badge respects `newBadgeInstanceIds`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ModelPickerSidebar,
  type ProviderInstanceSummary,
} from "../src/components/ModelPickerSidebar";

afterEach(() => {
  document.body.innerHTML = "";
});

const claude: ProviderInstanceSummary = {
  instanceId: "claude-code",
  driverKind: "claude-code",
  displayName: "Claude Code",
  available: true,
  status: "ready",
};

const codex: ProviderInstanceSummary = {
  instanceId: "codex",
  driverKind: "codex",
  displayName: "Codex",
  available: true,
  status: "ready",
};

const gemini: ProviderInstanceSummary = {
  instanceId: "gemini",
  driverKind: "gemini",
  displayName: "Gemini",
  available: false,
  status: "error",
  error: "binary not on PATH",
};

function mount(
  opts: {
    selected?: string | "favorites";
    instances?: ProviderInstanceSummary[];
    showFavorites?: boolean;
    showComingSoon?: boolean;
    comingSoon?: Array<{ id: string; driverKind: string; label: string }>;
    newBadge?: ReadonlySet<string>;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [selected] = createSignal<string | "favorites">(opts.selected ?? "favorites");
  const [instances] = createSignal(opts.instances ?? [claude, codex, gemini]);
  const [comingSoon] = createSignal(opts.comingSoon ?? []);
  const [newBadge] = createSignal<ReadonlySet<string>>(opts.newBadge ?? new Set());
  const onSelectInstance = vi.fn();
  const dispose = render(
    () => (
      <ModelPickerSidebar
        selectedInstanceId={selected}
        instances={instances}
        onSelectInstance={onSelectInstance}
        showFavorites={opts.showFavorites ?? true}
        showComingSoon={opts.showComingSoon ?? false}
        comingSoonEntries={comingSoon}
        newBadgeInstanceIds={newBadge}
      />
    ),
    container,
  );
  return { container, dispose, onSelectInstance };
}

describe("ModelPickerSidebar", () => {
  it("renders one rail button per instance", () => {
    const { container, dispose } = mount();
    const items = container.querySelectorAll("[data-testid='model-picker-sidebar-instance']");
    expect(items.length).toBe(3);
    dispose();
  });

  it("marks the active rail item with data-selected='true'", () => {
    const { container, dispose } = mount({ selected: "codex" });
    const active = container.querySelector(
      "[data-testid='model-picker-sidebar-instance'][data-selected='true']",
    );
    expect(active?.getAttribute("data-instance-id")).toBe("codex");
    dispose();
  });

  it("fires onSelectInstance with the clicked rail id", () => {
    const { container, dispose, onSelectInstance } = mount({ selected: "claude-code" });
    const codexRail = container.querySelector<HTMLButtonElement>(
      "[data-testid='model-picker-sidebar-instance'][data-instance-id='codex']",
    );
    codexRail!.click();
    expect(onSelectInstance).toHaveBeenCalledExactlyOnceWith("codex");
    dispose();
  });

  it("disables and ignores clicks on unavailable instances", () => {
    const { container, dispose, onSelectInstance } = mount();
    const geminiRail = container.querySelector<HTMLButtonElement>(
      "[data-testid='model-picker-sidebar-instance'][data-instance-id='gemini']",
    );
    expect(geminiRail!.disabled).toBe(true);
    expect(geminiRail!.getAttribute("data-available")).toBe("false");
    geminiRail!.click();
    expect(onSelectInstance).not.toHaveBeenCalled();
    dispose();
  });

  it("renders the favorites rail when showFavorites=true", () => {
    const { container, dispose } = mount({ showFavorites: true });
    expect(container.querySelector("[data-testid='model-picker-sidebar-favorites']")).toBeTruthy();
    dispose();
  });

  it("hides the favorites rail when showFavorites=false", () => {
    const { container, dispose } = mount({ showFavorites: false });
    expect(container.querySelector("[data-testid='model-picker-sidebar-favorites']")).toBeNull();
    dispose();
  });

  it("renders coming-soon entries when both flag and entries are set", () => {
    const { container, dispose } = mount({
      showComingSoon: true,
      comingSoon: [{ id: "copilot-soon", driverKind: "copilot", label: "Copilot" }],
    });
    expect(
      container.querySelector("[data-testid='model-picker-sidebar-coming-soon']"),
    ).toBeTruthy();
    dispose();
  });

  it("flags instances listed in newBadgeInstanceIds", () => {
    const { container, dispose } = mount({ newBadge: new Set(["codex"]) });
    const codexRail = container.querySelector(
      "[data-testid='model-picker-sidebar-instance'][data-instance-id='codex']",
    );
    expect(codexRail?.getAttribute("data-new")).toBe("true");
    expect(container.querySelector("[data-testid='model-picker-sidebar-new-badge']")).toBeTruthy();
    dispose();
  });
});
