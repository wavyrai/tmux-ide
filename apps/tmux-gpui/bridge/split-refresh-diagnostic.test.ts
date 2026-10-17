import { test } from "node:test";
import assert from "node:assert/strict";
import { CatalogStageError } from "./catalog-errors.ts";
import { TmuxServerClientError } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { refreshSplitInventory, SplitRefreshError } from "./pane-split-refresh.ts";
test("refresh preserves sanitized catalog failure without raw causes or follow-up reads", async () => {
  const events: string[] = [];
  await assert.rejects(
    refreshSplitInventory({
      current: () => true,
      originalPane: "original",
      createdPane: "created",
      selectedSession: "session",
      retire: async () => {
        events.push("retire");
      },
      read: async () => {
        events.push("read");
        throw new CatalogStageError("inventory", new TmuxServerClientError("request-failed", 503));
      },
      readSessions: async () => {
        assert.fail("must not continue");
      },
      attach: async () => {
        assert.fail("must not attach");
      },
    }),
    (error) => {
      assert.ok(error instanceof SplitRefreshError);
      assert.equal(error.stage, "inventory");
      assert.deepEqual(error.catalog, {
        stage: "inventory",
        reason: "request failed",
        status: 503,
      });
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(events, ["retire", "read"]);
  const unknown = new SplitRefreshError("inventory", new Error("PRIVATE"));
  assert.equal(unknown.catalog, undefined);
  assert.ok(!JSON.stringify(unknown).includes("PRIVATE"));
});
