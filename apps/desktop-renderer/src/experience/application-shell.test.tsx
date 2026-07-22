/* @vitest-environment happy-dom */
import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV1SchemaZ,
  DESKTOP_HOST_API_VERSION,
  applicationShellActionTraceV1,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  DomApplicationShell,
  PrimaryNavigation,
  type DomApplicationShellProps,
} from "./application-shell.tsx";
import { DOM_EXPERIENCE_VARIABLE, createDomExperience } from "./dom-experience.ts";
import {
  createDefaultDomShellInput,
  createDefaultDomPaneFrames,
  createDomShellReplayState,
  projectDomApplicationShell,
} from "./dom-shell.ts";
import styles from "../styles.css?raw";
import paneFrameStyles from "../../../../packages/daemon/src/ui/pane-frame/web-host.css?raw";

const disposers: Array<() => void> = [];

const WINDOW_STATE: DesktopWindowState = {
  maximized: false,
  fullscreen: false,
  focused: true,
};

function host(): HostCapabilities {
  return {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: async () => ({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "browser",
      platform: "darwin",
      appVersion: "test",
      theme: { mode: "dark", highContrast: false, reducedMotion: false },
      window: WINDOW_STATE,
      daemon: { status: "unavailable", code: "preview-only", reason: "fixture only" },
    }),
    lifecycle: { requestQuit: async () => undefined },
    window: {
      getState: async () => WINDOW_STATE,
      minimize: async () => WINDOW_STATE,
      toggleMaximized: async () => WINDOW_STATE,
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
      refreshConnection: async () => ({
        outcome: "unchanged",
        daemon: { status: "unavailable", code: "preview-only", reason: "fixture only" },
      }),
      listWorkspaces: async () => ({
        status: "error",
        error: { code: "preview-only", reason: "fixture only" },
      }),
      fetchApplicationShell: async () => ({
        status: "error",
        error: { code: "preview-only", reason: "fixture only" },
      }),
      subscribe: async () => ({
        status: "error",
        error: { code: "preview-only", reason: "fixture only" },
      }),
    },
  };
}

function withDisabledActivity(): ApplicationShellProjectionInputV1 {
  const input = createDefaultDomShellInput();
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    ...input,
    dock: {
      ...input.dock,
      tools: input.dock.tools.map((tool) =>
        tool.id === "activity"
          ? { ...tool, disabledReason: "Activity requires a daemon connection" }
          : tool,
      ),
    },
  });
}

function renderShell(
  input: ApplicationShellProjectionInputV1 = createDefaultDomShellInput(),
  onCommand?: (invocation: ApplicationShellCommandInvocation) => void,
  platform = "darwin",
  onPaneAction?: DomApplicationShellProps["onPaneAction"],
) {
  const root = document.createElement("div");
  document.body.append(root);
  disposers.push(
    render(
      () => (
        <DomApplicationShell
          host={host()}
          runtime="browser"
          platform={platform}
          windowState={WINDOW_STATE}
          input={input}
          dataMode="runtime"
          onCommand={onCommand}
          paneFrames={createDefaultDomPaneFrames()}
          onPaneAction={onPaneAction}
        />
      ),
      root,
    ),
  );
  return root;
}

function pointerClick(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

function installApplicationStyles(root: HTMLElement) {
  const experience = createDomExperience({ hostTheme: { mode: "dark" } });
  for (const [name, value] of Object.entries(experience.variables)) {
    root.style.setProperty(name, value);
  }
  const sheet = document.createElement("style");
  sheet.textContent = `${styles}\n${paneFrameStyles}`;
  document.head.append(sheet);
  disposers.push(() => sheet.remove());
  return experience;
}

function updatedSameWorkspace(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellProjectionInputV1 {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    ...input,
    project: { ...input.project, name: "tmux-ide reactive", rootLabel: "reactive/root" },
    workspace: {
      ...input.workspace,
      name: "Reactive workspace",
      sidebar: {
        sessions: input.workspace.sidebar.sessions.map((session) =>
          session.id === "session.docs" ? { ...session, label: "Fresh documentation" } : session,
        ),
        agents: input.workspace.sidebar.agents.map((agent) =>
          agent.id === "agent.implementer" ? { ...agent, name: "Codex refreshed" } : agent,
        ),
      },
    },
    dock: {
      ...input.dock,
      tools: input.dock.tools.map((tool) =>
        tool.data.kind === "files" ? { ...tool, data: { ...tool.data, fileCount: 999 } } : tool,
      ),
    },
    connection: {
      state: "connected",
      message: "Connected from fresh host snapshot",
      safeState: "Runtime workspace synchronized",
      nextAction: "No action needed",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe("visible DOM application shell", () => {
  it("renders honest landmarks, canonical tabs, disabled reasons, and platform shortcuts", async () => {
    const root = renderShell(withDisabledActivity());

    expect(root.querySelector("header.titlebar")).not.toBeNull();
    expect(root.querySelector('nav[aria-label="Workspace modes"]')).not.toBeNull();
    expect(root.querySelector('aside[aria-label="Workspace overview"]')).not.toBeNull();
    expect(root.querySelector("main.workspace-main")).not.toBeNull();
    expect(root.querySelector('footer[role="status"]')).not.toBeNull();
    expect(root.querySelectorAll('.primary-tabs [role="tab"]')).toHaveLength(2);
    expect(root.querySelectorAll('.workbench-dock [role="tab"]')).toHaveLength(4);
    expect(root.querySelectorAll('[role="tabpanel"]')).toHaveLength(6);
    expect(root.textContent).toContain("Sessions");
    expect(root.textContent).toContain("Agents");
    expect(root.textContent).toContain("workspace snapshot");
    expect(root.textContent).not.toContain("Preview data");
    expect(root.querySelector(".shell-workbench")?.getAttribute("data-shell-source")).toBe(
      "runtime",
    );
    expect(root.textContent).not.toMatch(/\blive\b/u);
    expect(root.querySelector(".status-strip button")).toBeNull();
    expect(root.querySelector(".status-strip__guidance")?.textContent).toContain("Retry");
    expect(root.querySelector(".status-strip__connection")?.getAttribute("title")).toContain(
      "reconnecting",
    );
    expect(root.querySelector(".status-strip__guidance")?.getAttribute("title")).toContain("Retry");
    expect(root.querySelector(".palette-trigger kbd")?.textContent).toBe("⌘K");
    expect(root.querySelector("#sidebar-agent-agent\\.pm")?.getAttribute("aria-label")).toBe(
      "Fable, waiting, needs attention",
    );
    for (const tab of root.querySelectorAll<HTMLButtonElement>('.primary-tabs [role="tab"]')) {
      expect(tab.getAttribute("aria-disabled")).toBe("false");
    }

    const disabledDockTab = root.querySelector<HTMLButtonElement>("#workbench-dock-tab-activity")!;
    expect(disabledDockTab.disabled).toBe(true);
    expect(disabledDockTab.getAttribute("aria-label")).toContain(
      "Activity requires a daemon connection",
    );
    expect(disabledDockTab.title).toContain("Activity requires a daemon connection");

    const returnTarget = root.querySelector<HTMLButtonElement>("#primary-tab-terminals")!;
    returnTarget.focus();
    expect(document.activeElement).toBe(returnTarget);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("aria-controls")).toBe("application-command-palette-list");
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(root.querySelector('[role="listbox"]')).not.toBeNull();
    const disabledOption = root.querySelector<HTMLElement>("#palette-option-activity")!;
    expect(disabledOption.getAttribute("aria-disabled")).toBe("true");
    expect(disabledOption.textContent).toContain("Activity requires a daemon connection");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-option-missions");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(document.activeElement).toBe(returnTarget));

    expect(styles).toContain("grid-template-rows: 28px minmax(0, 1fr) 18px");
    expect(styles).toContain("grid-template-columns: 48px minmax(0, 1fr)");
    expect(styles).toContain("width: 456px");
    expect(styles).toMatch(
      /@media \(max-width: 999px\)[\s\S]*?\.status-strip__safe \{\s*display: none;[\s\S]*?\.status-strip__guidance \{[\s\S]*?max-width: 184px;[\s\S]*?text-overflow: ellipsis;/u,
    );
    expect(styles).not.toMatch(
      /\.command-palette(?:-overlay)?(?:--open)?\s*\{[^}]*(?:transition|transform)\s*:/gu,
    );
    expect(styles).toContain('.status-strip__connection[data-state="recovering"] > i');
    expect(paneFrameStyles).toContain('.web-pane-frame[data-border-role="focused"]');
    expect(styles).not.toMatch(/^\[data-state=/mu);
  });

  it("uses Ctrl K outside Darwin", () => {
    const root = renderShell(createDefaultDomShellInput(), undefined, "linux");
    expect(root.querySelector(".palette-trigger kbd")?.textContent).toBe("Ctrl K");
  });

  it("routes pane chrome commands through the explicit semantic host boundary", () => {
    const onPaneAction = vi.fn<NonNullable<DomApplicationShellProps["onPaneAction"]>>();
    const root = renderShell(createDefaultDomShellInput(), undefined, "darwin", onPaneAction);
    const split = root.querySelector<HTMLButtonElement>(
      '[data-pane-id="pane.implementer"] [data-action-id="split"]',
    )!;

    pointerClick(split);
    split.click();

    expect(onPaneAction).toHaveBeenNthCalledWith(
      1,
      {
        kind: "action",
        paneId: "pane.implementer",
        actionId: "split",
        commandId: "pane.split",
      },
      "mouse",
    );
    expect(onPaneAction).toHaveBeenNthCalledWith(
      2,
      {
        kind: "action",
        paneId: "pane.implementer",
        actionId: "split",
        commandId: "pane.split",
      },
      "keyboard",
    );
  });

  it("keeps terminal mount identity while semantic focus and daemon-confirmed zoom change", () => {
    const onCommand = vi.fn<(invocation: ApplicationShellCommandInvocation) => void>();
    const onPaneAction = vi.fn<NonNullable<DomApplicationShellProps["onPaneAction"]>>();
    const [paneFrames, setPaneFrames] = createSignal<
      NonNullable<DomApplicationShellProps["paneFrames"]>
    >(
      createDefaultDomPaneFrames().map((model) => ({
        ...model,
        appearance: { ...model.appearance, structure: "docked" as const },
      })),
    );
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <DomApplicationShell
            host={host()}
            runtime="browser"
            platform="darwin"
            windowState={WINDOW_STATE}
            input={createDefaultDomShellInput()}
            dataMode="runtime"
            onCommand={onCommand}
            paneFrames={paneFrames()}
            onPaneAction={onPaneAction}
          />
        ),
        root,
      ),
    );
    const pane = root.querySelector<HTMLElement>('[data-pane-id="pane.pm"]')!;
    const otherPane = root.querySelector<HTMLElement>('[data-pane-id="pane.implementer"]')!;
    const zoom = pane.querySelector<HTMLButtonElement>('[data-command-id="pane.maximize.toggle"]')!;
    const terminalMount = pane.querySelector(".terminal-surface__viewport");

    expect(zoom.getAttribute("aria-label")).toBe("Maximize or restore");
    zoom.click();
    expect(onPaneAction).toHaveBeenCalledWith(
      {
        kind: "action",
        paneId: "pane.pm",
        actionId: "maximize-toggle",
        commandId: "pane.maximize.toggle",
      },
      "keyboard",
    );
    expect(pane.getAttribute("data-structure")).toBe("docked");

    setPaneFrames((current) =>
      current.map((model) =>
        model.pane.id === "pane.pm"
          ? {
              ...model,
              appearance: { ...model.appearance, structure: "maximized" as const },
              actions: model.actions.map((action) =>
                action.commandId === "pane.maximize.toggle"
                  ? {
                      ...action,
                      icon: "restore" as const,
                      label: "Restore",
                      description: "Restore pane layout",
                      pressed: true,
                    }
                  : action,
              ),
            }
          : model,
      ),
    );
    expect(pane.getAttribute("data-structure")).toBe("maximized");
    expect(root.querySelector(".agent-grid")?.getAttribute("data-has-maximized")).toBe("true");
    expect(otherPane.getAttribute("data-structure")).toBe("docked");
    expect(zoom.getAttribute("aria-label")).toBe("Restore pane layout");
    expect(zoom.getAttribute("aria-pressed")).toBe("true");
    expect(pane.querySelector(".terminal-surface__viewport")).toBe(terminalMount);

    pane
      .querySelector(".terminal-surface")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        args: { target: { kind: "pane", paneId: "pane.pm", input: "terminal" } },
        source: { kind: "mouse", surface: "application-shell" },
      }),
    );
    expect(pane.getAttribute("data-border-role")).toBe("focused");
    expect(pane.getAttribute("data-terminal-input-owner")).toBe("true");
    expect(otherPane.getAttribute("data-terminal-input-owner")).toBe("false");
    expect(pane.querySelector(".terminal-surface__viewport")).toBe(terminalMount);
    expect(styles).toContain(
      '.agent-grid[data-has-maximized="true"] > .web-pane-frame:not([data-structure="maximized"])',
    );
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).not.toContain("transition-all");
  });

  it("keeps compact session identity and connection state accessible at 720px", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(720);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(480);
    const root = renderShell();

    expect(root.querySelector(".workbench-dock")?.getAttribute("data-variant")).toBe("compact");
    expect(
      root.querySelector("#sidebar-session-session\\.product")?.getAttribute("aria-label"),
    ).toBe("Product, reconnecting, selected");
    expect(root.querySelector("#sidebar-session-session\\.docs")?.getAttribute("aria-label")).toBe(
      "Documentation, connected",
    );
    expect(styles).toMatch(
      /@media \(max-width: 999px\)[\s\S]*?\.sidebar-row span,[\s\S]*?display: none;/u,
    );
  });

  it("applies state tones to explicit indicators without recoloring their parent surfaces", () => {
    const root = renderShell();
    const experience = installApplicationStyles(root);
    const connection = root.querySelector<HTMLElement>(".status-strip__connection")!;
    const connectionIndicator = connection.querySelector<HTMLElement>("i")!;
    const runningPane = root.querySelector<HTMLElement>(
      '.web-pane-frame[data-pane-id="pane.implementer"]',
    )!;
    const runningIndicator = runningPane.querySelector<HTMLElement>('[data-item-kind="status"] i')!;
    const recoveryPane = root.querySelector<HTMLElement>(
      '.web-pane-frame[data-pane-id="pane.recovery"]',
    )!;
    const recoveryIndicator = recoveryPane.querySelector<HTMLElement>(
      '[data-item-kind="status"] i',
    )!;

    expect(getComputedStyle(connectionIndicator).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.status.warning],
    );
    expect(getComputedStyle(connection).backgroundColor).not.toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.status.warning],
    );
    expect(getComputedStyle(runningIndicator).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.status.info],
    );
    expect(getComputedStyle(runningPane).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.surface.terminal],
    );
    expect(getComputedStyle(runningPane).borderColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.border.focused],
    );
    expect(getComputedStyle(recoveryIndicator).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.status.danger],
    );
    expect(getComputedStyle(recoveryPane).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.surface.terminal],
    );
    expect(getComputedStyle(recoveryPane).borderColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.border.danger],
    );
  });

  it("makes an unavailable primary surface both explanatory and inert", () => {
    const input = createDefaultDomShellInput();
    const shell = projectDomApplicationShell(input, createDomShellReplayState(input));
    const activate = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <PrimaryNavigation
            items={shell.primaryNavigation.items.map((item) =>
              item.id === "home"
                ? { ...item, disabledReason: "Home is unavailable during recovery" }
                : item,
            )}
            onActivate={activate}
          />
        ),
        root,
      ),
    );

    const home = root.querySelector<HTMLButtonElement>("#primary-tab-home")!;
    expect(home.disabled).toBe(true);
    expect(home.getAttribute("aria-disabled")).toBe("true");
    expect(home.tabIndex).toBe(-1);
    expect(root.querySelector<HTMLButtonElement>("#primary-tab-terminals")?.tabIndex).toBe(0);
    expect(home.title).toBe("Home is unavailable during recovery");
    expect(home.getAttribute("aria-label")).toContain("Home is unavailable during recovery");
    pointerClick(home);
    expect(activate).not.toHaveBeenCalled();
  });

  it("emits the canonical pointer and palette keyboard command trace", async () => {
    const input = createDefaultDomShellInput();
    const invocations: ApplicationShellCommandInvocation[] = [];
    const root = renderShell(input, (invocation) => invocations.push(invocation));

    for (const surface of ["home", "terminals"]) {
      pointerClick(root.querySelector(`#primary-tab-${surface}`)!);
    }
    for (const surface of ["files", "changes", "missions", "activity"]) {
      pointerClick(root.querySelector(`#workbench-dock-tab-${surface}`)!);
    }
    pointerClick(root.querySelector('[data-action="toggle-collapse"]')!);
    pointerClick(root.querySelector('[data-action="toggle-collapse"]')!);
    pointerClick(root.querySelector('[data-action="toggle-maximize"]')!);

    const returnTarget = root.querySelector<HTMLButtonElement>("#workbench-dock-tab-activity")!;
    returnTarget.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
    const paletteInput = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(paletteInput));
    paletteInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const expected = applicationShellActionTraceV1(input).invocations.map(
      (invocation, index): ApplicationShellCommandInvocation => ({
        ...invocation,
        source:
          index < 2
            ? { kind: "mouse", surface: "primary-navigation" }
            : index < 17
              ? { kind: "mouse", surface: "bottom-dock" }
              : index < 19
                ? { kind: "keyboard", surface: "application-shell" }
                : { kind: "keyboard", surface: "command-palette" },
      }),
    );
    expect(invocations).toEqual(expected);
    expect(invocations.at(-2)?.id).toBe(APPLICATION_SHELL_COMMAND_IDS.openPalette);
    expect(invocations.at(-2)?.source.kind).toBe("keyboard");
    expect(invocations.at(-1)?.id).toBe(APPLICATION_SHELL_COMMAND_IDS.closePalette);
  });

  it("routes function-key activation through the same canonical command", () => {
    const invocations: ApplicationShellCommandInvocation[] = [];
    renderShell(createDefaultDomShellInput(), (invocation) => invocations.push(invocation));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", bubbles: true }));

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      id: APPLICATION_SHELL_COMMAND_IDS.activateMode,
      args: { mode: "home" },
      source: { kind: "keyboard", surface: "application-shell" },
    });
  });

  it("preserves keyboard and real-pointer provenance from the palette trigger", () => {
    const invocations: ApplicationShellCommandInvocation[] = [];
    const root = renderShell(createDefaultDomShellInput(), (invocation) =>
      invocations.push(invocation),
    );
    const trigger = root.querySelector<HTMLButtonElement>("#application-command-palette-trigger")!;

    trigger.click();
    expect(invocations.slice(0, 2).map(({ id, source }) => ({ id, source }))).toEqual([
      {
        id: APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        source: { kind: "keyboard", surface: "application-bar" },
      },
      {
        id: APPLICATION_SHELL_COMMAND_IDS.openPalette,
        source: { kind: "keyboard", surface: "application-bar" },
      },
    ]);

    root
      .querySelector<HTMLInputElement>('[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    pointerClick(trigger);
    expect(invocations.slice(-2).map(({ id, source }) => ({ id, source }))).toEqual([
      {
        id: APPLICATION_SHELL_COMMAND_IDS.moveFocus,
        source: { kind: "mouse", surface: "application-bar" },
      },
      {
        id: APPLICATION_SHELL_COMMAND_IDS.openPalette,
        source: { kind: "mouse", surface: "application-bar" },
      },
    ]);
  });

  it("marks fallback data as preview-only and never claims fixture recovery is live", () => {
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <DomApplicationShell
            host={host()}
            runtime="browser"
            platform="darwin"
            windowState={WINDOW_STATE}
            dataMode="preview"
          />
        ),
        root,
      ),
    );

    expect(root.querySelector(".titlebar__preview-badge")?.textContent).toBe("Preview data");
    expect(root.querySelector(".shell-workbench")?.getAttribute("data-shell-source")).toBe(
      "preview",
    );
    expect(root.querySelector(".status-strip")?.getAttribute("data-shell-source")).toBe("preview");
    expect(root.querySelector(".status-strip__connection")?.textContent).toContain(
      "Preview workspace — daemon state is still loading",
    );
    expect(root.querySelector(".status-strip__safe")?.textContent).toBe("Illustrative data only");
    expect(root.textContent).not.toContain("agent processes remain active");
    expect(root.textContent).not.toContain("Retry the attachment");
  });

  it.each([
    {
      state: {
        status: "connected" as const,
        identity: {
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
      },
      message: "Daemon connected — 2.8.0",
      safe: "Preview data remains illustrative",
    },
    {
      state: {
        status: "unavailable" as const,
        code: "health-unreachable" as const,
        reason: "Health endpoint is unreachable",
      },
      message: "Daemon unavailable — Health endpoint is unreachable",
      safe: "Illustrative data only",
    },
    {
      state: {
        status: "degraded" as const,
        code: "identity-mismatch" as const,
        reason: "Identity does not match",
      },
      message: "Daemon verification degraded — Identity does not match",
      safe: "Illustrative data only",
    },
  ])(
    "surfaces honest $state.status host state without relabeling preview data",
    ({ state, message, safe }) => {
      const root = document.createElement("div");
      document.body.append(root);
      disposers.push(
        render(
          () => (
            <DomApplicationShell
              host={host()}
              daemonState={state}
              runtime="electron"
              platform="darwin"
              windowState={WINDOW_STATE}
              dataMode="preview"
            />
          ),
          root,
        ),
      );

      expect(root.querySelector(".titlebar__preview-badge")?.textContent).toBe("Preview data");
      expect(root.querySelector(".status-strip__connection")?.textContent).toContain(message);
      expect(root.querySelector(".status-strip__safe")?.textContent).toBe(safe);
    },
  );

  it("reacts to replacement snapshots while preserving valid local state and stable leaves", async () => {
    const initial = createDefaultDomShellInput();
    const [input, setInput] = createSignal(initial);
    const root = document.createElement("div");
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <DomApplicationShell
            host={host()}
            runtime="browser"
            platform="darwin"
            windowState={WINDOW_STATE}
            input={input()}
            dataMode="runtime"
          />
        ),
        root,
      ),
    );

    pointerClick(root.querySelector("#workbench-dock-tab-files")!);
    pointerClick(root.querySelector('[data-action="toggle-maximize"]')!);
    pointerClick(root.querySelector("#sidebar-session-session\\.docs")!);
    pointerClick(root.querySelector("#primary-tab-home")!);
    const homeLeaf = root.querySelector("#primary-tab-home");
    const filesLeaf = root.querySelector("#workbench-dock-tab-files");
    const docsLeaf = root.querySelector("#sidebar-session-session\\.docs");

    setInput(updatedSameWorkspace(initial));
    await vi.waitFor(() =>
      expect(root.querySelector(".titlebar__brand")?.textContent).toContain("tmux-ide reactive"),
    );

    expect(root.querySelector("#primary-tab-home")).toBe(homeLeaf);
    expect(root.querySelector("#workbench-dock-tab-files")).toBe(filesLeaf);
    expect(root.querySelector("#sidebar-session-session\\.docs")).toBe(docsLeaf);
    expect(root.querySelector("#primary-tab-home")?.getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector("#workbench-dock-tab-files")?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(root.querySelector(".workspace-main")?.getAttribute("data-dock-mode")).toBe("maximized");
    expect(docsLeaf?.getAttribute("aria-pressed")).toBe("true");
    expect(root.textContent).toContain("Reactive workspace");
    expect(root.textContent).toContain("Fresh documentation");
    expect(root.textContent).toContain("Codex refreshed");
    expect(root.textContent).toContain("999 indexed files");
    expect(root.textContent).toContain("Connected from fresh host snapshot");
  });

  it("selects session and agent rows visibly while emitting canonical resource commands", () => {
    const invocations: ApplicationShellCommandInvocation[] = [];
    const root = renderShell(createDefaultDomShellInput(), (invocation) =>
      invocations.push(invocation),
    );
    const product = root.querySelector<HTMLButtonElement>("#sidebar-session-session\\.product")!;
    const docs = root.querySelector<HTMLButtonElement>("#sidebar-session-session\\.docs")!;
    const reviewer = root.querySelector<HTMLButtonElement>("#sidebar-agent-agent\\.reviewer")!;

    expect(product.getAttribute("aria-pressed")).toBe("true");
    pointerClick(docs);
    expect(product.getAttribute("aria-pressed")).toBe("false");
    expect(docs.getAttribute("aria-pressed")).toBe("true");
    pointerClick(reviewer);
    expect(docs.getAttribute("aria-pressed")).toBe("false");
    expect(reviewer.getAttribute("aria-pressed")).toBe("true");
    expect(invocations).toEqual([
      expect.objectContaining({
        id: APPLICATION_SHELL_COMMAND_IDS.selectResource,
        args: { surface: "terminals", resourceId: "session.docs" },
        source: { kind: "mouse", surface: "sidebar" },
      }),
      expect.objectContaining({
        id: APPLICATION_SHELL_COMMAND_IDS.selectResource,
        args: { surface: "terminals", resourceId: "agent.reviewer" },
        source: { kind: "mouse", surface: "sidebar" },
      }),
    ]);
  });
});
