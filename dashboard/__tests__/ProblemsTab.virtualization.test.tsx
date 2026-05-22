/**
 * Contracts test for the virtualized ProblemsTab.
 *
 * Seeds diagnosticsState with a 1000-row diagnostic payload and
 * asserts only a viewport-sized window of rows renders.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { ProblemsTab } from "@/components/v2/ProblemsTab";
import { diagnosticsState, setDiagnosticsForBuffer } from "@/lib/lsp/diagnostics-store";
import type { LspDiagnostic } from "@/lib/lsp/api";

function diag(i: number): LspDiagnostic {
  return {
    message: `problem ${i}`,
    severity: ((i % 4) + 1) as 1 | 2 | 3 | 4,
    range: {
      start: { line: i, character: 0 },
      end: { line: i, character: 1 },
    },
  };
}

beforeEach(() => {
  // Clear all known buffers from previous tests.
  for (const uri of Object.keys(diagnosticsState.byBuffer)) {
    setDiagnosticsForBuffer({
      bufferUri: uri,
      sessionName: "test",
      rootPath: "/",
      filePath: "test.ts",
      language: "typescript",
      diagnostics: [],
      fetchedAt: Date.now(),
    });
  }
});

afterEach(() => {
  cleanup();
});

describe("ProblemsTab virtualization", () => {
  it("renders only a viewport-sized window of rows for 1000 diagnostics", async () => {
    setDiagnosticsForBuffer({
      bufferUri: "file:///big.ts",
      sessionName: "test",
      rootPath: "/",
      filePath: "src/big.ts",
      language: "typescript",
      diagnostics: Array.from({ length: 1000 }, (_, i) => diag(i)),
      fetchedAt: Date.now(),
    });

    const { container } = render(() => <ProblemsTab />);

    await waitFor(() =>
      expect(container.querySelectorAll("[data-index]").length).toBeGreaterThan(0),
    );

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>("[data-testid='v2-problems-spacer']");
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 × at least 44px = 44000px.
    expect(h).toBeGreaterThan(40_000);
  });
});
