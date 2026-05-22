import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import {
  ComposerPlanFollowUpBanner,
  type PlanFollowUpPayload,
} from "../src/components/ComposerPlanFollowUpBanner";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountBanner(opts: { plan: PlanFollowUpPayload | null; isResponding?: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onApply = vi.fn();
  const onModify = vi.fn();
  const onReject = vi.fn();
  render(
    () => (
      <ComposerPlanFollowUpBanner
        plan={() => opts.plan}
        isResponding={() => opts.isResponding ?? false}
        onApply={onApply}
        onModify={onModify}
        onReject={onReject}
      />
    ),
    container,
  );
  return { container, onApply, onModify, onReject };
}

describe("ComposerPlanFollowUpBanner", () => {
  it("renders nothing when no plan is pending", () => {
    const { container } = mountBanner({ plan: null });
    expect(container.querySelector("[data-testid='composer-plan-follow-up-banner']")).toBeNull();
  });

  it("shows the plan headline and source", () => {
    const { container } = mountBanner({
      plan: { planId: "plan-7", title: "Implement auth", source: "claude-code" },
    });
    const banner = container.querySelector(
      "[data-testid='composer-plan-follow-up-banner']",
    ) as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.getAttribute("data-plan-id")).toBe("plan-7");
    expect(banner.textContent).toContain("Plan ready");
    expect(banner.textContent).toContain("Implement auth");
    expect(banner.textContent).toContain("claude-code");
  });

  it("dispatches Apply / Modify / Reject with the plan id", () => {
    const { container, onApply, onModify, onReject } = mountBanner({
      plan: { planId: "plan-8", title: null },
    });
    (container.querySelector("[data-testid='plan-follow-up-apply']") as HTMLButtonElement).click();
    (container.querySelector("[data-testid='plan-follow-up-modify']") as HTMLButtonElement).click();
    (container.querySelector("[data-testid='plan-follow-up-reject']") as HTMLButtonElement).click();
    expect(onApply).toHaveBeenCalledExactlyOnceWith("plan-8");
    expect(onModify).toHaveBeenCalledExactlyOnceWith("plan-8");
    expect(onReject).toHaveBeenCalledExactlyOnceWith("plan-8");
  });

  it("disables every button while isResponding", () => {
    const { container } = mountBanner({
      plan: { planId: "plan-9", title: "X" },
      isResponding: true,
    });
    for (const id of ["plan-follow-up-apply", "plan-follow-up-modify", "plan-follow-up-reject"]) {
      const btn = container.querySelector(`[data-testid='${id}']`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
  });
});
