/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import {
  APPLICATION_SHELL_RESOURCE_VERSION,
  ApplicationShellProjectionInputV1SchemaZ,
  DESKTOP_HOST_API_VERSION,
  type ApplicationShellProjectionInputV1,
  type DaemonInstanceIdentity,
  type DesktopDaemonEvent,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonListWorkspacesResult,
  type DesktopDaemonRefreshConnectionResult,
  type DesktopHostBootstrap,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { App } from "./App.tsx";
import { createDefaultDomShellInput } from "./experience/dom-shell.ts";
import styles from "./styles.css?raw";

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let rejectPromise: ((error: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject(error) {
      rejectPromise?.(error);
    },
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

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

const INITIAL_WINDOW: DesktopWindowState = {
  maximized: false,
  fullscreen: false,
  focused: true,
};

function bootstrap(daemon: DaemonInstanceIdentity = DAEMON_A): DesktopHostBootstrap {
  return {
    apiVersion: DESKTOP_HOST_API_VERSION,
    runtime: "electron",
    platform: "linux",
    appVersion: "test",
    theme: { mode: "light", highContrast: false, reducedMotion: false },
    window: INITIAL_WINDOW,
    daemon: { status: "connected", identity: daemon },
  };
}

function shellInput(projectName: string): ApplicationShellProjectionInputV1 {
  const input = createDefaultDomShellInput();
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    ...input,
    project: { ...input.project, name: projectName, rootLabel: `${projectName} workspace` },
    workspace: { ...input.workspace, name: projectName },
  });
}

function withDuplicatePaneIdentity(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellProjectionInputV1 {
  const firstPaneId = input.workspace.sidebar.agents[0]!.paneId;
  return {
    ...input,
    workspace: {
      ...input.workspace,
      sidebar: {
        ...input.workspace.sidebar,
        agents: input.workspace.sidebar.agents.map((agent, index) =>
          index === 1 ? { ...agent, paneId: firstPaneId } : agent,
        ),
      },
    },
  };
}

function withDuplicateSidebarIdentities(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellProjectionInputV1 {
  const firstSessionId = input.workspace.sidebar.sessions[0]!.id;
  const firstAgentId = input.workspace.sidebar.agents[0]!.id;
  return {
    ...input,
    workspace: {
      ...input.workspace,
      sidebar: {
        sessions: input.workspace.sidebar.sessions.map((session, index) =>
          index === 1 ? { ...session, id: firstSessionId } : session,
        ),
        agents: input.workspace.sidebar.agents.map((agent, index) =>
          index === 1 ? { ...agent, id: firstAgentId } : agent,
        ),
      },
    },
  };
}

interface HostSubscription {
  readonly workspaceNames: readonly string[];
  readonly listener: (event: DesktopDaemonEvent) => void;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
}

function createHostHarness() {
  let activeBootstrap = bootstrap();
  let activeDaemon = DAEMON_A;
  let workspaceNames: string[] = [];
  let publishTheme: ((state: DesktopThemeState) => void) | undefined;
  let publishWindow: ((state: DesktopWindowState) => void) | undefined;
  const subscriptions: HostSubscription[] = [];
  const shellInputs = new Map<string, ApplicationShellProjectionInputV1>();

  const stopTheme = vi.fn();
  const stopWindow = vi.fn();
  const host: HostCapabilities = {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: vi.fn(async () => activeBootstrap),
    lifecycle: { requestQuit: async () => undefined },
    window: {
      getState: async () => INITIAL_WINDOW,
      minimize: async () => INITIAL_WINDOW,
      toggleMaximized: async () => INITIAL_WINDOW,
      close: async () => undefined,
      onStateChanged(listener) {
        publishWindow = listener;
        return stopWindow;
      },
    },
    menu: { showApplicationMenu: async () => ({ status: "unavailable" }) },
    dialog: { selectProjectDirectory: vi.fn(async () => null) },
    theme: {
      getState: async () => ({ mode: "light", highContrast: false, reducedMotion: false }),
      onChanged(listener) {
        publishTheme = listener;
        return stopTheme;
      },
    },
    daemon: {
      refreshConnection: vi.fn(
        async (): Promise<DesktopDaemonRefreshConnectionResult> => ({
          outcome: "unchanged",
          daemon: { status: "connected", identity: activeDaemon },
        }),
      ),
      listWorkspaces: vi.fn(
        async (): Promise<DesktopDaemonListWorkspacesResult> => ({
          status: "ok",
          daemon: activeDaemon,
          workspaces: workspaceNames.map((workspaceName) => ({ workspaceName })),
        }),
      ),
      fetchApplicationShell: vi.fn(async ({ workspaceName }) => ({
        status: "ok" as const,
        envelope: {
          version: APPLICATION_SHELL_RESOURCE_VERSION,
          daemon: activeDaemon,
          resource: shellInputs.get(workspaceName) ?? shellInput(workspaceName),
        },
      })),
      subscribe: vi.fn(async (request, listener) => {
        const subscription: HostSubscription = {
          workspaceNames: [...request.workspaceNames],
          listener,
          unsubscribe: vi.fn(),
        };
        subscriptions.push(subscription);
        return {
          status: "subscribed" as const,
          unsubscribe: subscription.unsubscribe as () => void,
        };
      }),
    },
  };

  return {
    host,
    subscriptions,
    stopTheme,
    stopWindow,
    setBootstrap(next: DesktopHostBootstrap) {
      activeBootstrap = next;
      if (next.daemon.status === "connected") activeDaemon = next.daemon.identity;
    },
    setDaemon(next: DaemonInstanceIdentity) {
      activeDaemon = next;
    },
    setWorkspaces(...names: string[]) {
      workspaceNames = names;
    },
    setShell(name: string, input: ApplicationShellProjectionInputV1) {
      shellInputs.set(name, input);
    },
    emit(workspaceNames: readonly string[], event: DesktopDaemonEvent) {
      for (const subscription of subscriptions) {
        if (
          subscription.workspaceNames.length === workspaceNames.length &&
          subscription.workspaceNames.every((name, index) => name === workspaceNames[index])
        ) {
          subscription.listener(event);
        }
      }
    },
    publishTheme(next: DesktopThemeState) {
      publishTheme?.(next);
    },
    publishWindow(next: DesktopWindowState) {
      publishWindow?.(next);
    },
  };
}

function installLightMediaPreference(): void {
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
}

function mount(app: () => ReturnType<typeof App>) {
  const root = document.createElement("div");
  document.body.append(root);
  return { root, dispose: render(app, root) };
}

async function markLive(harness: ReturnType<typeof createHostHarness>, names: readonly string[]) {
  await vi.waitFor(() => {
    expect(
      harness.subscriptions.some(
        (subscription) =>
          subscription.workspaceNames.length === names.length &&
          subscription.workspaceNames.every((name, index) => name === names[index]),
      ),
    ).toBe(true);
  });
  harness.emit(names, { type: "connection.changed", state: "live", error: null });
}

async function mountResourceIdentityMismatch(
  refresh: Promise<DesktopDaemonRefreshConnectionResult>,
) {
  const harness = createHostHarness();
  harness.setWorkspaces("alpha");
  harness.setShell("alpha", shellInput("Recovered workspace"));
  const mismatched = deferred<DesktopDaemonFetchApplicationShellResult>();
  vi.mocked(harness.host.daemon.fetchApplicationShell).mockReturnValueOnce(mismatched.promise);
  vi.mocked(harness.host.daemon.refreshConnection).mockReturnValueOnce(refresh);
  const mounted = mount(() => <App host={harness.host} />);
  await markLive(harness, []);
  await vi.waitFor(() =>
    expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledTimes(1),
  );
  mismatched.resolve({
    status: "ok",
    envelope: {
      version: APPLICATION_SHELL_RESOURCE_VERSION,
      daemon: DAEMON_B,
      resource: shellInput("Rejected mismatched workspace"),
    },
  });
  await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledOnce());
  return { harness, ...mounted };
}

function retryButton(root: HTMLElement): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Try again",
    ) ?? null
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete window.tmuxIdeHost;
  document.body.replaceChildren();
});

describe("desktop App live composition", () => {
  it("keeps the browser/Vite surface explicitly preview-only and performs no network work", async () => {
    installLightMediaPreference();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { root, dispose } = mount(() => <App />);

    expect(root.querySelector<HTMLElement>(".app")?.dataset.shellSource).toBe("preview");
    expect(root.querySelector(".titlebar__preview-badge")?.textContent).toBe("Preview data");
    expect(root.querySelector(".shell-workbench")?.getAttribute("data-shell-source")).toBe(
      "preview",
    );
    expect(root.textContent).not.toContain("Open another folder");
    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    dispose();
  });

  it("hard-fails an invalid present bridge instead of falling back to preview", () => {
    installLightMediaPreference();
    window.tmuxIdeHost = { apiVersion: DESKTOP_HOST_API_VERSION } as HostCapabilities;
    const { root, dispose } = mount(() => <App />);

    expect(root.querySelector<HTMLElement>(".app")?.dataset.shellSource).toBe("hard-error");
    expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
      "hard-error",
    );
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "desktop bridge is incompatible",
    );
    expect(root.querySelector(".titlebar__preview-badge")).toBeNull();
    expect(root.querySelector(".shell-workbench")).toBeNull();
    dispose();
  });

  it("hard-fails an invalid Electron bootstrap without substituting preview data", async () => {
    installLightMediaPreference();
    const harness = createHostHarness();
    vi.mocked(harness.host.bootstrap).mockResolvedValueOnce({
      ...bootstrap(),
      runtime: "invalid-runtime",
    } as unknown as DesktopHostBootstrap);
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await vi.waitFor(() => {
      expect(root.querySelector('[role="alert"]')?.textContent).toContain(
        "desktop host could not be verified",
      );
    });
    expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
      "hard-error",
    );
    expect(root.querySelector(".titlebar__preview-badge")).toBeNull();
    expect(harness.host.daemon.listWorkspaces).not.toHaveBeenCalled();
    dispose();
  });

  it("shows pending, zero-workspace onboarding, and preserves theme/window lifecycle", async () => {
    installLightMediaPreference();
    const pendingBootstrap = deferred<DesktopHostBootstrap>();
    const harness = createHostHarness();
    vi.mocked(harness.host.bootstrap).mockReturnValueOnce(pendingBootstrap.promise);
    const { root, dispose } = mount(() => <App host={harness.host} />);
    const app = root.querySelector<HTMLElement>(".app")!;

    expect(app.dataset.shellSource).toBe("runtime");
    expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
      "pending",
    );
    expect(root.textContent).toContain("No preview data is substituted");

    pendingBootstrap.resolve(bootstrap());
    await markLive(harness, []);
    await vi.waitFor(() => {
      expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
        "onboarding",
      );
      expect(root.textContent).toContain("Start tmux-ide in a project");
      expect(root.querySelector('[aria-label="Minimize"]')).not.toBeNull();
    });

    harness.publishTheme({ mode: "dark", highContrast: true, reducedMotion: true });
    harness.publishWindow({ ...INITIAL_WINDOW, maximized: true });
    await vi.waitFor(() => {
      expect(app.dataset.theme).toBe("dark");
      expect(app.dataset.increasedContrast).toBe("true");
      expect(app.dataset.reducedMotion).toBe("true");
      expect(root.querySelector('[aria-label="Restore"]')).not.toBeNull();
    });
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("var(--tmux-ide-motion-easing-standard)");
    expect(root.querySelector(".runtime-action")).toBeNull();
    expect(harness.host.dialog.selectProjectDirectory).not.toHaveBeenCalled();

    dispose();
    expect(harness.stopTheme).toHaveBeenCalledOnce();
    expect(harness.stopWindow).toHaveBeenCalledOnce();
    expect(harness.subscriptions[0]?.unsubscribe).toHaveBeenCalledOnce();
  });

  it("requires explicit selection for many workspaces and renders the live semantic shell", async () => {
    installLightMediaPreference();
    const harness = createHostHarness();
    harness.setWorkspaces("alpha", "beta");
    harness.setShell("beta", shellInput("Beta project"));
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await markLive(harness, []);
    await vi.waitFor(() => {
      expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
        "chooser",
      );
    });
    expect(harness.host.daemon.fetchApplicationShell).not.toHaveBeenCalled();
    const options = root.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect([...options].map((option) => option.textContent)).toEqual([
      expect.stringContaining("alpha"),
      expect.stringContaining("beta"),
    ]);
    expect(root.querySelector('[role="listbox"]')).not.toBeNull();
    expect(options[0]?.tabIndex).toBe(0);
    expect(options[1]?.tabIndex).toBe(-1);
    options[0]?.focus();
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
    expect(options[0]?.tabIndex).toBe(-1);
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");
    expect(options[1]?.tabIndex).toBe(0);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    options[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(options[0]);
    options[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    expect(options[1]?.tabIndex).toBe(0);
    options[1]?.focus();
    expect(document.activeElement).toBe(options[1]);

    options[1]?.click();
    await markLive(harness, ["beta"]);
    await vi.waitFor(() => {
      expect(root.querySelector(".shell-workbench")?.getAttribute("data-shell-source")).toBe(
        "runtime",
      );
      expect(root.querySelector(".titlebar__brand")?.textContent).toContain("Beta project");
      expect(root.querySelector(".titlebar__preview-badge")).toBeNull();
    });
    expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledWith({
      workspaceName: "beta",
    });
    const workspaceSubscription = harness.subscriptions.find(
      ({ workspaceNames }) => workspaceNames[0] === "beta",
    );
    expect(harness.host.dialog.selectProjectDirectory).not.toHaveBeenCalled();
    dispose();
    expect(workspaceSubscription?.unsubscribe).toHaveBeenCalledOnce();
  });

  it("preserves a live shell as stale and cleans it up when the selected workspace disappears", async () => {
    installLightMediaPreference();
    const harness = createHostHarness();
    harness.setWorkspaces("alpha", "beta");
    harness.setShell("alpha", shellInput("Alpha project"));
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await markLive(harness, []);
    await vi.waitFor(() => expect(root.querySelectorAll('[role="option"]')).toHaveLength(2));
    root.querySelectorAll<HTMLButtonElement>('[role="option"]')[0]?.click();
    await markLive(harness, ["alpha"]);
    await vi.waitFor(() => expect(root.textContent).toContain("Alpha project"));

    harness.emit(["alpha"], {
      type: "connection.changed",
      state: "degraded",
      error: { code: "event-unavailable", reason: "Live events are recovering." },
    });
    await vi.waitFor(() => {
      expect(root.textContent).toContain("Alpha project");
      expect(root.querySelector(".runtime-resource-notice")?.textContent).toContain(
        "Showing last live workspace",
      );
    });

    harness.setWorkspaces("beta");
    harness.emit([], { type: "workspaces.changed" });
    await vi.waitFor(() => {
      expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
        "chooser",
      );
      expect(root.textContent).not.toContain("Alpha project");
    });
    const remainingOption = root.querySelector<HTMLButtonElement>('[role="option"]');
    expect(remainingOption?.textContent).toContain("beta");
    expect(remainingOption?.tabIndex).toBe(0);
    expect(remainingOption?.getAttribute("aria-selected")).toBe("true");
    const alphaSubscription = harness.subscriptions.find(
      ({ workspaceNames }) => workspaceNames[0] === "alpha",
    );
    expect(alphaSubscription?.unsubscribe).toHaveBeenCalledOnce();

    dispose();
    expect(
      harness.subscriptions.find(({ workspaceNames }) => workspaceNames.length === 0)?.unsubscribe,
    ).toHaveBeenCalledOnce();
  });

  it("retires the old generation before accepting a replacement daemon catalog", async () => {
    installLightMediaPreference();
    const harness = createHostHarness();
    const lateA = deferred<DesktopDaemonListWorkspacesResult>();
    vi.mocked(harness.host.daemon.listWorkspaces)
      .mockReturnValueOnce(lateA.promise)
      .mockResolvedValueOnce({
        status: "ok",
        daemon: DAEMON_B,
        workspaces: [{ workspaceName: "new-workspace" }],
      });
    harness.setShell("new-workspace", shellInput("New generation"));
    vi.mocked(harness.host.daemon.refreshConnection).mockImplementationOnce(async () => {
      harness.setDaemon(DAEMON_B);
      return {
        outcome: "generation-replaced",
        previousIdentity: DAEMON_A,
        daemon: { status: "connected", identity: DAEMON_B },
      };
    });
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await markLive(harness, []);
    harness.emit([], {
      type: "connection.changed",
      state: "degraded",
      error: {
        code: "daemon-identity-mismatch",
        reason: "The daemon generation changed.",
      },
    });
    await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledOnce());
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();
    await markLive(harness, []);
    await markLive(harness, ["new-workspace"]);
    await vi.waitFor(() => expect(root.textContent).toContain("New generation"));

    lateA.resolve({
      status: "ok",
      daemon: DAEMON_A,
      workspaces: [{ workspaceName: "old-workspace" }],
    });
    await Promise.resolve();
    expect(root.textContent).not.toContain("old-workspace");
    expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledWith({
      workspaceName: "new-workspace",
    });
    expect(harness.host.daemon.fetchApplicationShell).not.toHaveBeenCalledWith({
      workspaceName: "old-workspace",
    });
    dispose();
  });

  it.each([
    ["duplicate pane identity", withDuplicatePaneIdentity],
    ["duplicate sidebar DOM identities", withDuplicateSidebarIdentities],
  ])("rejects %s at the controlled semantic projection boundary", async (_label, corrupt) => {
    installLightMediaPreference();
    const harness = createHostHarness();
    harness.setWorkspaces("unsafe");
    harness.setShell("unsafe", corrupt(shellInput("Unsafe resource")));
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await markLive(harness, []);
    await markLive(harness, ["unsafe"]);
    await vi.waitFor(() => {
      expect(root.querySelector(".runtime-state-surface")?.getAttribute("data-state")).toBe(
        "degraded",
      );
      expect(root.textContent).toContain("rejected an incoherent semantic workspace update");
    });
    expect(root.querySelector(".shell-workbench")).toBeNull();
    expect(root.querySelector(".titlebar__preview-badge")).toBeNull();
    expect(root.querySelectorAll('[id^="sidebar-agent-"]')).toHaveLength(0);
    expect(root.querySelectorAll('[id^="sidebar-session-"]')).toHaveLength(0);
    dispose();
  });

  it("revalidates a resource identity mismatch exactly once and retires late callbacks", async () => {
    installLightMediaPreference();
    const harness = createHostHarness();
    harness.setWorkspaces("alpha");
    harness.setShell("alpha", shellInput("Replacement generation"));
    const mismatched = deferred<DesktopDaemonFetchApplicationShellResult>();
    const nextRefresh = deferred<DesktopDaemonRefreshConnectionResult>();
    vi.mocked(harness.host.daemon.fetchApplicationShell).mockReturnValueOnce(mismatched.promise);
    vi.mocked(harness.host.daemon.refreshConnection).mockReturnValueOnce(nextRefresh.promise);
    const { root, dispose } = mount(() => <App host={harness.host} />);

    await markLive(harness, []);
    await vi.waitFor(() =>
      expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(
        harness.subscriptions.filter(({ workspaceNames }) => workspaceNames[0] === "alpha"),
      ).toHaveLength(1),
    );
    const retired = harness.subscriptions.find(
      ({ workspaceNames }) => workspaceNames[0] === "alpha",
    )!;
    harness.setDaemon(DAEMON_B);
    mismatched.resolve({
      status: "ok",
      envelope: {
        version: APPLICATION_SHELL_RESOURCE_VERSION,
        daemon: DAEMON_B,
        resource: shellInput("Mismatched resource"),
      },
    });

    await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledOnce());
    expect(root.textContent).toContain("Revalidating the daemon");
    expect(
      [...root.querySelectorAll("button")].some((button) => button.textContent === "Try again"),
    ).toBe(false);
    harness.emit([], {
      type: "daemon-generation.changed",
      previousIdentity: DAEMON_A,
      daemon: { status: "connected", identity: DAEMON_B },
    });
    harness.emit(["alpha"], {
      type: "daemon-generation.changed",
      previousIdentity: DAEMON_A,
      daemon: { status: "connected", identity: DAEMON_B },
    });
    nextRefresh.resolve({
      outcome: "generation-replaced",
      previousIdentity: DAEMON_A,
      daemon: { status: "connected", identity: DAEMON_B },
    });
    await vi.waitFor(() =>
      expect(
        harness.subscriptions.filter(({ workspaceNames }) => workspaceNames.length === 0).length,
      ).toBeGreaterThanOrEqual(2),
    );
    harness.emit([], { type: "connection.changed", state: "live", error: null });
    await vi.waitFor(() =>
      expect(
        harness.subscriptions.filter(({ workspaceNames }) => workspaceNames[0] === "alpha").length,
      ).toBeGreaterThanOrEqual(2),
    );
    harness.emit(["alpha"], { type: "connection.changed", state: "live", error: null });
    await vi.waitFor(() => expect(root.textContent).toContain("Replacement generation"));
    expect(retired.unsubscribe).toHaveBeenCalledOnce();

    const fetchCount = vi.mocked(harness.host.daemon.fetchApplicationShell).mock.calls.length;
    retired.listener({ type: "application-shell.changed", workspaceName: "alpha" });
    retired.listener({
      type: "connection.changed",
      state: "degraded",
      error: { code: "event-unavailable", reason: "Late old-generation callback." },
    });
    await Promise.resolve();
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();
    expect(harness.host.daemon.refreshConnection).toHaveBeenCalledOnce();
    expect(harness.host.daemon.fetchApplicationShell).toHaveBeenCalledTimes(fetchCount);
    expect(root.textContent).toContain("Replacement generation");
    expect(root.querySelector(".runtime-resource-notice")).toBeNull();
    dispose();
  });

  it("leaves same-generation refresh in an honest retryable recovery state", async () => {
    installLightMediaPreference();
    const refresh = deferred<DesktopDaemonRefreshConnectionResult>();
    const { harness, root, dispose } = await mountResourceIdentityMismatch(refresh.promise);
    expect(root.textContent).toContain("Revalidating the daemon");
    expect(retryButton(root)).toBeNull();

    refresh.resolve({
      outcome: "unchanged",
      daemon: { status: "connected", identity: DAEMON_A },
    });
    await vi.waitFor(() => expect(root.textContent).toContain("daemon generation is unchanged"));
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(retryButton(root)).not.toBeNull();
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();

    retryButton(root)?.click();
    await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root.textContent).toContain("daemon generation is unchanged"));
    dispose();
  });

  it("retires live stores when refresh reports the daemon authority unavailable", async () => {
    installLightMediaPreference();
    const refresh = deferred<DesktopDaemonRefreshConnectionResult>();
    const { harness, root, dispose } = await mountResourceIdentityMismatch(refresh.promise);
    const oldWorkspaceSubscription = harness.subscriptions.find(
      ({ workspaceNames }) => workspaceNames[0] === "alpha",
    )!;
    refresh.resolve({
      outcome: "authority-retired",
      previousIdentity: DAEMON_A,
      daemon: {
        status: "unavailable",
        code: "process-not-running",
        reason: "The canonical daemon is not running.",
      },
    });

    await vi.waitFor(() => expect(root.textContent).toContain("The daemon is unavailable"));
    expect(root.textContent).toContain("canonical daemon is not running");
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(root.querySelector(".shell-workbench")).toBeNull();
    expect(oldWorkspaceSubscription.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();
    dispose();
  });

  it("coalesces concurrent recovery and handles superseded authority without getting stuck", async () => {
    installLightMediaPreference();
    const refresh = deferred<DesktopDaemonRefreshConnectionResult>();
    const { harness, root, dispose } = await mountResourceIdentityMismatch(refresh.promise);
    harness.emit([], {
      type: "connection.changed",
      state: "degraded",
      error: { code: "daemon-identity-mismatch", reason: "Concurrent catalog mismatch." },
    });
    await Promise.resolve();
    expect(harness.host.daemon.refreshConnection).toHaveBeenCalledOnce();

    refresh.resolve({
      outcome: "superseded",
      daemon: { status: "connected", identity: DAEMON_A },
    });
    await vi.waitFor(() => expect(root.textContent).toContain("recovery was superseded"));
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(retryButton(root)).not.toBeNull();

    vi.mocked(harness.host.daemon.refreshConnection).mockImplementationOnce(async () => {
      harness.setDaemon(DAEMON_B);
      return {
        outcome: "generation-replaced",
        previousIdentity: DAEMON_A,
        daemon: { status: "connected", identity: DAEMON_B },
      };
    });
    retryButton(root)?.click();
    await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        harness.subscriptions.filter(({ workspaceNames }) => workspaceNames[0] === "alpha").length,
      ).toBeGreaterThanOrEqual(2),
    );
    harness.emit(["alpha"], { type: "connection.changed", state: "live", error: null });
    await vi.waitFor(() => expect(root.textContent).toContain("Recovered workspace"));
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();
    dispose();
  });

  it("surfaces refresh failure and allows a typed recovery retry", async () => {
    installLightMediaPreference();
    const refresh = deferred<DesktopDaemonRefreshConnectionResult>();
    const { harness, root, dispose } = await mountResourceIdentityMismatch(refresh.promise);
    refresh.reject(new Error("private host failure"));
    await vi.waitFor(() => expect(root.textContent).toContain("Daemon verification failed"));
    expect(root.textContent).not.toContain("private host failure");
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(retryButton(root)).not.toBeNull();

    retryButton(root)?.click();
    await vi.waitFor(() => expect(harness.host.daemon.refreshConnection).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root.textContent).toContain("daemon generation is unchanged"));
    expect(root.textContent).not.toContain("Revalidating the daemon");
    expect(harness.host.bootstrap).toHaveBeenCalledOnce();
    dispose();
  });
});
