/**
 * Renders the approval headline next to a `1/N` badge when the
 * pendingCount > 1. The summary copy is keyed on the coarse
 * `requestKind` so the daemon doesn't have to leak raw tool names.
 *
 * Component is pure render — these tests fully cover its three
 * branches plus the count-badge gate.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { ComposerPendingApprovalPanel } from "../src/components/ComposerPendingApprovalPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(
  approval: { requestId: string; requestKind: "command" | "file-read" | "file-change" },
  pendingCount = 1,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => <ComposerPendingApprovalPanel approval={approval} pendingCount={pendingCount} />,
    container,
  );
  return { container, dispose };
}

describe("ComposerPendingApprovalPanel", () => {
  it("renders the command summary for requestKind=command", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "command" });
    expect(container.textContent).toContain("PENDING APPROVAL");
    expect(container.textContent).toContain("Command approval requested");
    dispose();
  });

  it("renders the file-read summary for requestKind=file-read", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "file-read" });
    expect(container.textContent).toContain("File-read approval requested");
    dispose();
  });

  it("renders the file-change summary for requestKind=file-change", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "file-change" });
    expect(container.textContent).toContain("File-change approval requested");
    dispose();
  });

  it("hides the count badge when only one approval is pending", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "command" }, 1);
    expect(container.textContent).not.toMatch(/1\/\d/);
    dispose();
  });

  it("renders the 1/N badge when multiple approvals are pending", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "command" }, 3);
    expect(container.textContent).toContain("1/3");
    dispose();
  });

  it("exposes the requestKind on the root for hosts to query", () => {
    const { container, dispose } = mount({ requestId: "r1", requestKind: "file-change" });
    const root = container.querySelector("[data-testid='composer-pending-approval-panel']");
    expect(root?.getAttribute("data-request-kind")).toBe("file-change");
    dispose();
  });
});
