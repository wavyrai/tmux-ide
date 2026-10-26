import assert from "node:assert/strict";
import test from "node:test";
import { KernelWitnessReadError } from "../../../scripts/lib/owned-ssh-fixture.mjs";
import { waitForOwnedExit } from "./native-ssh-exit.mjs";
function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms) => {
      time += ms;
    },
  };
}
test("exit read refusals require a later positive death observation", async () => {
  const values = [new KernelWitnessReadError(65), "owned", null];
  await waitForOwnedExit(
    async () => {
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value;
    },
    42,
    "owned",
    clock(),
  );
  assert.equal(values.length, 0);
});
test("persistent refusal or live identity never confirms death", async () => {
  for (const value of [new KernelWitnessReadError(65), "owned"]) {
    await assert.rejects(
      waitForOwnedExit(
        async () => {
          if (value instanceof Error) throw value;
          return value;
        },
        42,
        "owned",
        clock(),
      ),
      /exit was not confirmed/,
    );
  }
});
test("unexpected witness failures propagate", async () => {
  const error = new KernelWitnessReadError(66);
  await assert.rejects(
    waitForOwnedExit(
      async () => {
        throw error;
      },
      42,
      "owned",
      clock(),
    ),
    (actual) => actual === error,
  );
});
