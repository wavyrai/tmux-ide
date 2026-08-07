import { describe, expect, it } from "vitest";

import {
  INITIAL_UPDATE_STATE,
  reduceUpdateState,
  type UpdateEvent,
  type UpdateState,
} from "./update-state-machine.ts";

function drive(events: readonly UpdateEvent[], start: UpdateState = INITIAL_UPDATE_STATE) {
  return events.reduce(reduceUpdateState, start);
}

describe("reduceUpdateState", () => {
  it("runs the full happy path idle → checking → downloading → ready → applying", () => {
    const checking = reduceUpdateState(INITIAL_UPDATE_STATE, { type: "check-requested" });
    expect(checking).toEqual({ phase: "checking", availableVersion: null });

    const downloading = reduceUpdateState(checking, { type: "update-found", version: "2.8.0" });
    expect(downloading).toEqual({ phase: "downloading", availableVersion: "2.8.0" });

    const ready = reduceUpdateState(downloading, {
      type: "download-succeeded",
      version: "2.8.0",
    });
    expect(ready).toEqual({ phase: "ready", availableVersion: "2.8.0" });

    const applying = reduceUpdateState(ready, { type: "apply-requested" });
    expect(applying).toEqual({ phase: "applying", availableVersion: "2.8.0" });
  });

  it("returns to idle when a check finds nothing", () => {
    const state = drive([{ type: "check-requested" }, { type: "no-update" }]);
    expect(state).toEqual(INITIAL_UPDATE_STATE);
  });

  it("fails a check closed to idle, clearing any pending version", () => {
    const state = drive([{ type: "check-requested" }, { type: "check-failed" }]);
    expect(state).toEqual({ phase: "idle", availableVersion: null });
  });

  it("fails a download closed to idle", () => {
    const state = drive([
      { type: "check-requested" },
      { type: "update-found", version: "2.8.0" },
      { type: "download-failed" },
    ]);
    expect(state).toEqual({ phase: "idle", availableVersion: null });
  });

  it("keeps ready sticky: a new check request is ignored once staged", () => {
    const ready = drive([
      { type: "check-requested" },
      { type: "update-found", version: "2.8.0" },
      { type: "download-succeeded", version: "2.8.0" },
    ]);
    const same = reduceUpdateState(ready, { type: "check-requested" });
    expect(same).toBe(ready);
  });

  it("falls back from applying to ready when the swap fails", () => {
    const applying: UpdateState = { phase: "applying", availableVersion: "2.8.0" };
    expect(reduceUpdateState(applying, { type: "apply-failed" })).toEqual({
      phase: "ready",
      availableVersion: "2.8.0",
    });
  });

  it("returns the same state object for illegal transitions (identity = no change)", () => {
    // update-found is illegal from idle.
    expect(reduceUpdateState(INITIAL_UPDATE_STATE, { type: "update-found", version: "9" })).toBe(
      INITIAL_UPDATE_STATE,
    );
    // download-succeeded is illegal from checking.
    const checking: UpdateState = { phase: "checking", availableVersion: null };
    expect(reduceUpdateState(checking, { type: "download-succeeded", version: "9" })).toBe(
      checking,
    );
    // apply-requested is illegal from downloading.
    const downloading: UpdateState = { phase: "downloading", availableVersion: "2.8.0" };
    expect(reduceUpdateState(downloading, { type: "apply-requested" })).toBe(downloading);
  });
});
