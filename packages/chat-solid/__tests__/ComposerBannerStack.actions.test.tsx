/**
 * W5 — Composer banner stack aggregation + actions.
 *
 * The `ComposerBannerStack` rendering primitive is unit-tested in
 * `ComposerBannerStack.test.tsx` (first-card-vs-cap layout, dismiss,
 * variant tokens). These tests exercise the W5 wiring above it:
 *
 *   1. `buildPlanBannerItem` returns null when no plan is pending and
 *      a populated ComposerBannerItem otherwise; `isResponding` flips
 *      the disabled state on every action button.
 *   2. `planBannerTitle` pulls the first markdown heading and falls
 *      back to "Plan ready" when the markdown carries none.
 *   3. End-to-end render: feeding a plan item through
 *      `ChatComposer.bannerItems` shows the stack with working
 *      Apply / Reject / Modify buttons.
 *   4. Multiple aggregated items: first renders full chrome, the
 *      rest collapse into a "+N more" cap.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ChatComposer } from "../src/components/ChatComposer";
import type { ComposerBannerItem } from "../src/components/ComposerBannerStack";
import {
  buildPlanBannerItem,
  planBannerTitle,
} from "../src/lib/composerBannerItems";
import type {
  AvailableCommand,
  ComposerAttachment,
  ComposerTerminalPane,
  ProposedPlanSummary,
} from "../src/types";

function plan(overrides: Partial<ProposedPlanSummary> = {}): ProposedPlanSummary {
  return {
    id: "plan-1",
    turnId: null,
    planMarkdown: "# Implement OAuth\n- step",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-05-13T08:00:00.000Z",
    updatedAt: "2026-05-13T08:00:00.000Z",
    ...overrides,
  };
}

interface MountComposerOpts {
  bannerItems: ReadonlyArray<ComposerBannerItem>;
}

function mountComposer(opts: MountComposerOpts) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [bannerItems] = createSignal<ReadonlyArray<ComposerBannerItem>>(opts.bannerItems);
  const dispose = render(
    () => (
      <ChatComposer
        disabled={() => false}
        availableCommands={() => [] as AvailableCommand[]}
        providerName={() => "Claude"}
        sessionName={() => "alpha"}
        projectDir={() => undefined}
        attachments={() => [] as ComposerAttachment[]}
        terminalPanes={() => [] as ComposerTerminalPane[]}
        bannerItems={bannerItems}
        onAddAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
        onSend={async () => undefined}
        onCancel={vi.fn()}
      />
    ),
    container,
  );
  return { container, dispose };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("planBannerTitle", () => {
  it("returns the first markdown heading stripped of #s", () => {
    expect(
      planBannerTitle(plan({ planMarkdown: "## Implement OAuth\n- step" })),
    ).toBe("Implement OAuth");
  });

  it("falls back to 'Plan ready' when the markdown has no headings", () => {
    expect(planBannerTitle(plan({ planMarkdown: "just paragraph text\n- step" }))).toBe(
      "Plan ready",
    );
  });

  it("falls back when the heading is empty after stripping", () => {
    expect(planBannerTitle(plan({ planMarkdown: "#\n- step" }))).toBe("Plan ready");
  });
});

describe("buildPlanBannerItem", () => {
  const handlers = {
    onApply: vi.fn(),
    onReject: vi.fn(),
    onModify: vi.fn(),
    isResponding: false,
  };

  it("returns null when there is no pending plan", () => {
    expect(buildPlanBannerItem(null, handlers)).toBeNull();
    expect(buildPlanBannerItem(undefined, handlers)).toBeNull();
  });

  it("returns a ComposerBannerItem keyed on the plan id", () => {
    const item = buildPlanBannerItem(plan({ id: "plan-99" }), handlers);
    expect(item).not.toBeNull();
    expect(item?.id).toBe("plan:plan-99");
    expect(item?.variant).toBe("info");
  });
});

describe("ChatComposer + plan banner item (W5)", () => {
  it("renders the banner stack with Apply / Reject / Modify when a plan item is present", () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const onModify = vi.fn();
    const item = buildPlanBannerItem(plan({ id: "plan-A" }), {
      onApply,
      onReject,
      onModify,
      isResponding: false,
    });
    expect(item).not.toBeNull();

    const { container, dispose } = mountComposer({ bannerItems: [item!] });

    const stack = container.querySelector("[data-testid='composer-banner-stack']");
    expect(stack).toBeTruthy();

    const apply = container.querySelector(
      "[data-testid='plan-banner-apply']",
    ) as HTMLButtonElement | null;
    const reject = container.querySelector(
      "[data-testid='plan-banner-reject']",
    ) as HTMLButtonElement | null;
    const modify = container.querySelector(
      "[data-testid='plan-banner-modify']",
    ) as HTMLButtonElement | null;
    expect(apply).toBeTruthy();
    expect(reject).toBeTruthy();
    expect(modify).toBeTruthy();

    apply!.click();
    reject!.click();
    modify!.click();
    expect(onApply).toHaveBeenCalledExactlyOnceWith("plan-A");
    expect(onReject).toHaveBeenCalledExactlyOnceWith("plan-A");
    expect(onModify).toHaveBeenCalledExactlyOnceWith("plan-A");

    dispose();
  });

  it("disables every plan action while isResponding", () => {
    const item = buildPlanBannerItem(plan({ id: "plan-B" }), {
      onApply: vi.fn(),
      onReject: vi.fn(),
      onModify: vi.fn(),
      isResponding: true,
    });
    const { container, dispose } = mountComposer({ bannerItems: [item!] });
    for (const testId of [
      "plan-banner-apply",
      "plan-banner-reject",
      "plan-banner-modify",
    ]) {
      const btn = container.querySelector(`[data-testid='${testId}']`) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    }
    dispose();
  });

  it("collapses additional banners into the '+N more' cap", () => {
    const planItem = buildPlanBannerItem(plan({ id: "plan-C" }), {
      onApply: vi.fn(),
      onReject: vi.fn(),
      onModify: vi.fn(),
      isResponding: false,
    })!;
    const hostA: ComposerBannerItem = {
      id: "host-a",
      variant: "warning",
      title: <span>Merge freeze</span>,
    };
    const hostB: ComposerBannerItem = {
      id: "host-b",
      variant: "info",
      title: <span>Compliance review pending</span>,
    };

    const { container, dispose } = mountComposer({
      bannerItems: [planItem, hostA, hostB],
    });

    // First card visible with plan content + actions.
    expect(container.querySelector("[data-testid='composer-banner-plan:plan-C']")).toBeTruthy();
    expect(container.querySelector("[data-testid='plan-banner-apply']")).toBeTruthy();

    // Host items are NOT rendered as full cards (they're in the cap).
    expect(container.querySelector("[data-testid='composer-banner-host-a']")).toBeNull();
    expect(container.querySelector("[data-testid='composer-banner-host-b']")).toBeNull();

    // Cap shows "+2 more banners".
    const cap = container.querySelector("[data-testid='composer-banner-stack-cap']");
    expect(cap).toBeTruthy();
    expect(cap?.textContent).toContain("+2");

    dispose();
  });

  it("renders no banner stack when bannerItems is empty", () => {
    const { container, dispose } = mountComposer({ bannerItems: [] });
    expect(container.querySelector("[data-testid='composer-banner-stack']")).toBeNull();
    dispose();
  });
});
