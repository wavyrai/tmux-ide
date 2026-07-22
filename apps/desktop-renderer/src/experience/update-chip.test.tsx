/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import type { DesktopUpdateStatus, HostCapabilities } from "@tmux-ide/contracts";

import { UpdateChip } from "./update-chip.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.innerHTML = "";
});

function hostWith(input: {
  initial: DesktopUpdateStatus;
  onStatusChanged?: HostCapabilities["update"]["onStatusChanged"];
}): HostCapabilities {
  return {
    update: {
      getStatus: async () => input.initial,
      onStatusChanged: input.onStatusChanged ?? (() => () => undefined),
    },
  } as unknown as HostCapabilities;
}

function mount(host: HostCapabilities): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  disposers.push(render(() => <UpdateChip host={host} />, root));
  return root;
}

const IDLE: DesktopUpdateStatus = {
  phase: "idle",
  currentVersion: "2.7.0",
  availableVersion: null,
};
const READY: DesktopUpdateStatus = {
  phase: "ready",
  currentVersion: "2.7.0",
  availableVersion: "2.8.0",
};

describe("UpdateChip", () => {
  it("renders nothing while idle", async () => {
    const root = mount(hostWith({ initial: IDLE }));
    await vi.waitFor(() => expect(root).toBeTruthy());
    expect(root.querySelector(".titlebar__update-chip")).toBeNull();
  });

  it("shows a quiet chip with the version when an update is staged", async () => {
    const root = mount(hostWith({ initial: READY }));
    await vi.waitFor(() => {
      const chip = root.querySelector(".titlebar__update-chip");
      expect(chip).not.toBeNull();
    });
    const chip = root.querySelector(".titlebar__update-chip");
    expect(chip?.textContent).toContain("Update ready");
    expect(chip?.textContent).toContain("v2.8.0");
    expect(chip?.textContent).toContain("restart to apply");
    expect(chip?.getAttribute("role")).toBe("status");
  });

  it("appears when the host pushes a ready status after mount", async () => {
    let publish: ((status: DesktopUpdateStatus) => void) | null = null;
    const root = mount(
      hostWith({
        initial: IDLE,
        onStatusChanged: (listener) => {
          publish = listener;
          return () => undefined;
        },
      }),
    );
    await vi.waitFor(() => expect(publish).not.toBeNull());
    expect(root.querySelector(".titlebar__update-chip")).toBeNull();

    publish!(READY);
    await vi.waitFor(() => {
      expect(root.querySelector(".titlebar__update-chip")).not.toBeNull();
    });
  });

  it("unsubscribes on cleanup", async () => {
    const unsubscribe = vi.fn();
    const root = mount(hostWith({ initial: IDLE, onStatusChanged: () => unsubscribe }));
    await vi.waitFor(() => expect(root).toBeTruthy());
    for (const dispose of disposers.splice(0)) dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
