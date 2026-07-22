/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { WorkspacePaneCreateInvocation } from "@tmux-ide/contracts";

import styles from "../styles.css?raw";
import { CreatePaneFlow } from "./create-pane-flow.tsx";
import type { CreatePaneFlowCatalogs } from "./create-pane-flow-presenter.ts";

const disposers: Array<() => void> = [];

function readyCatalogs(): CreatePaneFlowCatalogs {
  return {
    workspaces: {
      status: "ready",
      items: [
        { name: "tmux-ide", label: "tmux-ide", available: true },
        { name: "docs/site", label: "Documentation", available: true },
      ],
    },
    harnessProfiles: {
      status: "ready",
      items: [
        {
          id: "codex-implementer",
          label: "Codex implementer",
          description: "Implementation harness",
          available: true,
        },
        { id: "offline", label: "Offline profile", available: false },
      ],
    },
    missions: {
      status: "ready",
      items: [{ id: "parity", label: "Gloomberb parity", available: true }],
    },
  };
}

function renderFlow(
  catalogs: CreatePaneFlowCatalogs | (() => CreatePaneFlowCatalogs) = readyCatalogs(),
  onCommand: (invocation: WorkspacePaneCreateInvocation) => void | Promise<void> = vi.fn(
    async () => undefined,
  ),
  initialWorkspaceName?: string,
) {
  const root = document.createElement("div");
  document.body.append(root);
  const [open, setOpen] = createSignal(false);
  const openChanges: Array<{ open: boolean; source: string }> = [];
  const catalogsAccessor = typeof catalogs === "function" ? catalogs : () => catalogs;
  const disposeRender = render(
    () => (
      <CreatePaneFlow
        open={open()}
        catalogs={catalogsAccessor()}
        initialWorkspaceName={initialWorkspaceName}
        onOpenChange={(nextOpen, source) => {
          openChanges.push({ open: nextOpen, source });
          setOpen(nextOpen);
        }}
        onCommand={onCommand}
      />
    ),
    root,
  );
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    disposeRender();
  };
  disposers.push(dispose);
  return { root, open, setOpen, openChanges, onCommand, dispose };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function key(element: EventTarget, value: string, options: KeyboardEventInit = {}): void {
  element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, ...options }));
}

function change(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  element.value = value;
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

function pointerClick(element: Element): void {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe("native create terminal / agent flow", () => {
  it("opens from one keyboard-complete + action, traps focus, and restores focus on Escape", async () => {
    const { root, openChanges } = renderFlow();
    const trigger = root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!;
    const overlay = root.querySelector<HTMLElement>(".create-pane-flow__overlay")!;
    const dialog = root.querySelector<HTMLElement>("#create-pane-flow-dialog")!;
    const close = root.querySelector<HTMLButtonElement>(".create-pane-flow__close")!;
    const kindCards = root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card");

    expect(trigger.textContent).toContain("+");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    trigger.focus();
    trigger.click();

    await vi.waitFor(() => expect(document.activeElement).toBe(kindCards[0]));
    expect(overlay.getAttribute("aria-hidden")).toBe("false");
    expect(overlay.dataset.transitionSource).toBe("keyboard");
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    close.focus();
    key(close, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(kindCards[1]);
    key(kindCards[1]!, "Tab");
    expect(document.activeElement).toBe(close);

    key(close, "Escape");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    expect(openChanges).toEqual([
      { open: true, source: "keyboard" },
      { open: false, source: "keyboard" },
    ]);
  });

  it("submits a terminal from Enter through the canonical semantic command", async () => {
    const onCommand = vi.fn<(invocation: WorkspacePaneCreateInvocation) => Promise<void>>(
      async () => undefined,
    );
    const { root } = renderFlow(readyCatalogs(), onCommand, "tmux-ide");
    const trigger = root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!;
    trigger.focus();
    trigger.click();
    const terminal = root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[0]!;
    await vi.waitFor(() => expect(document.activeElement).toBe(terminal));

    key(terminal, "Enter");
    const workspace = root.querySelector<HTMLSelectElement>("#create-pane-flow-workspace")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(workspace));
    expect(workspace.value).toBe("tmux-ide");
    expect(workspace.required).toBe(true);
    expect(workspace.getAttribute("aria-required")).toBe("true");
    const title = root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!;
    change(title, "Release shell");
    key(title, "Enter");

    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith({
      version: 1,
      id: "workspace.pane.create",
      source: { kind: "keyboard", surface: "create-pane-dialog" },
      args: {
        kind: "terminal",
        workspaceName: "tmux-ide",
        displayTitle: "Release shell",
      },
    });
    expect(onCommand.mock.calls[0]?.[0].args).not.toHaveProperty("cwd");
    expect(onCommand.mock.calls[0]?.[0].args).not.toHaveProperty("sessionName");
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("submits an agent using only exposed harness, role, and mission resources", async () => {
    const onCommand = vi.fn<(invocation: WorkspacePaneCreateInvocation) => Promise<void>>(
      async () => undefined,
    );
    const { root } = renderFlow(readyCatalogs(), onCommand);
    pointerClick(root.querySelector("#create-pane-flow-trigger")!);
    const agent = root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[1]!;
    await vi.waitFor(() => expect(document.activeElement).not.toBeNull());
    pointerClick(agent);

    change(root.querySelector<HTMLSelectElement>("#create-pane-flow-workspace")!, "tmux-ide");
    change(
      root.querySelector<HTMLSelectElement>("#create-pane-flow-harness")!,
      "codex-implementer",
    );
    expect(root.querySelector<HTMLSelectElement>("#create-pane-flow-harness")!.required).toBe(true);
    expect(
      root
        .querySelector<HTMLSelectElement>("#create-pane-flow-harness")!
        .getAttribute("aria-required"),
    ).toBe("true");
    change(root.querySelector<HTMLSelectElement>("#create-pane-flow-role")!, "reviewer");
    change(root.querySelector<HTMLSelectElement>("#create-pane-flow-mission")!, "parity");
    change(root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!, "Review");
    pointerClick(root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!);

    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith({
      version: 1,
      id: "workspace.pane.create",
      source: { kind: "mouse", surface: "create-pane-dialog" },
      args: {
        kind: "agent",
        workspaceName: "tmux-ide",
        displayTitle: "Review",
        harnessProfileId: "codex-implementer",
        role: "reviewer",
        missionId: "parity",
      },
    });
    expect(onCommand.mock.calls[0]?.[0].args).not.toHaveProperty("argv");
    expect(onCommand.mock.calls[0]?.[0].args).not.toHaveProperty("command");
  });

  it("keeps stable dialog/form nodes while switching kind and open state", async () => {
    const { root } = renderFlow(readyCatalogs(), undefined, "tmux-ide");
    const overlay = root.querySelector(".create-pane-flow__overlay");
    const workspace = root.querySelector("#create-pane-flow-workspace");
    const harness = root.querySelector("#create-pane-flow-harness");
    const trigger = root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!;

    trigger.click();
    await vi.waitFor(() =>
      expect(root.querySelector(".create-pane-flow__kind")?.hasAttribute("hidden")).toBe(false),
    );
    root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[1]!.click();
    expect(root.querySelector("#create-pane-flow-workspace")).toBe(workspace);
    expect(root.querySelector("#create-pane-flow-harness")).toBe(harness);
    root.querySelector<HTMLButtonElement>(".create-pane-flow__form-heading button")!.click();
    root.querySelector<HTMLButtonElement>(".create-pane-flow__close")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector(".create-pane-flow__overlay")?.getAttribute("aria-hidden")).toBe(
        "true",
      ),
    );

    expect(root.querySelector(".create-pane-flow__overlay")).toBe(overlay);
    expect(root.querySelector("#create-pane-flow-workspace")).toBe(workspace);
    expect(root.querySelector("#create-pane-flow-harness")).toBe(harness);
  });

  it("shows explicit loading and empty states instead of guessing resources", async () => {
    const { root } = renderFlow({
      workspaces: { status: "loading" },
      harnessProfiles: { status: "ready", items: [] },
      missions: { status: "unavailable" },
    });
    root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!.click();
    const agent = root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[1]!;
    await vi.waitFor(() => expect(document.activeElement).toBeDefined());
    agent.click();

    const workspace = root.querySelector<HTMLSelectElement>("#create-pane-flow-workspace")!;
    const harness = root.querySelector<HTMLSelectElement>("#create-pane-flow-harness")!;
    const mission = root.querySelector<HTMLSelectElement>("#create-pane-flow-mission")!;
    const title = root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(title));
    expect(workspace.disabled).toBe(true);
    expect(workspace.textContent).toContain("Loading workspaces");
    expect(harness.textContent).toContain("No agent profiles available");
    expect(root.textContent).toContain("No profiles are exposed yet");
    expect(mission.disabled).toBe(true);
    expect(mission.textContent).toContain("Missions unavailable");

    root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!.click();
    await vi.waitFor(() =>
      expect(root.textContent).toContain("Workspace choices are still loading"),
    );
    expect(document.activeElement).toBe(root.querySelector(`#create-pane-flow-workspace-error`));
  });

  it.each(["loading", "unavailable"] as const)(
    "focuses the first enabled form field when workspace choices are %s",
    async (status) => {
      const { root } = renderFlow({
        ...readyCatalogs(),
        workspaces: { status },
      });
      root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!.click();
      root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[0]!.click();

      const workspace = root.querySelector<HTMLSelectElement>("#create-pane-flow-workspace")!;
      const title = root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!;
      expect(workspace.disabled).toBe(true);
      await vi.waitFor(() => expect(document.activeElement).toBe(title));
    },
  );

  it("preserves selections and reports a sanitized callback failure", async () => {
    const onCommand = vi.fn<(invocation: WorkspacePaneCreateInvocation) => Promise<void>>(
      async () => {
        throw new Error("secret cwd /Users/private and pane %42");
      },
    );
    const { root } = renderFlow(readyCatalogs(), onCommand, "tmux-ide");
    root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!.click();
    root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[0]!.click();
    const title = root.querySelector<HTMLInputElement>("#create-pane-flow-display-title")!;
    change(title, "Keep me");
    root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!.click();

    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')).not.toBeNull());
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      "could not submit this request",
    );
    expect(root.textContent).not.toContain("/Users/private");
    expect(root.textContent).not.toContain("%42");
    expect(title.value).toBe("Keep me");
    expect(root.querySelector(".create-pane-flow__overlay")?.getAttribute("aria-hidden")).toBe(
      "false",
    );
  });

  it.each(["resolve", "reject"] as const)(
    "retires pending submission callbacks when the component unmounts before %s",
    async (outcome) => {
      const pending = deferred();
      const onCommand = vi.fn(() => pending.promise);
      const { root, openChanges, dispose } = renderFlow(readyCatalogs(), onCommand, "tmux-ide");
      root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!.click();
      root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[0]!.click();
      root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!.click();
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));

      dispose();
      if (outcome === "resolve") pending.resolve();
      else pending.reject(new Error("late secret /Users/private %42"));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();

      expect(root.childElementCount).toBe(0);
      expect(openChanges).toEqual([{ open: true, source: "keyboard" }]);
    },
  );

  it("associates role and mission errors when selected agent resources become invalid", async () => {
    const [catalogs, setCatalogs] = createSignal(readyCatalogs());
    const { root, onCommand } = renderFlow(catalogs, undefined, "tmux-ide");
    root.querySelector<HTMLButtonElement>("#create-pane-flow-trigger")!.click();
    root.querySelectorAll<HTMLButtonElement>(".create-pane-flow__kind-card")[1]!.click();
    change(
      root.querySelector<HTMLSelectElement>("#create-pane-flow-harness")!,
      "codex-implementer",
    );

    const role = root.querySelector<HTMLSelectElement>("#create-pane-flow-role")!;
    change(role, "unsupported-role");
    root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!.click();
    await vi.waitFor(() =>
      expect(root.querySelector("#create-pane-flow-role-error")).not.toBeNull(),
    );
    expect(role.getAttribute("aria-describedby")).toBe("create-pane-flow-role-error");
    expect(document.activeElement).toBe(role);
    expect(onCommand).not.toHaveBeenCalled();

    change(role, "reviewer");
    const mission = root.querySelector<HTMLSelectElement>("#create-pane-flow-mission")!;
    change(mission, "parity");
    setCatalogs({
      ...readyCatalogs(),
      missions: { status: "ready", items: [] },
    });
    await vi.waitFor(() => expect(mission.querySelector('[value="parity"]')).toBeNull());
    root.querySelector<HTMLButtonElement>(".create-pane-flow__submit")!.click();

    await vi.waitFor(() =>
      expect(root.querySelector("#create-pane-flow-mission-error")).not.toBeNull(),
    );
    expect(mission.getAttribute("aria-describedby")).toBe("create-pane-flow-mission-error");
    expect(root.querySelector("#create-pane-flow-mission-error")?.textContent).toContain(
      "available mission",
    );
    expect(document.activeElement).toBe(mission);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("animates pointer-open overlays only and honors product reduced-motion policy", () => {
    expect(styles).toContain('.create-pane-flow__overlay[data-transition-source="mouse"]');
    expect(styles).not.toContain('.create-pane-flow__overlay[data-transition-source="keyboard"]');
    expect(styles).not.toMatch(/\.create-pane-flow[^}]*transition-all/gu);
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition-duration: 0ms !important;[\s\S]*?animation-duration: 0ms !important;/u,
    );
  });
});
