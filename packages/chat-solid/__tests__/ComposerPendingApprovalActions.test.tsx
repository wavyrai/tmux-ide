/**
 * Four-button verdict cluster — wire coverage.
 *
 * Asserts every button dispatches `onRespondToApproval` with the
 * correct (requestId, decision) tuple and that `isResponding` flips
 * every button into the disabled state. The in-flight gate is what
 * stops a frantic double-click from racing two decisions onto the
 * daemon.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  ComposerPendingApprovalActions,
  type ProviderApprovalDecision,
} from "../src/components/ComposerPendingApprovalActions";

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(opts: { isResponding?: boolean; requestId?: string } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [requestId] = createSignal(opts.requestId ?? "req-1");
  const [isResponding, setIsResponding] = createSignal(opts.isResponding ?? false);
  const onRespond = vi.fn(async (_id: string, _decision: ProviderApprovalDecision) => undefined);

  const dispose = render(
    () => (
      <ComposerPendingApprovalActions
        requestId={requestId}
        isResponding={isResponding}
        onRespondToApproval={onRespond}
      />
    ),
    container,
  );

  return { container, dispose, onRespond, setIsResponding };
}

const decisions: ProviderApprovalDecision[] = ["cancel", "decline", "acceptForSession", "accept"];

describe("ComposerPendingApprovalActions", () => {
  it.each(decisions)("dispatches %s with the active requestId", (decision) => {
    const { container, dispose, onRespond } = mount({ requestId: "req-XYZ" });
    const btn = container.querySelector<HTMLButtonElement>(`button[data-decision='${decision}']`);
    expect(btn).toBeTruthy();
    btn!.click();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith("req-XYZ", decision);
    dispose();
  });

  it("disables every button while a response is in flight", () => {
    const { container, dispose, setIsResponding } = mount();
    setIsResponding(true);
    for (const decision of decisions) {
      const btn = container.querySelector<HTMLButtonElement>(`button[data-decision='${decision}']`);
      expect(btn?.disabled).toBe(true);
    }
    dispose();
  });
});
