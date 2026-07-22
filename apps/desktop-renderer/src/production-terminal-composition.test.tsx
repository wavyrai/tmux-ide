/* @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  ApplicationShellProjectionInputV2SchemaZ,
  DESKTOP_HOST_API_VERSION,
  type ApplicationShellProjectionInputV2,
  type DaemonInstanceIdentity,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";

const terminalHarness = vi.hoisted(() => {
  const generations: Array<{
    daemon: DaemonInstanceIdentity;
    connect: ReturnType<typeof vi.fn>;
    attachment: { dispose: ReturnType<typeof vi.fn> };
  }> = [];
  const create = vi.fn((_host: unknown, daemon: DaemonInstanceIdentity) => {
    const attachment = {
      write: vi.fn(async () => ({ status: "ok" as const })),
      resize: vi.fn(async () => ({ status: "ok" as const })),
      dispose: vi.fn(),
    };
    const connect = vi.fn(async () => ({ status: "connected" as const, attachment }));
    generations.push({ daemon, connect, attachment });
    return { connect };
  });
  return { create, generations };
});

const xtermHarness = vi.hoisted(() => ({
  create: vi.fn(() => ({
    open: vi.fn(),
    write: vi.fn(async () => undefined),
    focus: vi.fn(),
    fit: vi.fn(() => ({ cols: 80, rows: 24 })),
    refreshTheme: vi.fn(),
    setReducedMotion: vi.fn(),
    onInput: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
  })),
}));

vi.mock("./runtime/host-terminal-transport.ts", () => ({
  createHostNativeTerminalTransport: terminalHarness.create,
}));

vi.mock("./terminal/xterm-renderer.ts", () => ({
  createXtermRenderer: xtermHarness.create,
}));

import { App } from "./App.tsx";
import { createDefaultDomShellInput } from "./experience/dom-shell.ts";

const DAEMON_A: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "test-a",
  instanceId: "00000000-0000-4000-8000-000000000001",
  startedAt: "2026-07-22T00:00:00.000Z",
};

const DAEMON_B: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "test-b",
  instanceId: "00000000-0000-4000-8000-000000000002",
  startedAt: "2026-07-22T00:01:00.000Z",
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function shellInput(extraTerminalId?: string): ApplicationShellProjectionInputV2 {
  const base = createDefaultDomShellInput();
  const agentResources = base.workspace.sidebar.agents.flatMap((agent) =>
    agent.paneId
      ? [
          {
            id: agent.paneId,
            title: agent.name,
            kind: "agent" as const,
            active: false,
            attachability: {
              status: "unavailable" as const,
              reason: "invalid-runtime-proof" as const,
            },
          },
        ]
      : [],
  );
  return ApplicationShellProjectionInputV2SchemaZ.parse({
    ...base,
    project: { ...base.project, name: "alpha", rootLabel: "alpha workspace" },
    workspace: { ...base.workspace, name: "alpha" },
    terminalInventory: {
      activeResourceId: "pane.shell",
      resources: [
        ...agentResources,
        {
          id: "pane.shell",
          title: "Project shell",
          kind: "terminal",
          active: true,
          attachability: { status: "available", semanticPaneId: "pane.shell" },
        },
        {
          id: "pane.logs",
          title: "Logs shell",
          kind: "terminal",
          active: false,
          attachability: { status: "available", semanticPaneId: "pane.logs" },
        },
        {
          id: "pane.unavailable",
          title: "Unavailable shell",
          kind: "terminal",
          active: false,
          attachability: { status: "unavailable", reason: "invalid-runtime-proof" },
        },
        ...(extraTerminalId
          ? [
              {
                id: extraTerminalId,
                title: "Release shell",
                kind: "terminal" as const,
                active: false,
                attachability: {
                  status: "available" as const,
                  semanticPaneId: extraTerminalId,
                },
              },
            ]
          : []),
      ],
    },
  });
}

function createHostHarness() {
  let daemon = DAEMON_A;
  let resource = shellInput();
  const subscriptions: Array<(event: DesktopDaemonEvent) => void> = [];
  const host: HostCapabilities = {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: vi.fn(async () => ({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "electron" as const,
      platform: "linux" as const,
      appVersion: "test",
      theme: { mode: "dark" as const, highContrast: false, reducedMotion: false },
      window: { maximized: false, fullscreen: false, focused: true },
      daemon: { status: "connected" as const, identity: daemon },
    })),
    lifecycle: { requestQuit: async () => undefined },
    window: {
      getState: async () => ({ maximized: false, fullscreen: false, focused: true }),
      minimize: async () => ({ maximized: false, fullscreen: false, focused: true }),
      toggleMaximized: async () => ({ maximized: true, fullscreen: false, focused: true }),
      close: async () => undefined,
      onStateChanged: () => () => undefined,
    },
    menu: { showApplicationMenu: async () => ({ status: "unavailable" }) },
    dialog: { selectProjectDirectory: async () => null },
    theme: {
      getState: async () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      onChanged: () => () => undefined,
    },
    daemon: {
      createWorkspacePane: vi.fn(async () => ({
        status: "ok" as const,
        result: {
          operationId: "00000000-0000-4000-8000-000000000010",
          daemonInstanceId: daemon.instanceId,
          outcome: "created" as const,
          resource: {
            resourceVersion: 1 as const,
            workspaceName: "alpha",
            semanticPaneId: "pane.new",
            displayTitle: "Release shell",
            kind: "terminal" as const,
            harnessProfileId: null,
            role: null,
            missionId: null,
          },
        },
      })),
      issueTerminalAttachment: vi.fn(async () => ({
        status: "error" as const,
        error: { code: "preview-only" as const, reason: "test transport", retryable: false },
      })),
      refreshConnection: vi.fn(async () => ({
        outcome: "generation-replaced" as const,
        previousIdentity: DAEMON_A,
        daemon: { status: "connected" as const, identity: daemon },
      })),
      listWorkspaces: vi.fn(async () => ({
        status: "ok" as const,
        daemon,
        workspaces: [{ workspaceName: "alpha" }],
      })),
      fetchApplicationShell: vi.fn(async () => ({
        status: "ok" as const,
        envelope: {
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource,
        },
      })),
      subscribe: vi.fn(async (_request, listener) => {
        subscriptions.push(listener);
        return { status: "subscribed" as const, unsubscribe: () => undefined };
      }),
    },
  };
  return {
    host,
    setDaemon(next: DaemonInstanceIdentity) {
      daemon = next;
    },
    setResource(next: ApplicationShellProjectionInputV2) {
      resource = next;
    },
    emit(event: DesktopDaemonEvent) {
      for (const listener of subscriptions) listener(event);
    },
  };
}

class ResizeObserverHarness {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error("Expected a clickable element.");
  element.click();
}

beforeEach(() => {
  terminalHarness.generations.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverHarness);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(1));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }) satisfies MediaQueryList,
  );
});

afterEach(() => {
  delete window.tmuxIdeHost;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("production terminal composition", () => {
  it("uses every available semantic inventory entry and never attaches unavailable panes", async () => {
    const harness = createHostHarness();
    window.tmuxIdeHost = harness.host;
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <App />, root);

    await vi.waitFor(() => expect(terminalHarness.generations).toHaveLength(1));
    await vi.waitFor(() => expect(terminalHarness.generations[0]!.connect).toHaveBeenCalled());
    const requests = terminalHarness.generations[0]!.connect.mock.calls.map(([request]) => request);
    expect(requests.map((request) => request.target)).toContainEqual(
      expect.objectContaining({ workspaceName: "alpha", semanticPaneId: "pane.shell" }),
    );
    expect(JSON.stringify(requests)).not.toMatch(/tmuxPaneId|sessionName|%\d+/u);
    expect(root.querySelectorAll(".web-pane-frame").length).toBeGreaterThanOrEqual(3);
    expect(root.querySelectorAll(".terminal-surface__viewport").length).toBeGreaterThanOrEqual(2);
    expect(root.textContent).toContain("Logs shell");
    expect(root.textContent).toContain("Unavailable shell");
    expect(requests).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: { semanticPaneId: "pane.unavailable" } }),
      ]),
    );
    dispose();
  });

  it("creates a terminal through the host and waits for an authoritative refresh before closing", async () => {
    const harness = createHostHarness();
    window.tmuxIdeHost = harness.host;
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <App />, root);
    await vi.waitFor(() => expect(root.querySelector("#create-pane-flow-trigger")).not.toBeNull());

    const refreshed =
      deferred<Awaited<ReturnType<HostCapabilities["daemon"]["fetchApplicationShell"]>>>();
    vi.mocked(harness.host.daemon.fetchApplicationShell).mockReturnValueOnce(refreshed.promise);
    click(root.querySelector("#create-pane-flow-trigger"));
    click(
      [...root.querySelectorAll(".create-pane-flow__kind-card")].find((item) =>
        item.textContent?.includes("Terminal"),
      ) ?? null,
    );
    const title = root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!;
    title.value = "Release shell";
    title.dispatchEvent(new Event("input", { bubbles: true }));
    root
      .querySelector<HTMLFormElement>(".create-pane-flow__form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(harness.host.daemon.createWorkspacePane).toHaveBeenCalledOnce());
    expect(root.querySelector(".create-pane-flow__overlay")?.getAttribute("aria-hidden")).toBe(
      "false",
    );
    expect(harness.host.daemon.createWorkspacePane).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { kind: "terminal", workspaceName: "alpha", displayTitle: "Release shell" },
      }),
    );

    harness.setResource(shellInput("pane.new"));
    refreshed.resolve({
      status: "ok",
      envelope: {
        version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
        daemon: DAEMON_A,
        resource: shellInput("pane.new"),
      },
    });
    await vi.waitFor(() => expect(root.textContent).toContain("Release shell"));
    await vi.waitFor(() =>
      expect(root.querySelector(".create-pane-flow__overlay")?.getAttribute("aria-hidden")).toBe(
        "true",
      ),
    );
    expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("retires terminal attachments and replaces transport authority on generation change", async () => {
    const harness = createHostHarness();
    window.tmuxIdeHost = harness.host;
    const root = document.body.appendChild(document.createElement("div"));
    const dispose = render(() => <App />, root);
    await vi.waitFor(() => expect(terminalHarness.generations).toHaveLength(1));
    await vi.waitFor(() => expect(terminalHarness.generations[0]!.connect).toHaveBeenCalled());

    harness.setDaemon(DAEMON_B);
    harness.emit({
      type: "daemon-generation.changed",
      previousIdentity: DAEMON_A,
      daemon: { status: "connected", identity: DAEMON_B },
    });
    await vi.waitFor(() => expect(terminalHarness.generations).toHaveLength(2));
    expect(terminalHarness.generations.map(({ daemon }) => daemon.instanceId)).toEqual([
      DAEMON_A.instanceId,
      DAEMON_B.instanceId,
    ]);
    await vi.waitFor(() =>
      expect(terminalHarness.generations[0]!.attachment.dispose).toHaveBeenCalled(),
    );
    dispose();
  });
});
