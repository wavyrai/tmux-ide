/**
 * TerminalSurface — keybind integration tests (G20-P3).
 *
 * Covers the wire from a real `keydown` event dispatched against
 * `window` (with focus inside the surface root) to the matching
 * action:
 *   Cmd+T  → POST /terminals
 *   Cmd+W  → DELETE /terminals/:id (the active tab)
 *   Cmd+2  → activates the second tab + persists the choice
 *
 * Uses the same fetch + PtyPane stubs as the P2 surface test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

vi.mock("@/components/Terminal/PtyPane", () => ({
  PtyPane: (props: { sessionId: string }) => (
    <div data-testid="pty-pane-stub" data-session-id={props.sessionId} />
  ),
}));

import { TerminalSurface } from "@/components/Terminal/TerminalSurface";

/** With keep-all-mounted, every open terminal renders a PtyPane —
 *  query the active one via the wrapper's `data-active="true"`. */
function activePaneSessionId(container: HTMLElement): string | null {
  const wrapper = container.querySelector<HTMLElement>(
    '[data-testid^="pty-pane-host-"][data-active="true"]',
  );
  return wrapper?.getAttribute("data-session-id") ?? null;
}

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE = [
  {
    id: "tab-one-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    projectId: "proj",
    scopeId: "/tmp",
    name: "shell",
    kind: "shell",
    createdAt: "2026-05-13T00:00:00Z",
    updatedAt: "2026-05-13T00:00:00Z",
    runtime: { running: true, cols: 80, rows: 24 },
  },
  {
    id: "tab-two-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
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
const originalPlatform = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  "platform",
);

beforeEach(() => {
  // Force the predicate's mac detection to match `metaKey` keybinds.
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => "MacIntel",
  });
});

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(navigator, "platform", originalPlatform);
  }
  globalThis.fetch = originalFetch;
  cleanup();
  window.localStorage.clear();
});

function pressKey(target: HTMLElement, init: KeyboardEventInit): void {
  // jsdom-style: dispatching keydown on `window` propagates through
  // the capture-phase listener TerminalSurface attaches.
  target.focus();
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
}

describe("TerminalSurface — keybinds", () => {
  it("Cmd+T POSTs a new terminal", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let next = [...SAMPLE];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (method === "POST" && url.endsWith("/terminals")) {
        const created = {
          ...SAMPLE[0]!,
          id: "tab-new-cccccccccccccccccccccccccccccc",
          name: (body as { name?: string }).name ?? "shell N",
        };
        next = [...next, { ...created } as never];
        return jsonOk({ ok: true, terminal: created });
      }
      return jsonOk({ terminals: next });
    }) as typeof fetch;

    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    const surface = await findByTestId("terminal-surface");

    pressKey(surface, { key: "t", metaKey: true });

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/terminals"))).toBe(true);
    });
  });

  it("Cmd+W DELETEs the active tab", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let next = [...SAMPLE];
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = (init?.method as string) ?? "GET";
      calls.push({ url, method });
      if (method === "DELETE") {
        next = next.filter((t) => !url.endsWith(`/terminals/${t.id}`));
        return jsonOk({ ok: true });
      }
      return jsonOk({ terminals: next });
    }) as typeof fetch;

    const { findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`terminal-tab-${SAMPLE[0]!.id}`);
    const surface = await findByTestId("terminal-surface");

    pressKey(surface, { key: "w", metaKey: true });

    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.url.endsWith(`/terminals/${encodeURIComponent(SAMPLE[0]!.id)}`),
        ),
      ).toBe(true);
    });
  });

  it("Cmd+2 activates the second tab and persists the choice", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE })) as typeof fetch;

    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    // Wait for both panes to mount (keep-all-mounted shape).
    await findByTestId(`pty-pane-host-${SAMPLE[0]!.id}`);
    await findByTestId(`pty-pane-host-${SAMPLE[1]!.id}`);
    expect(activePaneSessionId(container)).toBe(SAMPLE[0]!.id);

    const surface = await findByTestId("terminal-surface");
    pressKey(surface, { key: "2", metaKey: true });

    await waitFor(() => {
      expect(activePaneSessionId(container)).toBe(SAMPLE[1]!.id);
    });
    expect(window.localStorage.getItem("tmux-ide.terminal.active.proj")).toBe(SAMPLE[1]!.id);
  });

  it("Cmd+5 with only two tabs is a no-op", async () => {
    globalThis.fetch = vi.fn(async () => jsonOk({ terminals: SAMPLE })) as typeof fetch;
    const { container, findByTestId } = render(() => <TerminalSurface projectName="proj" />);
    await findByTestId(`terminal-tab-${SAMPLE[0]!.id}`);
    const surface = await findByTestId("terminal-surface");
    const beforeId = activePaneSessionId(container);
    pressKey(surface, { key: "5", metaKey: true });
    // Give the handler a tick — it should NOT change the active id.
    await new Promise((r) => setTimeout(r, 20));
    expect(activePaneSessionId(container)).toBe(beforeId);
  });

  it("ignores keybinds when focus is outside the surface", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      const method = (init?.method as string) ?? "GET";
      calls.push(`${method} ${String(input)}`);
      return jsonOk({ terminals: SAMPLE });
    }) as typeof fetch;

    const { findByTestId } = render(() => (
      <div>
        <button data-testid="outside-button" type="button">
          outside
        </button>
        <TerminalSurface projectName="proj" />
      </div>
    ));
    await findByTestId(`terminal-tab-${SAMPLE[0]!.id}`);
    const outside = await findByTestId("outside-button");
    outside.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.every((c) => !c.startsWith("POST"))).toBe(true);
  });
});
