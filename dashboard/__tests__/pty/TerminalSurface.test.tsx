/**
 * TerminalSurface — tab strip wire tests (G20-P2).
 *
 * Covers the user-facing flows:
 *   1. Mounts the tab strip with the daemon's terminal list.
 *   2. Clicking + creates a new terminal via POST /terminals.
 *   3. Clicking × deletes via DELETE /terminals/:id.
 *   4. Double-click to rename → POST /terminals/:id/rename.
 *
 * PtyPane is not mounted — we'd need xterm + a WebSocket plus a
 * canvas to render it, all of which are out of scope for the tab-
 * strip contract. The PtyPane's xterm runtime is covered by
 * PtySession state-machine tests + the existing Terminal.tsx
 * lineage of integration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

// Stub PtyPane — the surface mounts it for the active tab but the
// real one needs xterm + a canvas. The stub keeps the surface
// renderable without dragging that in. `options.cwd` is reflected
// onto a data attribute so the cwd-wiring test below can assert the
// surface threaded the resolved project dir through.
vi.mock("@/components/Terminal/PtyPane", () => ({
  PtyPane: (props: { sessionId: string; options?: { cwd?: string; cmd?: string[] } }) => (
    <div
      data-testid="pty-pane-stub"
      data-session-id={props.sessionId}
      data-cwd={props.options?.cwd ?? ""}
    >
      pane:{props.sessionId}
    </div>
  ),
}));

import { TerminalSurface } from "@/components/Terminal/TerminalSurface";

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_TERMINALS = [
  {
    id: "abc1234567890abc1234567890abcdef",
    projectId: "proj",
    scopeId: "/tmp",
    name: "shell",
    kind: "shell",
    createdAt: "2026-05-13T00:00:00Z",
    updatedAt: "2026-05-13T00:00:00Z",
    scripted: true,
    runtime: { running: true, cols: 80, rows: 24 },
  },
  {
    id: "second-id-aaaaaaaaaaaaaaaaaaaaaaaaa",
    projectId: "proj",
    scopeId: "/tmp",
    name: "tests",
    kind: "shell",
    createdAt: "2026-05-13T00:01:00Z",
    updatedAt: "2026-05-13T00:01:00Z",
    runtime: { running: false },
  },
];

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
  window.localStorage.clear();
});

beforeEach(() => {
  globalThis.fetch = vi.fn() as typeof fetch;
});

describe("TerminalSurface", () => {
  it("renders one tab per daemon terminal + the new-tab button", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`terminal-tab-${SAMPLE_TERMINALS[0]!.id}`);
    await findByTestId(`terminal-tab-${SAMPLE_TERMINALS[1]!.id}`);
    await findByTestId("terminal-tab-new");
  });

  it("activates the first tab by default and renders PtyPane for it", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    const pane = (await findByTestId("pty-pane-stub")) as HTMLElement;
    expect(pane.getAttribute("data-session-id")).toBe(SAMPLE_TERMINALS[0]!.id);
  });

  it("restores the persisted active tab from localStorage", async () => {
    window.localStorage.setItem("tmux-ide.terminal.active.proj", SAMPLE_TERMINALS[1]!.id);
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await waitFor(async () => {
      const pane = (await findByTestId("pty-pane-stub")) as HTMLElement;
      expect(pane.getAttribute("data-session-id")).toBe(SAMPLE_TERMINALS[1]!.id);
    });
  });

  it("clicking + POSTs a new shell terminal", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let nextList = [...SAMPLE_TERMINALS];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/terminals") && method === "GET") {
        return jsonOk({ terminals: nextList });
      }
      if (url.endsWith("/terminals") && method === "POST") {
        const created = {
          id: "new-id-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          projectId: "proj",
          scopeId: "/tmp",
          name: (body as { name?: string }).name ?? "shell 3",
          kind: "shell",
          createdAt: "2026-05-13T00:02:00Z",
          updatedAt: "2026-05-13T00:02:00Z",
          runtime: { running: false },
        };
        nextList = [...nextList, { ...created } as never];
        return jsonOk({ ok: true, terminal: created });
      }
      throw new Error(`Unhandled fetch ${method} ${url}`);
    }) as typeof fetch;

    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`terminal-tab-${SAMPLE_TERMINALS[0]!.id}`);
    fireEvent.click(await findByTestId("terminal-tab-new"));
    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/terminals"));
      expect(postCall).toBeTruthy();
      expect((postCall!.body as { name: string }).name).toBe("shell 3");
    });
  });

  it("Close → Yes confirm DELETEs the tab; No keeps it", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let nextList = [...SAMPLE_TERMINALS];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") {
        nextList = SAMPLE_TERMINALS.filter((t) => !url.endsWith(`/terminals/${t.id}`));
        return jsonOk({ ok: true });
      }
      return jsonOk({ terminals: nextList });
    }) as typeof fetch;

    const target = SAMPLE_TERMINALS[1]!;
    const { findByTestId, queryByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`terminal-tab-${target.id}`);

    // First Close click only opens the inline confirm — no DELETE yet.
    fireEvent.click(await findByTestId(`terminal-tab-close-${target.id}`));
    await findByTestId(`terminal-tab-delete-confirm-${target.id}`);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // Clicking No dismisses the confirm without deleting.
    fireEvent.click(await findByTestId(`terminal-tab-delete-cancel-${target.id}`));
    await waitFor(() => {
      expect(queryByTestId(`terminal-tab-delete-confirm-${target.id}`)).toBeNull();
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // Re-open confirm and click Yes — now the DELETE fires.
    fireEvent.click(await findByTestId(`terminal-tab-close-${target.id}`));
    fireEvent.click(await findByTestId(`terminal-tab-delete-confirm-${target.id}`));
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" && c.url.endsWith(`/terminals/${encodeURIComponent(target.id)}`),
        ),
      ).toBe(true);
    });
  });

  it("renders the vertical rail with header + new button", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    const rail = await findByTestId("terminal-rail");
    expect(rail.tagName).toBe("ASIDE");
    expect(rail.textContent).toContain("Terminals");
    await findByTestId("terminal-tab-new");
  });

  it("threads the resolved project dir as the PtyPane cwd", async () => {
    // /api/sessions resolves the workspace dir for this project; the
    // surface must forward it to PtyPane so FrontendPty's init frame
    // tells the daemon to spawn there (instead of the daemon's cwd).
    const PROJECT_DIR = "/repos/proj";
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/sessions")) {
        return jsonOk({ sessions: [{ name: "proj", dir: PROJECT_DIR }] });
      }
      return jsonOk({ terminals: SAMPLE_TERMINALS });
    }) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await waitFor(async () => {
      const pane = (await findByTestId("pty-pane-stub")) as HTMLElement;
      expect(pane.getAttribute("data-cwd")).toBe(PROJECT_DIR);
    });
    const surface = (await findByTestId("terminal-surface")) as HTMLElement;
    expect(surface.getAttribute("data-project-dir")).toBe(PROJECT_DIR);
  });

  it("scopes new terminals to the resolved project dir", async () => {
    // The newly created terminal's `scopeId` should be the resolved
    // workspace dir — that is what the daemon stamps onto its
    // deterministic-id derivation and what the WS init frame uses.
    const PROJECT_DIR = "/repos/proj";
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let nextList = [...SAMPLE_TERMINALS];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/api/sessions")) {
        return jsonOk({ sessions: [{ name: "proj", dir: PROJECT_DIR }] });
      }
      if (url.endsWith("/terminals") && method === "POST") {
        const created = {
          ...SAMPLE_TERMINALS[0]!,
          id: "newly-created-bbbbbbbbbbbbbbbbbbbbbbb",
          name: (body as { name?: string }).name ?? "shell",
          scopeId: (body as { scopeId?: string }).scopeId ?? "",
        };
        nextList = [...nextList, { ...created } as never];
        return jsonOk({ ok: true, terminal: created });
      }
      return jsonOk({ terminals: nextList });
    }) as typeof fetch;
    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    // Wait for the project dir to resolve into the surface dataset so
    // the create call goes out with the correct scope.
    await waitFor(async () => {
      const surface = (await findByTestId("terminal-surface")) as HTMLElement;
      expect(surface.getAttribute("data-project-dir")).toBe(PROJECT_DIR);
    });
    fireEvent.click(await findByTestId("terminal-tab-new"));
    await waitFor(() => {
      const postCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/terminals"));
      expect(postCall).toBeTruthy();
      expect((postCall!.body as { scopeId: string }).scopeId).toBe(PROJECT_DIR);
    });
  });

  it("double-click → type → Enter POSTs a rename", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url.endsWith("/rename") && method === "POST") {
        return jsonOk({
          ok: true,
          terminal: { ...SAMPLE_TERMINALS[0]!, name: (body as { name: string }).name },
        });
      }
      return jsonOk({ terminals: SAMPLE_TERMINALS });
    }) as typeof fetch;

    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    const label = await findByTestId(`terminal-tab-label-${SAMPLE_TERMINALS[0]!.id}`);
    fireEvent.dblClick(label);
    const input = (await findByTestId(
      `terminal-tab-rename-${SAMPLE_TERMINALS[0]!.id}`,
    )) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const renameCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/rename"));
      expect(renameCall).toBeTruthy();
      expect((renameCall!.body as { name: string }).name).toBe("Renamed");
    });
  });
});
