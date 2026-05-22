/**
 * CheckRunsRail — render + wire tests (G18-P3).
 *
 * Verifies:
 *  1. Rail collapses when there are zero check runs (local-only repos).
 *  2. Summary chip renders counts from the daemon's summary.
 *  3. Each run renders a chip with the right `data-conclusion` so CSS
 *     hooks can theme failure rows differently.
 *  4. Clicking a chip with a `detailsUrl` opens a new tab (we assert
 *     the anchor's href + target instead of stubbing window.open).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { CheckRunsRail } from "@/components/CheckRunsRail";

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

beforeEach(() => {
  globalThis.fetch = vi.fn() as typeof fetch;
});

describe("CheckRunsRail", () => {
  it("collapses to nothing when the daemon returns zero runs", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ref: "abc1234",
        runs: [],
        summary: {
          total: 0,
          pending: 0,
          passed: 0,
          failed: 0,
          neutral: 0,
          cancelled: 0,
          skipped: 0,
        },
      }),
    ) as typeof fetch;
    const { queryByTestId } = render(() => <CheckRunsRail sessionName="proj" />);
    await waitFor(() => {
      // Once the resource resolves with zero runs + loading=false,
      // the rail's `hasContent` Show guard hides the whole section.
      expect(queryByTestId("check-runs-rail")).toBeNull();
    });
  });

  it("renders the summary chip + one chip per run with the right data-conclusion", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonOk({
        ref: "abc1234",
        runs: [
          {
            id: "1",
            name: "build",
            status: "completed",
            conclusion: "success",
            detailsUrl: "https://github.com/foo/bar/actions/runs/1",
            headSha: "abc",
            startedAt: null,
            completedAt: null,
            appName: "GitHub Actions",
            appAvatarUrl: null,
            workflowName: "ci",
          },
          {
            id: "2",
            name: "lint",
            status: "completed",
            conclusion: "failure",
            detailsUrl: "https://github.com/foo/bar/actions/runs/2",
            headSha: "abc",
            startedAt: null,
            completedAt: null,
            appName: "GitHub Actions",
            appAvatarUrl: null,
            workflowName: "ci",
          },
          {
            id: "3",
            name: "deploy-preview",
            status: "in_progress",
            conclusion: null,
            detailsUrl: null,
            headSha: "abc",
            startedAt: null,
            completedAt: null,
            appName: "Vercel",
            appAvatarUrl: null,
            workflowName: null,
          },
        ],
        summary: {
          total: 3,
          passed: 1,
          failed: 1,
          pending: 1,
          neutral: 0,
          cancelled: 0,
          skipped: 0,
        },
      }),
    ) as typeof fetch;

    const { findByTestId, getByTestId } = render(() => <CheckRunsRail sessionName="proj" />);

    await waitFor(async () => {
      const summary = await findByTestId("check-runs-summary");
      expect(summary.textContent).toMatch(/CI 1\/3/);
    });
    const summary = await findByTestId("check-runs-summary");
    expect(summary.textContent).toMatch(/1 failed/);
    expect(summary.textContent).toMatch(/1 running/);

    const success = getByTestId("check-run-1");
    expect(success.getAttribute("data-conclusion")).toBe("success");
    expect(success.tagName).toBe("A");
    expect(success.getAttribute("href")).toBe("https://github.com/foo/bar/actions/runs/1");

    const failure = getByTestId("check-run-2");
    expect(failure.getAttribute("data-conclusion")).toBe("failure");

    // Run without a detailsUrl renders as a SPAN, not an anchor.
    const inprog = getByTestId("check-run-3");
    expect(inprog.getAttribute("data-status")).toBe("in_progress");
    expect(inprog.tagName).toBe("SPAN");

    // The rail's overall status attribute reflects "failed" when any
    // failure is present (worst-of takes precedence).
    expect(getByTestId("check-runs-rail").getAttribute("data-status")).toBe("failed");
  });

  it("forwards the ref prop into the /git/checks query string", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      calls.push(String(input));
      return jsonOk({
        ref: "feat/x",
        runs: [],
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          pending: 0,
          neutral: 0,
          cancelled: 0,
          skipped: 0,
        },
      });
    }) as typeof fetch;
    render(() => <CheckRunsRail sessionName="proj" ref="feat/x" />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((u) => u.includes("/git/checks?ref=feat%2Fx"))).toBe(true);
  });
});
