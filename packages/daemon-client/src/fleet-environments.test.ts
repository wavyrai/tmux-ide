import { expect, it } from "bun:test";
import { groupFleetEnvironments } from "./fleet-environments.ts";

const route = (id: string, ready = true) => ({
  id,
  ready,
  environmentId: "verified-env",
  generation: "generation-1",
});

it("joins only authenticated identities and prefers the current healthy route", () => {
  expect(groupFleetEnvironments([route("a"), route("b")], "b")).toEqual([
    { environmentId: "verified-env", routeIds: ["a", "b"], primaryRouteId: "b", conflict: false },
  ]);
  expect(
    groupFleetEnvironments([route("a"), { ...route("b"), environmentId: null }], "b"),
  ).toHaveLength(2);
  expect(
    groupFleetEnvironments([route("a"), { ...route("b"), generation: null }], "b"),
  ).toHaveLength(2);
});

it("keeps live or cached conflicting generations separate until reverified", () => {
  const groups = groupFleetEnvironments(
    [route("a"), { ...route("b", false), generation: "generation-2" }],
    "a",
  );
  expect(groups).toHaveLength(2);
  expect(groups.every((group) => group.conflict)).toBe(true);
});

it("offers a healthy display route without changing the selected authority", () => {
  const preferred = new Map([["verified-env", "a"]]);
  const groups = groupFleetEnvironments([route("a", false), route("b")], "a", preferred);
  expect(groups[0]!.primaryRouteId).toBe("b");
  expect(preferred.get("verified-env")).toBe("a");
  expect(
    groupFleetEnvironments([route("a"), route("b")], "local", preferred)[0]!.primaryRouteId,
  ).toBe("a");
});
