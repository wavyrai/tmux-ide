/**
 * Project route shell — G16-P2 smoke tests.
 *
 * Covers the IDE shell renders, ActivityBar items reachable, view
 * switching toggles the URL search param + the visible main content,
 * and chrome toggles flip the layout signal.
 *
 * `ChatView` / `Terminal` are stubbed at the module level so the
 * tests don't try to mount chat-solid (which renders a Solid-side
 * runtime that wants real DOM + WebSocket) or xterm (WebGL +
 * ResizeObserver) under happy-dom. That keeps the test scope to the
 * shell wiring, where regressions actually bite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { Route, MemoryRouter, createMemoryHistory } from "@solidjs/router";

vi.mock("@/components/ChatView", () => ({
  ChatView: (props: { projectName: string }) => (
    <div data-testid="v2-chat-view" data-project={props.projectName} />
  ),
}));

vi.mock("@/components/Terminal", () => ({
  Terminal: (props: { id: string }) => <div data-testid="v2-terminal-host" data-pty={props.id} />,
}));

import ProjectV2Route from "@/routes/v2/project/[name]";
import { __resetChromeForTests, toggleLeftSidebar } from "@/lib/chrome";

function renderRoute(initial = "/v2/project/smoke-project") {
  const history = createMemoryHistory();
  history.set({ value: initial });
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/v2/project/:name" component={ProjectV2Route} />
    </MemoryRouter>
  ));
}

beforeEach(() => {
  __resetChromeForTests();
});
afterEach(() => cleanup());

describe("/v2/project/:name shell", () => {
  it("renders the activity bar, sidebar, editor, inspector, bottom panel, and status bar", () => {
    const { getByTestId } = renderRoute();
    expect(getByTestId("v2-activity-bar")).toBeInTheDocument();
    expect(getByTestId("v2-project-sidebar")).toBeInTheDocument();
    expect(getByTestId("v2-editor")).toBeInTheDocument();
    expect(getByTestId("v2-right-inspector")).toBeInTheDocument();
    expect(getByTestId("v2-bottom-panel")).toBeInTheDocument();
    expect(getByTestId("v2-status-bar")).toBeInTheDocument();
  });

  it("activity-bar Chat button switches the editor to the chat view", async () => {
    const { getByTestId, findByTestId } = renderRoute();
    fireEvent.click(getByTestId("v2-activity-chat"));
    expect(await findByTestId("v2-chat-view")).toBeInTheDocument();
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("chat");
  });

  it("activity-bar Terminal button switches the editor to the terminal view", async () => {
    const { getByTestId, findAllByTestId } = renderRoute();
    fireEvent.click(getByTestId("v2-activity-terminal"));
    // Two xterm hosts exist while the terminal view is active: the
    // bottom-panel always-mounted host + the main-content xterm. The
    // shell test just needs to assert at least one is in the DOM.
    const hosts = await findAllByTestId("v2-terminal-host");
    expect(hosts.length).toBeGreaterThan(0);
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("terminal");
  });

  it("activity-bar Files button switches the editor to the FilesSurface", async () => {
    const { getByTestId, findByTestId } = renderRoute();
    fireEvent.click(getByTestId("v2-activity-files"));
    // G17-P4 swapped the placeholder for the live Solid surface;
    // the testid is now `v2-files-surface` (Explorer + preview).
    expect(await findByTestId("v2-files-surface")).toBeInTheDocument();
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("files");
  });

  it("non-wired view ids render the G16-P3 placeholder", async () => {
    const { getByTestId, findByTestId } = renderRoute();
    fireEvent.click(getByTestId("v2-activity-plans"));
    expect(await findByTestId("v2-view-placeholder")).toBeInTheDocument();
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("plans");
  });

  it("status-bar left-sidebar toggle collapses the primary sidebar", async () => {
    const { getByTestId, queryByTestId } = renderRoute();
    expect(queryByTestId("v2-project-sidebar")).toBeInTheDocument();
    fireEvent.click(getByTestId("status-bar-toggle-left"));
    // Sidebar contents render under <Show when={chrome().leftSidebarOpen}> —
    // toggling the chrome signal removes the contents from the tree.
    expect(queryByTestId("v2-project-sidebar")).toBeNull();
  });

  it("chrome.toggleLeftSidebar() flips the layout signal directly", () => {
    const { queryByTestId } = renderRoute();
    expect(queryByTestId("v2-project-sidebar")).toBeInTheDocument();
    toggleLeftSidebar();
    expect(queryByTestId("v2-project-sidebar")).toBeNull();
  });

  it("renders the project name into the sidebar header", () => {
    const { getByTestId } = renderRoute("/v2/project/my-cool-project");
    const sidebar = getByTestId("v2-project-sidebar");
    expect(sidebar.textContent).toContain("my-cool-project");
  });
});
