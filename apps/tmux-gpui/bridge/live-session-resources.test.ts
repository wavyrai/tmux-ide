import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseLiveSessionResources } from "./live-session-resources.ts";
test("retirement clears retained replica/image/history state even when one replica faults", () => {
  const released: string[] = [];
  const replicas = new Map([
    [
      "a",
      {
        retire() {
          released.push("a");
          throw Error("fault");
        },
      },
    ],
    [
      "b",
      {
        retire() {
          released.push("b");
        },
      },
    ],
  ]);
  const surfaces = new Map([["a", { canonical: "retained" }]]),
    lifetimes = new Map([["a", "lifetime"]]);
  const options = {
    replicas,
    surfaces,
    lifetimes,
    kitty: {
      retire() {
        released.push("kitty");
      },
    },
    viewport: {
      update(value: null) {
        assert.equal(value, null);
        released.push("history");
      },
    },
  };
  assert.throws(() => releaseLiveSessionResources(options), /release failed/);
  assert.deepEqual(released, ["a", "b", "kitty", "history"]);
  assert.equal(replicas.size, 0);
  assert.equal(surfaces.size, 0);
  assert.equal(lifetimes.size, 0);
});
