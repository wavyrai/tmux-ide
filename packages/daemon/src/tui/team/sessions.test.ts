import { describe, expect, it } from "vitest";
import { isListableSession, rollupStatus } from "./sessions.ts";
import { HOST_SESSION } from "./host.ts";

describe("rollupStatus", () => {
  it("blocked wins over everything else", () => {
    expect(rollupStatus(["idle", "working", "done", "blocked", "unknown"])).toBe("blocked");
  });

  it("working wins over done, idle and unknown", () => {
    expect(rollupStatus(["idle", "done", "working", "unknown"])).toBe("working");
  });

  it("done wins over idle and unknown", () => {
    expect(rollupStatus(["idle", "unknown", "done"])).toBe("done");
  });

  it("empty array rolls up to idle", () => {
    expect(rollupStatus([])).toBe("idle");
  });

  it("all-unknown stays unknown", () => {
    expect(rollupStatus(["unknown", "unknown"])).toBe("unknown");
  });

  it("unknown only wins when nothing else is present — idle beats unknown", () => {
    expect(rollupStatus(["unknown", "idle"])).toBe("idle");
  });
});

describe("isListableSession", () => {
  it("hides the host session from the switcher", () => {
    expect(isListableSession(HOST_SESSION)).toBe(false);
  });

  it("keeps every other session", () => {
    expect(isListableSession("my-project")).toBe(true);
    expect(isListableSession("tmux-ide")).toBe(true);
  });
});
