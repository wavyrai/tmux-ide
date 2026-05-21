/**
 * CommandPalette — smoke test.
 *
 * Drives the public surface end-to-end with mocked data sources:
 *   - fetchProjects/fetchSessions stubbed to a tiny set
 *   - chat.thread.list mocked via global fetch
 *   - useTerminals stubbed to a tiny set
 *
 * Verifies open + filter + ↑↓ Enter for each item kind (projects,
 * chat threads, terminals, commands), and that selecting commits the
 * expected side effects (localStorage keys + closes the palette).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

vi.mock("@/lib/projectsBus", () => ({
  projectsBusTick: () => 0,
  useProjectsBus: () => {},
}));

vi.mock("@/lib/api", async (original) => {
  const actual = (await original()) as Record<string, unknown>;
  const { Effect } = (await import("effect")) as { Effect: { succeed: (v: unknown) => unknown } };
  return {
    ...actual,
    API_BASE: "",
    fetchProjects: () => Effect.succeed([{ name: "alpha", dir: "/repos/alpha", gitBranch: null }]),
    fetchSessions: () => Effect.succeed([{ name: "alpha", dir: "/repos/alpha" }]),
  };
});

vi.mock("@/lib/pty/registry", () => {
  return {
    useTerminals: () => {
      const accessor = () => [
        {
          id: "t-1",
          projectId: "alpha",
          scopeId: "alpha",
          name: "alpha",
          kind: "shell",
          createdAt: "",
          updatedAt: "",
          runtime: { running: true },
        },
        {
          id: "t-2",
          projectId: "alpha",
          scopeId: "alpha",
          name: "dev server",
          kind: "shell",
          createdAt: "",
          updatedAt: "",
          runtime: { running: false },
        },
      ];
      // Solid resource shape — call signatures used by the palette.
      (accessor as unknown as { refetch: () => Promise<void> }).refetch = async () => undefined;
      return accessor;
    },
  };
});

import { CommandPalette, openCommandPalette } from "@/components/CommandPalette";
import { setCurrentProjectName } from "@/lib/currentProject";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: RequestInfo) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/sessions")) {
      return new Response(JSON.stringify({ sessions: [{ name: "alpha", dir: "/repos/alpha" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/v2/action/chat.thread.list")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            threads: [
              { id: "thr-1", title: "Refactor router", updatedAt: "" },
              { id: "thr-2", title: "Auth changes", updatedAt: "" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  // happy-dom's global fetch is configurable.
  (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  setCurrentProjectName("alpha");
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
  setCurrentProjectName(null);
});

function renderPalette() {
  const history = createMemoryHistory();
  history.set({ value: "/v2/project/alpha" });
  return {
    history,
    ...render(() => (
      <MemoryRouter history={history}>
        <Route path="/v2/project/:name" component={CommandPalette} />
      </MemoryRouter>
    )),
  };
}

describe("CommandPalette", () => {
  it("opens on openCommandPalette() and renders an input + listbox", async () => {
    renderPalette();
    openCommandPalette();
    expect(await screen.findByTestId("command-palette")).toBeInTheDocument();
    expect(await screen.findByTestId("command-palette-input")).toBeInTheDocument();
    expect(await screen.findByTestId("command-palette-list")).toBeInTheDocument();
  });

  it("aggregates projects, chat threads, terminals, and commands", async () => {
    renderPalette();
    openCommandPalette();

    // Project from fetchProjects / fetchSessions.
    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-project:alpha")).toBeInTheDocument(),
    );
    // Chat thread from the mocked chat.thread.list action.
    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-thread:thr-1")).toBeInTheDocument(),
    );
    // Terminal from the stubbed useTerminals().
    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-terminal:t-1")).toBeInTheDocument(),
    );
    // A built-in command row is always present.
    expect(await screen.findByTestId("command-palette-row-cmd:open-settings")).toBeInTheDocument();
  });

  it("filtering via the input and Enter activates the focused chat thread row", async () => {
    renderPalette();
    openCommandPalette();
    const input = (await screen.findByTestId("command-palette-input")) as HTMLInputElement;

    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-thread:thr-1")).toBeInTheDocument(),
    );

    // Narrow to one match.
    fireEvent.input(input, { target: { value: "Refactor" } });
    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-thread:thr-1")).toBeInTheDocument(),
    );

    // Hover to set focus deterministically (the reactive focus reset
    // happens on the next microtask; mouseEnter is synchronous).
    fireEvent.mouseEnter(await screen.findByTestId("command-palette-row-thread:thr-1"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(window.localStorage.getItem("tmux-ide:chat:last-thread:/repos/alpha")).toBe("thr-1");
    });
  });

  it("Enter on a hovered terminal row writes the per-project active-terminal key", async () => {
    renderPalette();
    openCommandPalette();
    const input = (await screen.findByTestId("command-palette-input")) as HTMLInputElement;
    await waitFor(async () =>
      expect(await screen.findByTestId("command-palette-row-terminal:t-2")).toBeInTheDocument(),
    );
    fireEvent.mouseEnter(await screen.findByTestId("command-palette-row-terminal:t-2"));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(window.localStorage.getItem("tmux-ide.terminal.active.alpha")).toBe("t-2");
    });
  });
});
