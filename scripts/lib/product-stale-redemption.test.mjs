import test from "node:test";
import assert from "node:assert/strict";
import { PaneStreamRedeemFrameSchemaZ } from "../../packages/contracts/src/pane-stream.ts";
import { rejectCard5PredecessorDescriptor } from "./product-card5-production-host-owner.mjs";

test("stale probe sends the predecessor identity in the authoritative strict redemption shape", async () => {
  const stale = {
    protocolVersion: 1,
    redemptionTicket: `ps1_${"a".repeat(43)}`,
    requestId: "11111111-1111-4111-8111-111111111111",
    daemonInstanceId: "old-generation",
    panes: ["pane-a"],
    effectiveViewerMode: "read-only",
  };
  let calls = 0;
  await rejectCard5PredecessorDescriptor(
    {
      evaluate: async (_fn, args) => {
        calls++;
        assert.equal(args.replacementGeneration, "new-generation");
        assert.deepEqual(PaneStreamRedeemFrameSchemaZ.parse(args.redemptionFrame), {
          type: "redeem",
          protocolVersion: 1,
          ticket: stale.redemptionTicket,
          requestId: stale.requestId,
          daemonInstanceId: stale.daemonInstanceId,
        });
      },
    },
    stale,
    "new-generation",
  );
  assert.equal(calls, 1);
});
