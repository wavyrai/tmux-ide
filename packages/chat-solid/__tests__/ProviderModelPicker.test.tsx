import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ProviderModelPicker } from "../src/components/ProviderModelPicker";
import type { ProviderInfo } from "../src/api";
import type { AgentProvider } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

const CLAUDE: ProviderInfo = {
  kind: "claude-code",
  name: "Claude Code",
  description: "Anthropic Claude",
  available: true,
  version: "1.0.0",
};
const CODEX: ProviderInfo = {
  kind: "codex",
  name: "Codex",
  description: "OpenAI Codex",
  available: true,
};
const GEMINI: ProviderInfo = {
  kind: "gemini",
  name: "Gemini",
  description: "Google Gemini",
  available: false,
  error: "binary not on PATH",
};

function mount(opts: {
  provider?: AgentProvider | null;
  available?: ProviderInfo[];
  onChange?: (next: AgentProvider) => void;
  disabled?: boolean;
}): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [provider] = createSignal<AgentProvider | null>(opts.provider ?? null);
  const [available] = createSignal<ProviderInfo[]>(opts.available ?? []);
  const [disabled] = createSignal<boolean>(opts.disabled ?? false);
  render(
    () => (
      <ProviderModelPicker
        provider={provider}
        availableProviders={available}
        onChange={opts.onChange}
        disabled={disabled}
      />
    ),
    container,
  );
  return container;
}

describe("ProviderModelPicker", () => {
  it("renders the active provider's label on the trigger", () => {
    const container = mount({ provider: { kind: "claude-code" } });
    const trigger = container.querySelector('[data-testid="provider-model-picker-trigger"]');
    expect(trigger?.textContent).toContain("Claude Code");
  });

  it("opens the dropdown on trigger click and lists all available providers", () => {
    const container = mount({
      provider: { kind: "claude-code" },
      available: [CLAUDE, CODEX, GEMINI],
    });
    const trigger = container.querySelector(
      '[data-testid="provider-model-picker-trigger"]',
    ) as HTMLButtonElement;
    expect(container.querySelector('[data-testid="provider-model-picker-menu"]')).toBeNull();
    trigger.click();
    const menu = container.querySelector('[data-testid="provider-model-picker-menu"]');
    expect(menu).toBeTruthy();
    const options = container.querySelectorAll('[data-testid="provider-model-picker-option"]');
    expect(options.length).toBe(3);
    expect(
      Array.from(options).map((o) => o.getAttribute("data-kind")),
    ).toEqual(["claude-code", "codex", "gemini"]);
  });

  it("marks the active option with data-active='true'", () => {
    const container = mount({
      provider: { kind: "codex" },
      available: [CLAUDE, CODEX],
    });
    (container.querySelector('[data-testid="provider-model-picker-trigger"]') as HTMLElement).click();
    const active = container.querySelector(
      '[data-testid="provider-model-picker-option"][data-active="true"]',
    );
    expect(active?.getAttribute("data-kind")).toBe("codex");
  });

  it("fires onChange with the picked provider when a row is clicked", () => {
    const onChange = vi.fn();
    const container = mount({
      provider: { kind: "claude-code" },
      available: [CLAUDE, CODEX],
      onChange,
    });
    (container.querySelector('[data-testid="provider-model-picker-trigger"]') as HTMLElement).click();
    const codexRow = container.querySelector(
      '[data-testid="provider-model-picker-option"][data-kind="codex"]',
    ) as HTMLButtonElement;
    codexRow.click();
    expect(onChange).toHaveBeenCalledWith({ kind: "codex" });
  });

  it("closes the menu after a selection", () => {
    const container = mount({
      provider: { kind: "claude-code" },
      available: [CLAUDE, CODEX],
      onChange: vi.fn(),
    });
    (container.querySelector('[data-testid="provider-model-picker-trigger"]') as HTMLElement).click();
    expect(container.querySelector('[data-testid="provider-model-picker-menu"]')).toBeTruthy();
    (
      container.querySelector(
        '[data-testid="provider-model-picker-option"][data-kind="codex"]',
      ) as HTMLButtonElement
    ).click();
    expect(container.querySelector('[data-testid="provider-model-picker-menu"]')).toBeNull();
  });

  it("renders the 'No providers discovered' placeholder when the list is empty", () => {
    const container = mount({ provider: { kind: "claude-code" }, available: [] });
    (container.querySelector('[data-testid="provider-model-picker-trigger"]') as HTMLElement).click();
    expect(
      container.querySelector('[data-testid="provider-model-picker-empty"]')?.textContent,
    ).toContain("No providers");
  });

  it("disables the trigger when disabled prop is true and never opens", () => {
    const onChange = vi.fn();
    const container = mount({
      provider: { kind: "claude-code" },
      available: [CLAUDE, CODEX],
      onChange,
      disabled: true,
    });
    const trigger = container.querySelector(
      '[data-testid="provider-model-picker-trigger"]',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    trigger.click();
    expect(container.querySelector('[data-testid="provider-model-picker-menu"]')).toBeNull();
  });
});
