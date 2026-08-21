/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { DesktopConnectionSurface } from "./live-app-composition.tsx";

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
