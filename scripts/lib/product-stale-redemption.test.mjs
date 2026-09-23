import test from "node:test";
import assert from "node:assert/strict";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PaneStreamRedeemFrameSchemaZ,
} from "../../packages/contracts/src/pane-stream.ts";
import {
  issueCard5PredecessorDescriptor,
  rejectCard5PredecessorDescriptor,
} from "./product-card5-production-host-owner.mjs";

test("stale probe sends the predecessor identity in the authoritative strict redemption shape", async () => {
  const stale = {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    redemptionTicket: `ps2_${"a".repeat(43)}`,
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
        assert.equal(args.paneStreamProtocolVersion, PANE_STREAM_PROTOCOL_VERSION);
        assert.deepEqual(PaneStreamRedeemFrameSchemaZ.parse(args.redemptionFrame), {
          type: "redeem",
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
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

test("predecessor issuance passes active stream protocol into the browser callback", async () => {
  const expected = {
    workspaceName: "workspace.test",
    generation: "old-generation",
    semanticPaneId: "pane.test",
  };
  const previous = globalThis.tmuxIdeHost;
  let requested;
  globalThis.tmuxIdeHost = {
    daemon: {
      fetchApplicationShell: async () => ({
        status: "ok",
        envelope: {
          resource: {
            terminalInventory: {
              resources: [
                { attachability: { status: "available", semanticPaneId: expected.semanticPaneId } },
              ],
            },
          },
        },
      }),
      issuePaneStream: async (request) => {
        requested = request;
        return {
          status: "issued",
          descriptor: { daemonInstanceId: expected.generation, panes: [expected.semanticPaneId] },
        };
      },
    },
  };
  try {
    await issueCard5PredecessorDescriptor({ evaluate: async (fn, args) => fn(args) }, expected);
    assert.equal(requested.protocolVersion, PANE_STREAM_PROTOCOL_VERSION);
  } finally {
    if (previous === undefined) delete globalThis.tmuxIdeHost;
    else globalThis.tmuxIdeHost = previous;
  }
});
