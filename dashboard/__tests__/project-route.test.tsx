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

// The route gates the IDE shell behind `ensureSessionRunning`, which
// hits /api/sessions + /api/v2/action/project.launch on mount. Under
// happy-dom there is no daemon at 127.0.0.1:6060, so the fetches reject
// with ECONNREFUSED and the route stays on `SessionBootScreen`
// forever — none of the shell testids ever mount. Stub `fetch` so
// /api/sessions reports the smoke-project as already running (route
// flips straight to "ready" and renders the shell). Every other API
// call returns a safe empty payload so the surfaces that fetch on
// mount (ProjectRail, TopBar, BottomPanel, etc.) don't spam the
// console with unhandled rejections.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/sessions")) {
      return new Response(
        JSON.stringify({
          sessions: [
            { name: "smoke-project", running: true },
            { name: "my-cool-project", running: true },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Default: 200 + empty object. Surfaces that read named fields
    // (projects, panes, etc.) get `undefined` and render their empty
    // state — fine for the shell-wiring tests, which only care that
    // the route advanced past the boot screen.
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

vi.mock("@/components/ChatView", () => ({
  ChatView: (props: { projectName: string }) => (
    <div data-testid="v2-chat-view" data-project={props.projectName} />
  ),
}));

vi.mock("@/components/Terminal", () => ({
  Terminal: (props: { id: string }) => <div data-testid="v2-terminal-host" data-pty={props.id} />,
}));

// TerminalSurface mounts the real xterm runtime (WebGL + PTY WS) when
// the activity-bar Terminal button is clicked. Stub it for the route
// shell tests — same rationale as ChatView/Terminal above.
vi.mock("@/components/Terminal/TerminalSurface", () => ({
  TerminalSurface: (props: { projectName: string }) => (
    <div data-testid="v2-terminal-host" data-project={props.projectName} />
  ),
}));

// The Files view mounts FilesSurface, which starts the FS-watch
// WebSocket client + warms the Monaco editor pool. happy-dom can't
// run either (no browser WebSocket, no @monaco-editor/loader), so
// stub both — the route-shell tests only assert which surface
// mounts, not its live data wiring.
vi.mock("@/lib/editor/fs-watch-client", () => ({
  startFsWatchClient: () => () => {},
}));

vi.mock("@/lib/monaco/code-pool", () => ({
  codeEditorPool: {
    init: vi.fn(async () => undefined),
    acquire: vi.fn(),
    release: vi.fn(),
  },
}));

import ProjectV2Route from "@/routes/project/[name]";
import { __resetChromeForTests, toggleLeftSidebar } from "@/lib/chrome";

function renderRoute(initial = "/project/smoke-project") {
  const history = createMemoryHistory();
  history.set({ value: initial });
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/project/:name" component={ProjectV2Route} />
    </MemoryRouter>
  ));
}

/**
 * Renders the route and waits for the IDE shell to replace the
 * `SessionBootScreen` (which renders until `ensureSessionRunning`
 * resolves — see route module for the gating logic). Every test in
 * this suite asserts against the shell, so we centralise the wait
 * here. Tests that toggle into a specific view still use the
 * returned `findByTestId` to await their own surface.
 */
async function mountShell(initial = "/project/smoke-project") {
  const utils = renderRoute(initial);
  // `v2-activity-bar` is part of `ProjectShell` and only mounts once
  // `sessionState === "ready"` — the cheapest signal that the boot
  // screen has been replaced.
  await utils.findByTestId("v2-activity-bar");
  return utils;
}

beforeEach(() => {
  __resetChromeForTests();
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("/project/:name shell", () => {
  it("renders the activity bar, sidebar, editor, inspector, bottom panel, and status bar", async () => {
    const { getByTestId } = await mountShell();
    expect(getByTestId("v2-activity-bar")).toBeInTheDocument();
    expect(getByTestId("v2-project-sidebar")).toBeInTheDocument();
    expect(getByTestId("v2-editor")).toBeInTheDocument();
    expect(getByTestId("v2-right-inspector")).toBeInTheDocument();
    expect(getByTestId("v2-bottom-panel")).toBeInTheDocument();
    expect(getByTestId("v2-status-bar")).toBeInTheDocument();
  });

  it("activity-bar Chat button switches the editor to the chat view", async () => {
    const { getByTestId, findByTestId } = await mountShell();
    fireEvent.click(getByTestId("v2-activity-chat"));
    expect(await findByTestId("v2-chat-view")).toBeInTheDocument();
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("chat");
  });

  it("activity-bar Terminal button switches the editor to the terminal view", async () => {
    const { getByTestId, findAllByTestId } = await mountShell();
    fireEvent.click(getByTestId("v2-activity-terminal"));
    // Two xterm hosts exist while the terminal view is active: the
    // bottom-panel always-mounted host + the main-content xterm. The
    // shell test just needs to assert at least one is in the DOM.
    const hosts = await findAllByTestId("v2-terminal-host");
    expect(hosts.length).toBeGreaterThan(0);
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("terminal");
  });

  it("activity-bar Files button switches the editor to the FilesSurface", async () => {
    const { getByTestId, findByTestId } = await mountShell();
    fireEvent.click(getByTestId("v2-activity-files"));
    // G17-P4 swapped the placeholder for the live Solid surface;
    // the testid is now `v2-files-surface` (Explorer + preview).
    expect(await findByTestId("v2-files-surface")).toBeInTheDocument();
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("files");
  });

  it("activity-bar Plans button switches to the wired Plans surface", async () => {
    // The G16-P3 "Coming soon" placeholder was retired once every
    // view ID got a live Solid surface in the v2.5 sweep. Plans is
    // now wired (rail + panel), so the route must NOT fall back to
    // a placeholder — it switches `data-view` and mounts the
    // surface's widget host instead.
    const { getByTestId, findByTestId, queryByTestId } = await mountShell();
    fireEvent.click(getByTestId("v2-activity-plans"));
    await findByTestId("v2-view-root");
    expect(getByTestId("v2-view-root").getAttribute("data-view")).toBe("plans");
    expect(queryByTestId("v2-view-placeholder")).toBeNull();
  });

  it("status-bar left-sidebar toggle collapses the primary sidebar", async () => {
    const { getByTestId, queryByTestId } = await mountShell();
    expect(queryByTestId("v2-project-sidebar")).toBeInTheDocument();
    fireEvent.click(getByTestId("status-bar-toggle-left"));
    // Sidebar contents render under <Show when={chrome().leftSidebarOpen}> —
    // toggling the chrome signal removes the contents from the tree.
    expect(queryByTestId("v2-project-sidebar")).toBeNull();
  });

  it("chrome.toggleLeftSidebar() flips the layout signal directly", async () => {
    const { queryByTestId } = await mountShell();
    expect(queryByTestId("v2-project-sidebar")).toBeInTheDocument();
    toggleLeftSidebar();
    expect(queryByTestId("v2-project-sidebar")).toBeNull();
  });

  it("renders the project name into the sidebar header", async () => {
    const { getByTestId } = await mountShell("/project/my-cool-project");
    const sidebar = getByTestId("v2-project-sidebar");
    expect(sidebar.textContent).toContain("my-cool-project");
  });
});
