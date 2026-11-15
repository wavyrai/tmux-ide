import { DaemonBootstrapError } from "@tmux-ide/daemon-client/bootstrap-coordinator";
import { describe, expect, it } from "vitest";
import { ownServerProofRetry, OWN_SERVER_PROOF_RESTARTS } from "../headless-daemon.ts";

// Soak o3 and conn-daemon-o-scratch/killserver.ts, 14 Nov: a generation the daemon
// had just started (the first one of a restarted daemon, or one restarted in place
// after a tmux kill-server) could not prove its own server under a slow tmux, or
// proved it against a server being replaced, and the whole process exited. It
// should start that generation again, a bounded number of times.
describe("a generation that cannot prove its own tmux server", () => {
  const unproven = new DaemonBootstrapError("incompatible", "unproven", {
    reason: "tmux-server-unproven",
  });
  const mismatch = new DaemonBootstrapError("incompatible", "mismatch", {
    reason: "tmux-server-mismatch",
  });

  it("is started again, the first generation too, with a growing pause", () => {
    expect(ownServerProofRetry(unproven, { startReason: "initial", restarts: 0 })).toEqual({
      delayMs: 250,
    });
    expect(
      ownServerProofRetry(unproven, { startReason: "tmux-authority-replaced", restarts: 0 }),
    ).toEqual({
      delayMs: 250,
    });
    expect(
      ownServerProofRetry(unproven, { startReason: "tmux-server-unproven", restarts: 2 }),
    ).toEqual({
      delayMs: 750,
    });
  });

  it("is not started again past the bound, for a server mismatch, or for another error", () => {
    expect(ownServerProofRetry(mismatch, { startReason: "initial", restarts: 0 })).toBeNull();
    expect(
      ownServerProofRetry(unproven, {
        startReason: "tmux-authority-replaced",
        restarts: OWN_SERVER_PROOF_RESTARTS,
      }),
    ).toBeNull();
    expect(
      ownServerProofRetry(
        new DaemonBootstrapError("incompatible", "x", { reason: "identity-mismatch" }),
        {
          startReason: "tmux-authority-replaced",
          restarts: 0,
        },
      ),
    ).toBeNull();
    expect(
      ownServerProofRetry(new Error("tmux-server-unproven"), {
        startReason: "tmux-authority-replaced",
        restarts: 0,
      }),
    ).toBeNull();
  });
});
