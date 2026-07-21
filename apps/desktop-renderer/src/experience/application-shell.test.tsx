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
import { render } from "solid-js/web";

import { DomApplicationShell, PrimaryNavigation } from "./application-shell.tsx";
import {
  createDefaultDomShellInput,
  createDomShellReplayState,
  projectDomApplicationShell,
} from "./dom-shell.ts";
import styles from "../styles.css?raw";

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
      daemon: { status: "deferred", reason: "fixture only" },
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
          onCommand={onCommand}
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

afterEach(() => {
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
    expect(root.textContent).toContain("preview snapshot");
    expect(root.textContent).not.toMatch(/\blive\b/u);
    expect(root.querySelector(".status-strip button")).toBeNull();
    expect(root.querySelector(".status-strip__guidance")?.textContent).toContain("Retry");
    expect(root.querySelector(".status-strip__connection")?.getAttribute("title")).toContain(
      "reconnecting",
    );
    expect(root.querySelector(".status-strip__guidance")?.getAttribute("title")).toContain("Retry");
    expect(root.querySelector(".palette-trigger kbd")?.textContent).toBe("⌘K");
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
  });

  it("uses Ctrl K outside Darwin", () => {
    const root = renderShell(createDefaultDomShellInput(), undefined, "linux");
    expect(root.querySelector(".palette-trigger kbd")?.textContent).toBe("Ctrl K");
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

    const expected = applicationShellActionTraceV1(input).invocations;
    expect(invocations.map(({ id, args }) => ({ id, args }))).toEqual(
      expected.map(({ id, args }) => ({ id, args })),
    );
    expect(invocations[0]?.source.kind).toBe("mouse");
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
});
