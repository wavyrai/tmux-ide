import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialGuidedTourState } from "./guided-tour.ts";
import {
  parseGuidedTourState,
  readGuidedTourState,
  writeGuidedTourState,
} from "./guided-tour-storage.ts";

describe("guided tour persistence", () => {
  it("recovers malformed and future-version records safely", () => {
    expect(parseGuidedTourState(null)).toEqual(initialGuidedTourState());
    expect(parseGuidedTourState({ version: 2, step: "resize", active: true })).toEqual(
      initialGuidedTourState(),
    );
    expect(
      parseGuidedTourState({
        version: 1,
        step: "resize",
        active: true,
        practice: { sessionName: "same-name" },
      }).step,
    ).toBe("practice");
  });
  it("round trips progress and tolerates a damaged or unwritable store", () => {
    const dir = mkdtempSync(join(tmpdir(), "guided-tour-"));
    const path = join(dir, "state.json");
    try {
      const state = { ...initialGuidedTourState(), step: "practice" as const, active: true };
      expect(writeGuidedTourState(state, path)).toBe(true);
      expect(readGuidedTourState(path)).toEqual(state);
      writeFileSync(path, "{");
      expect(readGuidedTourState(path)).toEqual(initialGuidedTourState());
      expect(writeGuidedTourState(state, join(path, "invalid.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
