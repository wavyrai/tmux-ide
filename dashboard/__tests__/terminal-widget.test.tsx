/**
 * /terminal/:id and /widget/:name — Solid parity tests.
 *
 * Both routes mount the xterm Terminal host (G16-P2 port). happy-dom
 * doesn't ship WebGL or a real WebSocket, so the Terminal component
 * is stubbed at the module level; the tests cover the route chrome +
 * the route → Terminal wiring (id propagation, loading / error
 * states for the widget mirror).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

vi.mock("@/components/Terminal", () => ({
  Terminal: (props: { id: string; cwd?: string; cmd?: string[] }) => (
    <div
      data-testid="v2-terminal-host"
      data-pty={props.id}
      data-cwd={props.cwd ?? ""}
      data-cmd={(props.cmd ?? []).join(" ")}
    />
  ),
}));

import TerminalRoute from "@/routes/terminal/[id]";
import WidgetRoute from "@/routes/widget/[name]";

afterEach(() => cleanup());

function renderTerminal(id: string) {
  const history = createMemoryHistory();
  history.set({ value: `/terminal/${encodeURIComponent(id)}` });
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/terminal/:id" component={TerminalRoute} />
    </MemoryRouter>
  ));
}

function renderWidget(path: string) {
  const history = createMemoryHistory();
  history.set({ value: path });
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/widget/:name" component={WidgetRoute} />
    </MemoryRouter>
  ));
}

describe("/terminal/:id", () => {
  it("renders the chrome + Terminal pinned to the id from the URL", () => {
    const { getByTestId } = renderTerminal("my-shell");
    expect(getByTestId("v2-terminal-route")).toBeInTheDocument();
    expect(getByTestId("v2-terminal-host").getAttribute("data-pty")).toBe("my-shell");
  });
});

describe("/widget/:name", () => {
  it("renders the error state when session + dir query params are missing", async () => {
    const { findByTestId } = renderWidget("/widget/changes");
    const err = await findByTestId("v2-widget-error");
    expect(err.textContent).toContain("missing widget name, session, or dir query params");
  });
});
