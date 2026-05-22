import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { ContextWindowMeter } from "../src/components/ContextWindowMeter";
import type { ChatThreadUsageSummary } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountMeter(usage: ChatThreadUsageSummary | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(() => <ContextWindowMeter usage={() => usage} />, container);
  return container;
}

describe("ContextWindowMeter", () => {
  it("renders context percentage, cost, and token tooltip", () => {
    const container = mountMeter({
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheReadTokens: 500,
      cacheWriteTokens: 125,
      totalCostUsd: 0.0421,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 50_000,
    });

    expect(container.textContent).toContain("25%");
    expect(container.textContent).toContain("$0.0421");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "Input: 12,000 tokens",
    );
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain(
      "Cache write: 125 tokens",
    );
  });

  it("falls back to token counts when context window size is missing", () => {
    const container = mountMeter({
      inputTokens: 12_000,
      outputTokens: 3_000,
    });

    expect(container.textContent).toContain("↑12k ↓3k tokens");
  });

  it("renders nothing when usage is unavailable", () => {
    const container = mountMeter(null);

    expect(container.textContent).toBe("");
  });
});
