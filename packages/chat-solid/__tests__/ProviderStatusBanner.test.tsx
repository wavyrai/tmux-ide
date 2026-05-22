import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ProviderStatusBanner } from "../src/components/ProviderStatusBanner";
import type { ApiRuntime, ProviderInfo } from "../src/api";

const originalFetch = globalThis.fetch;

function mockProviders(providers: ProviderInfo[]) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ providers }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
}

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  vi.useFakeTimers();
});

const RUNTIME: ApiRuntime = { apiBaseUrl: "", bearerToken: null };

function mount(opts: {
  providers: ProviderInfo[];
  activeKind: string | null;
  onSwitch?: (next: { kind: string }) => void;
}): HTMLDivElement {
  mockProviders(opts.providers);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [runtime] = createSignal<ApiRuntime>(RUNTIME);
  const [activeKind] = createSignal<string | null>(opts.activeKind);
  render(
    () => (
      <ProviderStatusBanner
        runtime={runtime}
        activeProviderKind={activeKind as unknown as () => never}
        // Disable timer-driven polling for deterministic tests; the
        // resource's first fetch still runs on mount.
        pollIntervalMs={0}
        onSwitch={opts.onSwitch as never}
      />
    ),
    container,
  );
  return container;
}

async function flush() {
  await vi.runAllTimersAsync();
  // microtask flush so createResource's fetch promise resolves
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderStatusBanner", () => {
  it("renders nothing when the active provider is available", async () => {
    const container = mount({
      providers: [{ kind: "claude-code", name: "Claude Code", description: "", available: true }],
      activeKind: "claude-code",
    });
    await flush();
    expect(container.querySelector('[data-testid="provider-status-banner"]')).toBeNull();
  });

  it("renders the banner when the active provider is unavailable", async () => {
    const container = mount({
      providers: [
        {
          kind: "claude-code",
          name: "Claude Code",
          description: "Anthropic",
          available: false,
          error: "binary not on PATH",
        },
      ],
      activeKind: "claude-code",
    });
    await flush();
    const banner = container.querySelector('[data-testid="provider-status-banner"]');
    expect(banner).toBeTruthy();
    expect(
      container.querySelector('[data-testid="provider-status-banner-title"]')?.textContent,
    ).toContain("Claude Code");
  });

  it("renders nothing when no thread/active provider is set", async () => {
    const container = mount({
      providers: [{ kind: "claude-code", name: "Claude Code", description: "", available: false }],
      activeKind: null,
    });
    await flush();
    expect(container.querySelector('[data-testid="provider-status-banner"]')).toBeNull();
  });

  it("offers a retry button that re-fetches providers", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            providers: [
              {
                kind: "claude-code",
                name: "Claude Code",
                description: "",
                available: false,
                error: "still not on PATH",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    globalThis.fetch = fetchSpy as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [runtime] = createSignal<ApiRuntime>(RUNTIME);
    const [activeKind] = createSignal<string | null>("claude-code");
    render(
      () => (
        <ProviderStatusBanner
          runtime={runtime}
          activeProviderKind={activeKind as unknown as () => never}
          pollIntervalMs={0}
        />
      ),
      container,
    );
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const retry = container.querySelector(
      '[data-testid="provider-status-banner-retry"]',
    ) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    retry.click();
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("renders 'switch to' chips for the OTHER available providers and fires onSwitch", async () => {
    const onSwitch = vi.fn();
    const container = mount({
      providers: [
        {
          kind: "claude-code",
          name: "Claude Code",
          description: "",
          available: false,
          error: "x",
        },
        { kind: "codex", name: "Codex", description: "", available: true },
        { kind: "gemini", name: "Gemini", description: "", available: true },
      ],
      activeKind: "claude-code",
      onSwitch,
    });
    await flush();
    const chips = container.querySelectorAll('[data-testid="provider-status-banner-switch"]');
    expect(chips.length).toBe(2);
    (chips[0] as HTMLButtonElement).click();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][0]).toMatchObject({ kind: "codex" });
  });
});
