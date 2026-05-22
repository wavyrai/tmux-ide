/**
 * Contracts test for the virtualized UnifiedDiff / SplitDiff in
 * Changes.tsx. Mocks the diff fetch with a 5000-line patch and
 * asserts only a viewport-sized window of `[data-index]` rows lives
 * in the DOM while the spacer reports >75000px (5000 × ~17px).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChangesView } from "../src/widgets/Changes";
import type { BaseMountOptions } from "../src/types";

const originalFetch = globalThis.fetch;

function bigPatch(lines: number): string {
  const header = ["diff --git a/big.ts b/big.ts", `@@ -1,1 +1,${lines} @@`].join("\n");
  return header + "\n" + Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");
}

beforeEach(() => {
  const patch = bigPatch(5000);
  const summary = {
    diff: patch,
    files: [{ file: "big.ts", additions: 5000, deletions: 0 }],
  };
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/\/api\/project\/[^/]+\/diff\/.+$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify({ diff: patch }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (/\/api\/project\/[^/]+\/diff$/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify(summary), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
});

describe("Changes diff virtualization", () => {
  it("renders only a viewport-sized window of unified-diff lines for a 5000-line patch", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [options] = createSignal<BaseMountOptions>({
      sessionName: "test",
      apiBaseUrl: "",
      bearerToken: null,
    });
    const dispose = render(() => <ChangesView options={options} />, container);

    // Let the summary fetch resolve, then the per-file fetch resolve.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 50));

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(300);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='v2-changes-unified-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 5000+ lines × 17px = ~85000px.
    expect(h).toBeGreaterThan(75_000);

    dispose();
  });
});
