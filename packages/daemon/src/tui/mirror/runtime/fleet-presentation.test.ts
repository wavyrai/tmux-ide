import { describe, expect, it } from "vitest";
import { fleetHostColor, summarizeFleetActivity } from "./fleet-presentation.ts";

describe("fleet presentation", () => {
  it("keeps environment identity colors across alternative routes and labels", () => {
    expect(fleetHostColor({ id: "mini-lan", environmentId: "env-mini" })).toBe(
      fleetHostColor({ id: "mini-vpn", environmentId: "env-mini" }),
    );
    expect(fleetHostColor({ id: "mini" })).toMatch(/^#[a-f0-9]{6}$/);
  });
  it("aggregates attention before running and does not claim stale activity", () => {
    const agents = [
      { activity: "running" as const, attention: false },
      { activity: "waiting" as const, attention: false },
    ];
    expect(summarizeFleetActivity(agents, true)).toEqual({
      kind: "attention",
      attention: 1,
      running: 1,
      label: "! 1",
    });
    expect(summarizeFleetActivity(agents, false).kind).toBe("unknown");
    expect(summarizeFleetActivity([{ ...agents[0]!, disabled: true }], true).kind).toBe("unknown");
    expect(summarizeFleetActivity([agents[0]!], true).kind).toBe("running");
    expect(summarizeFleetActivity([], true).kind).toBe("idle");
  });
});
