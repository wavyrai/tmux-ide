/**
 * CreatePrModal — wire test (G18-P2).
 *
 * Verifies the modal:
 *  1. Loads the branches list on open and picks a sensible default
 *     base ("main" or "master" when present, fallback to first).
 *  2. POSTs to /git/pr with title/body/base/head/draft.
 *  3. Surfaces gh-specific errors with intent copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { CreatePrModal } from "@/components/CreatePrModal";

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
    if (url.endsWith("/git/branches")) {
      return jsonOk({
        local: [
          { type: "local", branch: "main" },
          { type: "local", branch: "feat/x" },
        ],
        remote: [],
        remotes: [],
        currentBranch: "feat/x",
        isUnborn: false,
      });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  }) as typeof fetch;
});

describe("CreatePrModal", () => {
  it("posts the typed inputs to /git/pr and fires onCreated", async () => {
    let prBody: unknown = null;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/git/branches")) {
        return jsonOk({
          local: [
            { type: "local", branch: "main" },
            { type: "local", branch: "feat/x" },
          ],
          remote: [],
          remotes: [],
          currentBranch: "feat/x",
          isUnborn: false,
        });
      }
      if (url.endsWith("/git/pr")) {
        prBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonOk({
          ok: true,
          pr: {
            url: "https://github.com/foo/bar/pull/42",
            number: 42,
            title: "Test PR",
            base: "main",
            head: "feat/x",
            isDraft: false,
          },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const onCreated = vi.fn();
    const onClose = vi.fn();
    const { findByTestId } = render(() => (
      <CreatePrModal sessionName="proj" open={true} onClose={onClose} onCreated={onCreated} />
    ));

    // Wait for branches → default base = main.
    await waitFor(async () => {
      const sel = await findByTestId("create-pr-base");
      expect((sel as HTMLSelectElement).value).toBe("main");
    });

    fireEvent.input(await findByTestId("create-pr-title"), {
      target: { value: "Test PR" },
    });
    fireEvent.input(await findByTestId("create-pr-body"), {
      target: { value: "## What\nstuff" },
    });

    fireEvent.click(await findByTestId("create-pr-submit"));

    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith("https://github.com/foo/bar/pull/42"),
    );
    expect(prBody).toEqual({
      title: "Test PR",
      body: "## What\nstuff",
      base: "main",
      head: "feat/x",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires a title", async () => {
    const { findByTestId } = render(() => (
      <CreatePrModal sessionName="proj" open={true} onClose={() => undefined} />
    ));
    await findByTestId("create-pr-base");
    fireEvent.click(await findByTestId("create-pr-submit"));
    const err = await findByTestId("create-pr-error");
    expect(err.textContent).toMatch(/Title is required/i);
  });

  it("renders gh-unavailable copy when the daemon reports gh isn't installed", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/git/branches"))
        return jsonOk({
          local: [
            { type: "local", branch: "main" },
            { type: "local", branch: "feat/x" },
          ],
          remote: [],
          remotes: [],
          currentBranch: "feat/x",
          isUnborn: false,
        });
      if (url.endsWith("/git/pr")) return jsonErr({ error: { type: "gh_unavailable" } });
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <CreatePrModal sessionName="proj" open={true} onClose={() => undefined} />
    ));
    // Wait for branches → base auto-populated.
    await waitFor(async () => {
      const sel = (await findByTestId("create-pr-base")) as HTMLSelectElement;
      expect(sel.value).toBe("main");
    });
    fireEvent.input(await findByTestId("create-pr-title"), { target: { value: "x" } });
    fireEvent.click(await findByTestId("create-pr-submit"));
    const err = await findByTestId("create-pr-error");
    expect(err.textContent).toMatch(/Install the GitHub CLI/i);
  });

  it("renders head-not-pushed copy with branch name", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/git/branches"))
        return jsonOk({
          local: [
            { type: "local", branch: "main" },
            { type: "local", branch: "feat/x" },
          ],
          remote: [],
          remotes: [],
          currentBranch: "feat/x",
          isUnborn: false,
        });
      if (url.endsWith("/git/pr"))
        return jsonErr({ error: { type: "head_not_pushed", branch: "feat/x" } });
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <CreatePrModal sessionName="proj" open={true} onClose={() => undefined} />
    ));
    // Wait for branches → base auto-populated.
    await waitFor(async () => {
      const sel = (await findByTestId("create-pr-base")) as HTMLSelectElement;
      expect(sel.value).toBe("main");
    });
    fireEvent.input(await findByTestId("create-pr-title"), { target: { value: "x" } });
    fireEvent.click(await findByTestId("create-pr-submit"));
    const err = await findByTestId("create-pr-error");
    expect(err.textContent).toMatch(/Push feat\/x before opening a PR/i);
  });
});
