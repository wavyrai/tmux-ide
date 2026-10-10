import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPresence } from "./presence.ts";

test("background releases owned input and geometry; foreground only requests input", async () => {
  const calls: string[] = [];
  const runtime = {
    setPresence: (state: string) => {
      calls.push(state);
    },
    ownsConnectionAuthority: () => true,
    releaseAuthority: async (kind: string) => {
      calls.push(`release:${kind}`);
      return {} as never;
    },
    requestAuthority: async (kind: string) => {
      calls.push(`request:${kind}`);
      return null;
    },
  };
  await applyPresence(runtime, false);
  await applyPresence(runtime, true);
  assert.deepEqual(calls, [
    "background",
    "release:input",
    "release:geometry",
    "foreground",
    "request:input",
  ]);
});
test("background releases connection claims even without current grants", async () => {
  const released: string[] = [];
  await applyPresence(
    {
      setPresence: () => {},
      releaseAuthority: async (kind) => {
        released.push(kind);
        return {} as never;
      },
      requestAuthority: async () => {
        throw new Error("Must not request while background");
      },
    },
    false,
  );
  assert.deepEqual(released, ["input", "geometry"]);
});
