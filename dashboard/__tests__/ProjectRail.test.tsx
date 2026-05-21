/**
 * ProjectRail — leftmost project-switcher rail.
 *
 * Validates that the rail renders one row per project from the
 * (mocked) `/api/sessions` + `/api/projects` resources, the active
 * project (matching the route param) gets a highlighted state, and a
 * click navigates to `/v2/project/<name>` via the Solid Router.
 *
 * `projectsBus` is stubbed out so the rail doesn't try to open a real
 * WebSocket inside happy-dom.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

vi.mock("@/lib/projectsBus", () => ({
  projectsBusTick: () => 0,
  useProjectsBus: () => {},
}));

vi.mock("@/lib/api", () => ({
  fetchSessions: () => ({
    pipe: () => ({ _tag: "stub" }),
  }),
  fetchProjects: () => ({
    pipe: () => ({ _tag: "stub" }),
  }),
}));

import { ProjectRail } from "@/components/ProjectRail";

function renderRail(initialPath: string, rows: { name: string; dir: string; running: boolean }[]) {
  const history = createMemoryHistory();
  history.set({ value: initialPath });
  return {
    history,
    ...render(() => (
      <MemoryRouter history={history}>
        <Route
          path="/v2/project/:name"
          component={() => <ProjectRail rowsOverride={() => rows} />}
        />
        <Route path="/" component={() => <ProjectRail rowsOverride={() => rows} />} />
      </MemoryRouter>
    )),
  };
}

afterEach(() => cleanup());

describe("ProjectRail", () => {
  const sampleRows = [
    { name: "alpha", dir: "/Users/me/alpha", running: true },
    { name: "beta", dir: "/Users/me/beta", running: false },
    { name: "gamma", dir: "/Users/me/gamma", running: true },
  ];

  it("renders a row per project from the registry", () => {
    const { getByTestId } = renderRail("/v2/project/alpha", sampleRows);
    expect(getByTestId("v2-project-rail")).toBeInTheDocument();
    expect(getByTestId("v2-project-rail-row-alpha")).toBeInTheDocument();
    expect(getByTestId("v2-project-rail-row-beta")).toBeInTheDocument();
    expect(getByTestId("v2-project-rail-row-gamma")).toBeInTheDocument();
  });

  it("highlights the row matching the route param", () => {
    const { getByTestId } = renderRail("/v2/project/beta", sampleRows);
    expect(getByTestId("v2-project-rail-row-beta").getAttribute("data-active")).toBe("true");
    expect(getByTestId("v2-project-rail-row-alpha").getAttribute("data-active")).toBeNull();
    expect(getByTestId("v2-project-rail-row-gamma").getAttribute("data-active")).toBeNull();
  });

  it("navigates to /v2/project/<name> on click", async () => {
    const { getByTestId, findByTestId } = renderRail("/v2/project/alpha", sampleRows);
    expect(getByTestId("v2-project-rail-row-alpha").getAttribute("data-active")).toBe("true");
    fireEvent.click(getByTestId("v2-project-rail-row-gamma"));
    // The router push reactively re-renders the rail under the new
    // `:name` param — gamma takes over the active highlight, alpha
    // drops it. Asserting the highlight flip is the route-agnostic
    // proxy for "navigation actually happened".
    const gammaRow = await findByTestId("v2-project-rail-row-gamma");
    expect(gammaRow.getAttribute("data-active")).toBe("true");
    expect(getByTestId("v2-project-rail-row-alpha").getAttribute("data-active")).toBeNull();
  });

  it("exposes a + add-project entry pointing at /", () => {
    const { getByTestId } = renderRail("/v2/project/alpha", sampleRows);
    const add = getByTestId("v2-project-rail-add");
    expect(add).toBeInTheDocument();
    expect(add.getAttribute("href")).toBe("/");
  });
});
