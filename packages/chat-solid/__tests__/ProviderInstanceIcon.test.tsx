/**
 * Glyph for known driver kinds, initials for everything else.
 * Tests pin the initials helper + the status-dot gate so a future
 * driver-kind addition has obvious test scaffolding to extend.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import {
  ProviderInstanceIcon,
  providerInstanceInitials,
} from "../src/components/ProviderInstanceIcon";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("providerInstanceInitials", () => {
  it("returns the first two letters of a one-word name", () => {
    expect(providerInstanceInitials("Codex")).toBe("CO");
  });

  it("returns the initials of a multi-word name", () => {
    expect(providerInstanceInitials("Codex Personal")).toBe("CP");
  });

  it("normalizes underscores / hyphens to word boundaries", () => {
    expect(providerInstanceInitials("codex_personal")).toBe("CP");
    expect(providerInstanceInitials("github-copilot")).toBe("GC");
  });

  it("returns empty string for whitespace-only labels", () => {
    expect(providerInstanceInitials("   ")).toBe("");
  });
});

describe("ProviderInstanceIcon", () => {
  it("renders the driver-kind glyph for built-in kinds", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => <ProviderInstanceIcon driverKind="claude-code" displayName="Claude Code" />,
      container,
    );
    const icon = container.querySelector("[data-testid='provider-instance-icon']");
    expect(icon?.getAttribute("data-driver-kind")).toBe("claude-code");
    expect(icon?.textContent).toContain("⌁");
  });

  it("falls back to initials for unknown driver kinds", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => <ProviderInstanceIcon driverKind="copilot" displayName="Github Copilot" />,
      container,
    );
    const icon = container.querySelector("[data-testid='provider-instance-icon']");
    expect(icon?.textContent).toContain("GC");
  });

  it("renders a status dot when status is supplied", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => <ProviderInstanceIcon driverKind="codex" displayName="Codex" status="warning" />,
      container,
    );
    expect(container.querySelector("[data-testid='provider-instance-status-dot']")).toBeTruthy();
  });

  it("omits the status dot when no status is supplied", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <ProviderInstanceIcon driverKind="codex" displayName="Codex" />, container);
    expect(container.querySelector("[data-testid='provider-instance-status-dot']")).toBeNull();
  });
});
