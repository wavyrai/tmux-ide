import { test } from "node:test";
import assert from "node:assert/strict";
import { TmuxServerClientError } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import {
  agentLaunchGuidance,
  AGENT_NOT_READY_ERROR,
  GENERIC_PANE_ACTION_ERROR,
} from "./agent-launch-guidance.ts";
test("only a typed agent readiness refusal gets actionable readiness guidance", () => {
  const error = new TmuxServerClientError("request-failed", 409, "harness_unavailable");
  assert.equal(agentLaunchGuidance(error, true), AGENT_NOT_READY_ERROR);
  assert.equal(agentLaunchGuidance(error, false), GENERIC_PANE_ACTION_ERROR);
});
test("unknown transport mutation and raw messages remain generic", () => {
  for (const error of [
    new Error("/private/secret"),
    { code: "harness_unavailable" },
    new TmuxServerClientError("request-failed", 503),
    new TmuxServerClientError("scope-mismatch", 409, "harness_unavailable"),
    new TmuxServerClientError("request-failed", 401, "harness_unavailable"),
  ]) {
    assert.equal(agentLaunchGuidance(error, true), GENERIC_PANE_ACTION_ERROR);
  }
});
