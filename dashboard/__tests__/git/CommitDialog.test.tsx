/**
 * CommitDialog — wire test (G18-P2).
 *
 * Verifies the dialog's two-step commit flow:
 *  1. Newly-selected unstaged paths are staged via POST /git/stage.
 *  2. The commit is dispatched via POST /git/commit with the typed
 *     message.
 *  3. `onCommitted(sha)` fires + the dialog closes on success.
 *  4. Daemon errors land in the inline banner with intent-specific
 *     copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { CommitDialog } from "@/components/CommitDialog";

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
  globalThis.fetch = vi.fn() as typeof fetch;
});

describe("CommitDialog", () => {
  it("stages unselected unstaged paths then commits with the message", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.endsWith("/git/stage")) return jsonOk({ ok: true });
      if (url.endsWith("/git/commit"))
        return jsonOk({ ok: true, sha: "abc1234567890" });
      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;

    const onCommitted = vi.fn();
    const onClose = vi.fn();
    const { findByTestId } = render(() => (
      <CommitDialog
        sessionName="proj"
        open={true}
        staged={[{ path: "a.ts", status: "modified", additions: 0, deletions: 0 }]}
        unstaged={[
          { path: "b.ts", status: "added", additions: 0, deletions: 0 },
          { path: "c.ts", status: "modified", additions: 0, deletions: 0 },
        ]}
        onClose={onClose}
        onCommitted={onCommitted}
      />
    ));

    // Toggle b.ts in. c.ts stays unselected.
    fireEvent.click(await findByTestId("commit-dialog-check-b.ts"));

    const msg = await findByTestId("commit-dialog-message");
    fireEvent.input(msg, { target: { value: "wire test" } });

    fireEvent.click(await findByTestId("commit-dialog-submit"));

    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith("abc1234567890"));
    const stageCall = calls.find((c) => c.url.endsWith("/git/stage"));
    const commitCall = calls.find((c) => c.url.endsWith("/git/commit"));
    expect(stageCall?.body).toEqual({ paths: ["b.ts"] });
    expect(commitCall?.body).toEqual({ message: "wire test" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires a non-empty message", async () => {
    const { findByTestId } = render(() => (
      <CommitDialog
        sessionName="proj"
        open={true}
        staged={[{ path: "a.ts", status: "modified", additions: 0, deletions: 0 }]}
        unstaged={[]}
        onClose={() => undefined}
      />
    ));
    fireEvent.click(await findByTestId("commit-dialog-submit"));
    const err = await findByTestId("commit-dialog-error");
    expect(err.textContent).toMatch(/message is required/i);
  });

  it("surfaces tagged daemon errors in the inline banner", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/git/commit"))
        return jsonErr({ error: { type: "hook_rejected", message: "lint failed" } });
      return jsonOk({ ok: true });
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <CommitDialog
        sessionName="proj"
        open={true}
        staged={[{ path: "a.ts", status: "modified", additions: 0, deletions: 0 }]}
        unstaged={[]}
        onClose={() => undefined}
      />
    ));
    fireEvent.input(await findByTestId("commit-dialog-message"), {
      target: { value: "no-op" },
    });
    fireEvent.click(await findByTestId("commit-dialog-submit"));
    const err = await findByTestId("commit-dialog-error");
    expect(err.textContent).toMatch(/Hook rejected: lint failed/i);
  });
});
