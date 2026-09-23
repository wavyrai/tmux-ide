import { describe, expect, it } from "vitest";
import {
  initialGuidedTourState,
  reduceGuidedTour,
  guidedTourCopy,
  type GuidedTourState,
  type GuidedTourPractice,
} from "./guided-tour.ts";

const practice: GuidedTourPractice = {
  machineId: "local",
  serverId: "server-a",
  generation: "generation-a",
  sessionId: "$17",
  sessionName: "tmux-ide-practice-unique",
};
function ready(): GuidedTourState {
  let state = reduceGuidedTour(initialGuidedTourState(), { type: "start" });
  state = reduceGuidedTour(state, { type: "welcome-read" });
  return reduceGuidedTour(state, { type: "practice-created", practice });
}
describe("guided tour confirmed actions", () => {
  it("requires the expected action and exact practice identity", () => {
    const state = ready();
    expect(reduceGuidedTour(state, { type: "resize-confirmed", practice })).toBe(state);
    for (const wrong of [
      { ...practice, machineId: "remote" },
      { ...practice, serverId: "server-b" },
      { ...practice, sessionId: "$18" },
    ]) {
      expect(reduceGuidedTour(state, { type: "split-confirmed", practice: wrong })).toBe(state);
    }
    expect(reduceGuidedTour(state, { type: "split-confirmed", practice }).step).toBe("focus");
  });
  it("pauses without forgetting progress and ignores actions while paused", () => {
    const paused = reduceGuidedTour(ready(), { type: "pause" });
    expect(reduceGuidedTour(paused, { type: "split-confirmed", practice })).toBe(paused);
    expect(reduceGuidedTour(paused, { type: "resume" })).toEqual({ ...paused, active: true });
  });
  it("walks through real actions and requires leaving before reopening", () => {
    let state = ready();
    for (const type of ["split-confirmed", "focus-confirmed", "resize-confirmed"] as const)
      state = reduceGuidedTour(state, { type, practice });
    expect(state.step).toBe("commands");
    state = reduceGuidedTour(state, { type: "commands-opened" });
    state = reduceGuidedTour(state, { type: "theme-changed" });
    expect(reduceGuidedTour(state, { type: "reopened", practice })).toBe(state);
    state = reduceGuidedTour(state, { type: "home-opened" });
    state = reduceGuidedTour(state, { type: "reopened", practice });
    expect(state.step).toBe("complete");
    expect(reduceGuidedTour(state, { type: "replay" })).toEqual({
      ...initialGuidedTourState(),
      active: true,
    });
  });
  it("recreates a missing practice session without adopting a same-named session", () => {
    const state = reduceGuidedTour(ready(), { type: "practice-missing" });
    expect(state.step).toBe("practice");
    expect(state.practice).toBeNull();
  });
  it("uses configured shortcut hints and avoids invented bindings", () => {
    expect(guidedTourCopy("commands", { commands: "ctrl+p" }).body).toContain("ctrl+p");
    expect(guidedTourCopy("commands").body).not.toContain("F5");
  });
});
