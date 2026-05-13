import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  ComposerPendingApprovalPanel,
  type PendingApprovalRequest,
} from "../src/components/ComposerPendingApprovalPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountPanel(opts: {
  approval: PendingApprovalRequest | null;
  pendingCount?: number;
  isResponding?: boolean;
  onRespond?: ReturnType<typeof vi.fn>;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onRespond = opts.onRespond ?? vi.fn();
  render(
    () => (
      <ComposerPendingApprovalPanel
        approval={() => opts.approval}
        pendingCount={() => opts.pendingCount ?? 1}
        isResponding={() => opts.isResponding ?? false}
        onRespond={onRespond}
      />
    ),
    container,
  );
  return { container, onRespond };
}

describe("ComposerPendingApprovalPanel", () => {
  it("renders nothing when there is no approval", () => {
    const { container } = mountPanel({ approval: null });
    expect(
      container.querySelector("[data-testid='composer-pending-approval-panel']"),
    ).toBeNull();
  });

  it("renders the request kind headline and the command summary", () => {
    const { container } = mountPanel({
      approval: {
        requestId: "req-1",
        kind: "command",
        summary: "rm -rf /tmp/cache",
        source: "claude-code",
      },
    });
    const panel = container.querySelector(
      "[data-testid='composer-pending-approval-panel']",
    ) as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("data-request-kind")).toBe("command");
    expect(panel.getAttribute("data-request-id")).toBe("req-1");
    expect(panel.textContent).toContain("Command approval requested");
    expect(panel.textContent).toContain("rm -rf /tmp/cache");
  });

  it("shows the 1/N counter when pendingCount > 1", () => {
    const { container } = mountPanel({
      approval: { requestId: "req-2", kind: "file-change" },
      pendingCount: 3,
    });
    const counter = container.querySelector("[data-testid='pending-approval-counter']");
    expect(counter?.textContent).toBe("1/3");
  });

  it("dispatches the correct decision per button", () => {
    const onRespond = vi.fn();
    const { container } = mountPanel({
      approval: { requestId: "req-3", kind: "file-read" },
      onRespond,
    });
    (container.querySelector("[data-testid='approval-accept']") as HTMLButtonElement).click();
    (container.querySelector("[data-testid='approval-decline']") as HTMLButtonElement).click();
    (container.querySelector("[data-testid='approval-always-allow']") as HTMLButtonElement).click();
    (container.querySelector("[data-testid='approval-cancel']") as HTMLButtonElement).click();
    expect(onRespond.mock.calls).toEqual([
      ["req-3", "accept"],
      ["req-3", "decline"],
      ["req-3", "acceptForSession"],
      ["req-3", "cancel"],
    ]);
  });

  it("disables every action button while isResponding", () => {
    const { container } = mountPanel({
      approval: { requestId: "req-4", kind: "command", summary: "ls" },
      isResponding: true,
    });
    for (const id of [
      "approval-cancel",
      "approval-decline",
      "approval-always-allow",
      "approval-accept",
    ]) {
      const btn = container.querySelector(`[data-testid='${id}']`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
  });

  it("re-renders when the approval signal swaps requests", () => {
    const [approval, setApproval] = createSignal<PendingApprovalRequest | null>({
      requestId: "first",
      kind: "command",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => (
        <ComposerPendingApprovalPanel
          approval={approval}
          pendingCount={() => 1}
          isResponding={() => false}
          onRespond={() => undefined}
        />
      ),
      container,
    );
    expect(
      container
        .querySelector("[data-testid='composer-pending-approval-panel']")
        ?.getAttribute("data-request-id"),
    ).toBe("first");
    setApproval({ requestId: "second", kind: "file-change" });
    expect(
      container
        .querySelector("[data-testid='composer-pending-approval-panel']")
        ?.getAttribute("data-request-id"),
    ).toBe("second");
  });
});
