/**
 * Contracts test for the virtualized BranchPicker.
 *
 * Mocks /api/project/:name/git/branches with 1000 local branches and
 * asserts only a viewport-sized window of buttons lands in the DOM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { BranchPicker } from "@/components/BranchPicker";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/project/proj/git/branches")) {
      return new Response(
        JSON.stringify({
          local: Array.from({ length: 1000 }, (_, i) => ({
            type: "local",
            branch: `feature/branch-${i.toString().padStart(4, "0")}`,
          })),
          remote: [],
          current: "main",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe("BranchPicker virtualization", () => {
  it("renders only a viewport-sized window of rows for 1000 branches", async () => {
    const { container } = render(() => (
      <BranchPicker
        sessionName="proj"
        open={true}
        onClose={() => undefined}
        anchor={{ x: 0, y: 0 }}
      />
    ));

    await waitFor(() =>
      expect(container.querySelectorAll("[data-index]").length).toBeGreaterThan(0),
    );

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='branch-picker-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    expect(h).toBeGreaterThan(25_000);
  });
});
