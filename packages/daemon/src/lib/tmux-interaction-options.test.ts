import { describe, expect, it } from "vitest";

import {
  AuthenticatedInternalReadVerifier,
  createAuthenticatedInternalReadOperation,
} from "./tmux-interaction-options.ts";

const DAEMON = "21f2625e-d1a5-4ad2-9068-b1426bcc6651";
const TOKEN = "owner-token-with-enough-entropy-for-the-test";
const NOW = Date.parse("2026-08-12T10:00:00.000Z");

function marker(pane = "%9", token = TOKEN, now = NOW): string {
  return createAuthenticatedInternalReadOperation(
    pane,
    { daemonInstanceId: DAEMON, ownerToken: token },
    now,
  );
}

describe("authenticated internal read operations", () => {
  it("consumes one fresh proof for its exact daemon, pane and operation", () => {
    const verifier = new AuthenticatedInternalReadVerifier({
      daemonInstanceId: DAEMON,
      ownerToken: TOKEN,
    });
    const proof = marker();

    expect(verifier.consume(proof, "%9", "workspace.pane.read", NOW)).toBe(true);
    expect(verifier.consume(proof, "%9", "workspace.pane.read", NOW)).toBe(false);
  });

  it("rejects a wrong pane, daemon, token, operation kind or expired proof", () => {
    const proof = marker();
    expect(
      new AuthenticatedInternalReadVerifier({
        daemonInstanceId: DAEMON,
        ownerToken: TOKEN,
      }).consume(proof, "%8", "workspace.pane.read", NOW),
    ).toBe(false);
    expect(
      new AuthenticatedInternalReadVerifier({
        daemonInstanceId: "11111111-1111-4111-8111-111111111111",
        ownerToken: TOKEN,
      }).consume(proof, "%9", "workspace.pane.read", NOW),
    ).toBe(false);
    expect(
      new AuthenticatedInternalReadVerifier({
        daemonInstanceId: DAEMON,
        ownerToken: "wrong-token",
      }).consume(proof, "%9", "workspace.pane.read", NOW),
    ).toBe(false);
    expect(
      new AuthenticatedInternalReadVerifier({
        daemonInstanceId: DAEMON,
        ownerToken: TOKEN,
      }).consume(proof, "%9", "workspace.pane.send", NOW),
    ).toBe(false);
    expect(
      new AuthenticatedInternalReadVerifier({
        daemonInstanceId: DAEMON,
        ownerToken: TOKEN,
      }).consume(proof, "%9", "workspace.pane.read", NOW + 10_001),
    ).toBe(false);
  });

  it("keeps the pane-bound proof compact enough for the observer record", () => {
    expect(marker().length).toBeLessThanOrEqual(160);
  });
});
