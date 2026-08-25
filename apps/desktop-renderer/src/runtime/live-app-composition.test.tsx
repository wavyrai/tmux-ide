/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { initialInteractionFeedState } from "@tmux-ide/core";
import {
  DesktopConnectionSurface,
  paneFrameSemanticIntent,
  projectWebWorkspaceReceipt,
} from "./live-app-composition.tsx";

let dispose: (() => void) | null = null;

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

function mount(node: () => unknown): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  dispose = render(node as never, host);
  return host;
}

describe("DesktopConnectionSurface recovery command", () => {
  it("maps production pane actions to exactly workspace-bound semantic intents", () => {
    expect(
      paneFrameSemanticIntent("alpha", {
        kind: "action",
        paneId: "pane.alpha",
        actionId: "action.maximize",
        commandId: "workspace.windowMode.maximize.toggle",
      }),
    ).toEqual({
      verb: "workspace.pane.zoom.toggle",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      desired: "toggle",
    });
    expect(
      paneFrameSemanticIntent("alpha", {
        kind: "action",
        paneId: "pane.alpha",
        actionId: "maximize-toggle",
        commandId: "pane.maximize.toggle",
      }),
    ).toEqual({
      verb: "workspace.pane.zoom.toggle",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      desired: "toggle",
    });
    expect(paneFrameSemanticIntent("alpha", { kind: "grip", paneId: "pane.alpha" })).toEqual({
      verb: "workspace.pane.select",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
    });
    expect(
      paneFrameSemanticIntent("alpha", {
        kind: "action",
        paneId: "pane.alpha",
        actionId: "action.menu",
        commandId: "workspace.pane.menu.open",
      }),
    ).toBeNull();
  });

  it("projects one WorkspaceClient receipt phase exactly once", () => {
    const receipt = {
      type: "interaction.receipt" as const,
      sequence: 1,
      operationId: "10000000-0000-4000-8000-000000000001",
      origin: "gui" as const,
      workspaceName: "alpha",
      sourceSemanticPaneId: null,
      target: { kind: "pane" as const, semanticPaneId: "pane.alpha" },
      operationKind: "workspace.pane.select" as const,
      phase: "accepted" as const,
      summary: { operationKind: "workspace.pane.select" as const },
      proof: null,
      at: "2026-08-23T20:00:00.000Z",
      resourceRevision: null,
    };
    const first = projectWebWorkspaceReceipt({
      feed: initialInteractionFeedState(),
      lastReceiptKey: "",
      receipt,
    });
    const duplicate = projectWebWorkspaceReceipt({
      feed: first.feed,
      lastReceiptKey: first.lastReceiptKey,
      receipt,
    });
    expect(first.feed.activity).toHaveLength(1);
    expect(duplicate.feed).toBe(first.feed);
  });

  it("renders stopped workspace intent as disabled and non-attachable", () => {
    const onSelectWorkspace = vi.fn();
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(
      () => (
        <DesktopConnectionSurface
          state="chooser"
          eyebrow="Workspaces"
          title="Choose"
          description="Choose a workspace"
          guidance="Live only"
          workspaces={[
            { workspaceName: "running", availability: "live", paneCount: 2 },
            { workspaceName: "parked", availability: "stopped", paneCount: 0 },
          ]}
          onSelectWorkspace={onSelectWorkspace}
        />
      ),
      root,
    );

    const parked = [...root.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) =>
      button.textContent?.includes("parked"),
    );
    expect(parked?.disabled).toBe(true);
    expect(parked?.textContent).toContain("Stopped · not attachable");
    parked?.click();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    dispose();
    root.remove();
  });

  it("renders a copyable command block and copies on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const host = mount(() => (
      <DesktopConnectionSurface
        state="degraded"
        eyebrow="Missing dependency"
        title="tmux is not installed"
        description="tmux could not be found on this machine."
        guidance="Install tmux, then reopen tmux-ide"
        command="brew install tmux"
      />
    ));

    const code = host.querySelector(".runtime-state-card__command code");
    expect(code?.textContent).toBe("brew install tmux");

    const copyButton = [...host.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Copy command",
    );
    expect(copyButton).toBeTruthy();

    copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("brew install tmux");
  });

  it("omits the command block when no command is provided", () => {
    const host = mount(() => (
      <DesktopConnectionSurface
        state="degraded"
        eyebrow="Native tmux workspace"
        title="The engine needs attention"
        description="A health check failed."
        guidance="Recheck the daemon"
      />
    ));
    expect(host.querySelector(".runtime-state-card__command")).toBeNull();
  });
});
