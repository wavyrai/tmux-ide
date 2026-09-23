import { describe, expect, it } from "vitest";
import {
  observedGuidedTourEvent,
  type GuidedTourObservation,
} from "./application-guided-tour-owner.ts";
import { reduceGuidedTour, type GuidedTourState, type GuidedTourPractice } from "./guided-tour.ts";
const practice: GuidedTourPractice = {
  machineId: "local",
  serverId: "server",
  generation: "generation",
  sessionId: "$1",
  sessionName: "practice",
};
const state: GuidedTourState = { version: 1, active: true, step: "reopen", practice };
const home: GuidedTourObservation = {
  practice: null,
  surface: "home",
  panes: [],
  focusedPane: null,
  paletteOpen: false,
  theme: "light",
};
describe("guided tour cold practice return", () => {
  it("waits through the terminal loading surface and completes when exact practice becomes live", () => {
    const loading = { ...home, surface: "terminals" as const };
    const live = { ...loading, practice };
    expect(observedGuidedTourEvent(state, home, loading)).toBeNull();
    const event = observedGuidedTourEvent(state, loading, live);
    expect(event?.type).toBe("reopened");
    expect(reduceGuidedTour(state, event!).step).toBe("complete");
    expect(observedGuidedTourEvent(state, live, live)).toBeNull();
  });
  it("rejects a replacement session or generation even after the loading surface", () => {
    const loading = { ...home, surface: "terminals" as const };
    for (const replacement of [
      { ...practice, generation: "new" },
      { ...practice, sessionId: "$2" },
      { ...practice, serverId: "other" },
    ]) {
      expect(
        observedGuidedTourEvent(state, loading, { ...loading, practice: replacement }),
      ).toBeNull();
    }
  });
});
