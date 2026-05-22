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
import { onMount } from "solid-js";

// vi.hoisted lets the stub mock + the assertions share state. We use
// it to count how many times each PtyPane *mounts* (NOT renders) so
// the no-remount test can assert that switching active does not
// cause a previously-mounted pane to re-bootstrap (which is what
// would happen if the surface fell back to the old single-active
// render and re-keyed on activeId).
const stubState = vi.hoisted(() => ({ mounts: new Map<string, number>() }));

// Stub PtyPane — the surface mounts it for every open terminal but
// the real one needs xterm + a canvas. The stub keeps the surface
// renderable without dragging that in. `options.cwd` is reflected
// onto a data attribute so the cwd-wiring test below can assert the
// surface threaded the resolved project dir through.
vi.mock("@/components/Terminal/PtyPane", () => ({
  PtyPane: (props: { sessionId: string; options?: { cwd?: string; cmd?: string[] } }) => {
    onMount(() => {
      stubState.mounts.set(props.sessionId, (stubState.mounts.get(props.sessionId) ?? 0) + 1);
    });
    return (
      <div
        data-testid="pty-pane-stub"
        data-session-id={props.sessionId}
        data-cwd={props.options?.cwd ?? ""}
      >
        pane:{props.sessionId}
      </div>
    );
  },
}));

/** Find the active pane wrapper. With keep-all-mounted, multiple
 *  `pty-pane-stub` elements exist — `findByTestId` would throw on
 *  multi-match, so callers query through the active wrapper instead. */
function activePaneWrapper(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid^="pty-pane-host-"][data-active="true"]',
  );
}

function activePaneSessionId(container: HTMLElement): string | null {
  return activePaneWrapper(container)?.getAttribute("data-session-id") ?? null;
}

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
  stubState.mounts.clear();
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
    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`pty-pane-host-${SAMPLE_TERMINALS[0]!.id}`);
    expect(activePaneSessionId(container)).toBe(SAMPLE_TERMINALS[0]!.id);
  });

  it("restores the persisted active tab from localStorage", async () => {
    window.localStorage.setItem("tmux-ide.terminal.active.proj", SAMPLE_TERMINALS[1]!.id);
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`pty-pane-host-${SAMPLE_TERMINALS[1]!.id}`);
    await waitFor(() => {
      expect(activePaneSessionId(container)).toBe(SAMPLE_TERMINALS[1]!.id);
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
    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await waitFor(() => {
      const wrapper = activePaneWrapper(container);
      expect(wrapper).not.toBeNull();
      const stub = wrapper!.querySelector<HTMLElement>('[data-testid="pty-pane-stub"]');
      expect(stub?.getAttribute("data-cwd")).toBe(PROJECT_DIR);
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

  it("keeps every PtyPane mounted across active switches (no re-bootstrap)", async () => {
    // The perf fix: switching tabs must NOT unmount the previously-
    // active PtyPane (which would re-bootstrap xterm, reopen the WS,
    // and replay the buffer). Every open terminal stays mounted; the
    // active wrapper toggles `data-active="true"` and the inactive
    // ones go `invisible pointer-events-none`. We assert this by
    // counting PtyPane mounts and by verifying the inactive wrapper's
    // DOM node identity is stable across a switch.
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE_TERMINALS })) as typeof fetch;
    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);

    const firstId = SAMPLE_TERMINALS[0]!.id;
    const secondId = SAMPLE_TERMINALS[1]!.id;

    // Both wrappers render up-front — keep-all-mounted shape.
    await findByTestId(`pty-pane-host-${firstId}`);
    await findByTestId(`pty-pane-host-${secondId}`);
    await waitFor(() => {
      expect(stubState.mounts.get(firstId)).toBe(1);
      expect(stubState.mounts.get(secondId)).toBe(1);
    });
    expect(activePaneSessionId(container)).toBe(firstId);

    const inactiveWrapperBefore = container.querySelector(
      `[data-testid="pty-pane-host-${secondId}"]`,
    );
    expect(inactiveWrapperBefore).not.toBeNull();

    // Switch active to the second tab.
    fireEvent.click(await findByTestId(`terminal-tab-label-${secondId}`));
    await waitFor(() => {
      expect(activePaneSessionId(container)).toBe(secondId);
    });

    // No re-mount on either side — connect() never fires again.
    expect(stubState.mounts.get(firstId)).toBe(1);
    expect(stubState.mounts.get(secondId)).toBe(1);

    // Inactive wrapper's DOM node identity is preserved across the
    // switch; Solid's keyed <For> did not destroy + recreate it.
    const inactiveWrapperAfter = container.querySelector(
      `[data-testid="pty-pane-host-${secondId}"]`,
    );
    expect(inactiveWrapperAfter).toBe(inactiveWrapperBefore);

    // The previously-active wrapper is now `data-active="false"` but
    // still in the DOM — its xterm/WS keep running underneath.
    const formerActive = container.querySelector(`[data-testid="pty-pane-host-${firstId}"]`);
    expect(formerActive?.getAttribute("data-active")).toBe("false");
    expect(formerActive?.getAttribute("aria-hidden")).toBe("true");
  });
});
