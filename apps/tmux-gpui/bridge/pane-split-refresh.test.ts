import { test } from "node:test";
import assert from "node:assert/strict";
import {
  refreshSplitInventory,
  splitRefreshGuard,
  type SplitRefreshIdentity,
} from "./pane-split-refresh.ts";
import type { connectionSchema } from "./config.ts";
import type { z } from "zod";
const connection = (id: string) => ({ semanticPaneId: id }) as z.infer<typeof connectionSchema>;
for (const transition of ["background", "navigation", "session", "catalog", "stop"] as const)
  test(`split refresh cannot attach after ${transition} while fresh inventory is pending`, async () => {
    const state: SplitRefreshIdentity = {
      request: 2,
      session: "session",
      catalog: {},
      presenceRevision: 1,
      foreground: true,
      stopped: false,
    };
    let currentState = state;
    const current = splitRefreshGuard(() => currentState);
    let resolve!: (value: ReturnType<typeof connection>[]) => void;
    let readStarted!: () => void;
    const started = new Promise<void>((done) => {
      readStarted = done;
    });
    let attached = 0;
    const pending = refreshSplitInventory({
      current,
      originalPane: "source",
      createdPane: "created",
      retire: async () => {},
      read: () => {
        readStarted();
        return new Promise((done) => {
          resolve = done;
        });
      },
      attach: async () => {
        attached++;
      },
    });
    await started;
    if (transition === "background") {
      currentState = { ...state, foreground: false, presenceRevision: 2 };
      assert.equal(current(), false);
      currentState = { ...state, foreground: true, presenceRevision: 3 };
    } else if (transition === "navigation") currentState = { ...state, request: 3 };
    else if (transition === "session") currentState = { ...state, session: "other" };
    else if (transition === "catalog") currentState = { ...state, catalog: {} };
    else currentState = { ...state, stopped: true };
    resolve([connection("source"), connection("created")]);
    await pending;
    assert.equal(attached, 0);
  });
test("split refresh requires both exact receipt-created pane and retained source, without fallback", async () => {
  for (const ids of [
    ["other", "created"],
    ["source", "other"],
    ["source", "created"],
  ]) {
    let selected: string | null = null;
    const pending = refreshSplitInventory({
      current: () => true,
      originalPane: "source",
      createdPane: "created",
      retire: async () => {},
      read: async () => ids.map(connection),
      attach: async (original) => {
        selected = original.semanticPaneId;
      },
    });
    if (ids.includes("source") && ids.includes("created")) {
      await pending;
      assert.equal(selected, "source");
    } else {
      await assert.rejects(pending);
      assert.equal(selected, null);
    }
  }
});
