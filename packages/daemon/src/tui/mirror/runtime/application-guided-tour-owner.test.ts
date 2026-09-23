import { describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  createApplicationGuidedTourOwner,
  observedGuidedTourEvent,
  type GuidedTourObservation,
} from "./application-guided-tour-owner.ts";
import type { GuidedTourPractice, GuidedTourState } from "./guided-tour.ts";
const practice: GuidedTourPractice = {
  machineId: "local",
  serverId: "s",
  generation: "g",
  sessionId: "$1",
  sessionName: "practice",
};
const state: GuidedTourState = { version: 1, active: true, step: "resize", practice };
const before: GuidedTourObservation = {
  practice,
  surface: "terminals",
  panes: [
    { id: "%1", width: 40, height: 20 },
    { id: "%2", width: 40, height: 20 },
  ],
  focusedPane: "%1",
  paletteOpen: false,
  theme: "dark",
};
describe("tour observed evidence", () => {
  it("can finish leaving when a theme was selected from Home", () => {
    const home = { ...before, surface: "home" as const, theme: "light" };
    expect(
      observedGuidedTourEvent({ ...state, step: "theme" }, { ...home, theme: "dark" }, home)?.type,
    ).toBe("theme-changed");
    expect(observedGuidedTourEvent({ ...state, step: "leave" }, home, home)?.type).toBe(
      "home-opened",
    );
    expect(observedGuidedTourEvent({ ...state, step: "reopen" }, home, home)).toBeNull();
    expect(
      observedGuidedTourEvent({ ...state, step: "reopen" }, home, { ...home, surface: "terminals" })
        ?.type,
    ).toBe("reopened");
  });
  it("accepts divider reallocation but rejects whole-app resize and stale generation", () => {
    expect(
      observedGuidedTourEvent(state, before, {
        ...before,
        panes: [
          { id: "%1", width: 30, height: 20 },
          { id: "%2", width: 50, height: 20 },
        ],
      })?.type,
    ).toBe("resize-confirmed");
    expect(
      observedGuidedTourEvent(state, before, {
        ...before,
        panes: [
          { id: "%1", width: 30, height: 20 },
          { id: "%2", width: 30, height: 20 },
        ],
      }),
    ).toBeNull();
    expect(
      observedGuidedTourEvent(state, before, {
        ...before,
        practice: { ...practice, generation: "replacement" },
        panes: [
          { id: "%1", width: 30, height: 20 },
          { id: "%2", width: 50, height: 20 },
        ],
      }),
    ).toBeNull();
  });
  it("rejects small whole-app resizes and replacement panes with coincidental geometry", () => {
    for (const delta of [-1, 1]) {
      expect(
        observedGuidedTourEvent(state, before, {
          ...before,
          panes: before.panes.map((pane) => ({ ...pane, width: pane.width + delta })),
        }),
      ).toBeNull();
      expect(
        observedGuidedTourEvent(state, before, {
          ...before,
          panes: before.panes.map((pane) => ({ ...pane, height: pane.height + delta })),
        }),
      ).toBeNull();
    }
    expect(
      observedGuidedTourEvent(state, before, {
        ...before,
        panes: [
          { ...before.panes[0]!, width: 30 },
          { ...before.panes[1]!, id: "replacement", width: 50 },
        ],
      }),
    ).toBeNull();
  });
  it("does not interpret removal of the focused pane as focus practice", () => {
    expect(
      observedGuidedTourEvent({ ...state, step: "focus" }, before, {
        ...before,
        focusedPane: "%2",
        panes: [before.panes[1]!],
      }),
    ).toBeNull();
  });
  it("retains created practice identity after pausing, without opening it", async () => {
    let resolve!: (practice: GuidedTourPractice) => void;
    const pending = new Promise<GuidedTourPractice>((done) => {
      resolve = done;
    });
    const openPractice = vi.fn();
    const { owner, dispose } = createRoot((dispose) => ({
      dispose,
      owner: createApplicationGuidedTourOwner({
        read: () => ({ ...state, step: "practice", practice: null }),
        write: () => true,
        createPractice: () => pending,
        openPractice,
      }),
    }));
    try {
      const creating = owner.createPractice();
      owner.pause();
      resolve(practice);
      await creating;
      expect(openPractice).not.toHaveBeenCalled();
      expect(owner.state()).toEqual({ ...state, active: false, step: "split" });
    } finally {
      dispose();
    }
  });
});
