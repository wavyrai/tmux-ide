/**
 * BranchPicker — render + wire tests (G18-P1).
 *
 * The picker fetches /api/.../git/branches on open, renders one row per
 * local + remote branch with the current marked, and POSTs
 * /api/.../git/checkout on row click.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { BranchPicker } from "@/components/BranchPicker";

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonErr(body: unknown, status = 400) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/project/proj/git/branches")) {
      return jsonOk({
        local: [
          { type: "local", branch: "main", upstream: "origin/main" },
          { type: "local", branch: "feature/x", ahead: 2, behind: 0 },
        ],
        remote: [
          {
            type: "remote",
            branch: "stale-feature",
            remote: { name: "origin", url: "https://example.com/repo.git" },
          },
          // Duplicate of a local — must be filtered out.
          {
            type: "remote",
            branch: "main",
            remote: { name: "origin", url: "https://example.com/repo.git" },
          },
        ],
        remotes: [{ name: "origin", url: "https://example.com/repo.git" }],
        currentBranch: "main",
        isUnborn: false,
      });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  }) as typeof fetch;
});

describe("BranchPicker", () => {
  it("renders nothing when open=false", () => {
    const { queryByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={false} onClose={() => undefined} />
    ));
    expect(queryByTestId("branch-picker")).toBeNull();
  });

  it("lists local + remote-only branches with the current branch marked", async () => {
    const { findByTestId, queryByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={true} onClose={() => undefined} />
    ));
    await findByTestId("branch-row-main");
    // remote-only branch should appear under its own row.
    expect(queryByTestId("branch-row-stale-feature")).toBeTruthy();
    expect(queryByTestId("branch-row-stale-feature")?.getAttribute("data-group")).toBe("remote");
    // The duplicate "main" on origin must NOT add a second remote row.
    const mainRow = queryByTestId("branch-row-main")!;
    expect(mainRow.getAttribute("data-group")).toBe("local");
    expect(mainRow.getAttribute("data-current")).toBe("true");
    expect(queryByTestId("branch-row-feature/x")?.getAttribute("data-current")).toBe("false");
  });

  it("POSTs to /git/checkout on row click + calls onCheckedOut + onClose", async () => {
    let checkoutBody: unknown = null;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/project/proj/git/branches")) {
        return jsonOk({
          local: [
            { type: "local", branch: "main" },
            { type: "local", branch: "dev" },
          ],
          remote: [],
          remotes: [],
          currentBranch: "main",
          isUnborn: false,
        });
      }
      if (url.endsWith("/api/project/proj/git/checkout")) {
        checkoutBody = JSON.parse(String((init as RequestInit).body));
        return jsonOk({ ok: true, currentBranch: "dev" });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const onCheckedOut = vi.fn();
    const onClose = vi.fn();
    const { findByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={true} onClose={onClose} onCheckedOut={onCheckedOut} />
    ));

    const devRow = await findByTestId("branch-row-dev");
    fireEvent.click(devRow);

    await waitFor(() => expect(onCheckedOut).toHaveBeenCalledWith("dev"));
    expect(checkoutBody).toEqual({ branch: "dev" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("creates a tracking branch when checking out a remote-only entry", async () => {
    let checkoutBody: unknown = null;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/project/proj/git/branches")) {
        return jsonOk({
          local: [{ type: "local", branch: "main" }],
          remote: [
            {
              type: "remote",
              branch: "new-feature",
              remote: { name: "origin", url: "https://example.com/repo.git" },
            },
          ],
          remotes: [{ name: "origin", url: "https://example.com/repo.git" }],
          currentBranch: "main",
          isUnborn: false,
        });
      }
      if (url.endsWith("/api/project/proj/git/checkout")) {
        checkoutBody = JSON.parse(String((init as RequestInit).body));
        return jsonOk({ ok: true, currentBranch: "new-feature" });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={true} onClose={() => undefined} />
    ));
    fireEvent.click(await findByTestId("branch-row-new-feature"));
    await waitFor(() => expect(checkoutBody).toEqual({ branch: "new-feature", create: true }));
  });

  it("surfaces tagged daemon errors as readable text", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/project/proj/git/branches")) {
        return jsonOk({
          local: [
            { type: "local", branch: "main" },
            { type: "local", branch: "dev" },
          ],
          remote: [],
          remotes: [],
          currentBranch: "main",
          isUnborn: false,
        });
      }
      if (url.endsWith("/api/project/proj/git/checkout")) {
        return jsonErr({
          error: {
            type: "uncommitted_changes",
            message: "Your local changes would be overwritten",
          },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={true} onClose={() => undefined} />
    ));
    fireEvent.click(await findByTestId("branch-row-dev"));
    const banner = await findByTestId("branch-picker-error");
    expect(banner.textContent).toMatch(/Commit or stash your changes/i);
  });

  it("filters rows by the search input", async () => {
    const { findByTestId, queryByTestId } = render(() => (
      <BranchPicker sessionName="proj" open={true} onClose={() => undefined} />
    ));
    const search = await findByTestId("branch-picker-search");
    await findByTestId("branch-row-main");
    fireEvent.input(search, { target: { value: "feature" } });
    await waitFor(() => {
      expect(queryByTestId("branch-row-main")).toBeNull();
    });
    expect(queryByTestId("branch-row-feature/x")).toBeTruthy();
    expect(queryByTestId("branch-row-stale-feature")).toBeTruthy();
  });
});
