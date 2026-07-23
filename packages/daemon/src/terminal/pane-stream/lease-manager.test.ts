import { describe, expect, it } from "vitest";
import { PANE_STREAM_PROTOCOL_VERSION, type PaneStreamLeaseRequest } from "@tmux-ide/contracts";
import { PaneStreamLeaseError, PaneStreamLeaseManager } from "./lease-manager.ts";

const INSTANCE = "daemon-instance-1";
const REQUEST_A = "0b9f6a1e-2b3c-4d5e-8f90-1a2b3c4d5e6f";
const REQUEST_B = "1c8e5b2f-3c4d-4e6f-9a01-2b3c4d5e6f70";

function request(overrides: Partial<PaneStreamLeaseRequest> = {}): PaneStreamLeaseRequest {
  return {
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    workspaceName: "workspace.alpha",
    panes: ["pane.editor", "pane.shell"],
    viewerMode: "interactive",
    ...overrides,
  };
}

function manager(now: () => number, overrides: { ticketTtlMs?: number; redemptionProcessingTtlMs?: number } = {}) {
  return new PaneStreamLeaseManager({
    daemonInstanceId: INSTANCE,
    now,
    ticketTtlMs: overrides.ticketTtlMs ?? 15_000,
    redemptionProcessingTtlMs: overrides.redemptionProcessingTtlMs ?? 60_000,
  });
}

function binding(requestId = REQUEST_A) {
  return { daemonInstanceId: INSTANCE, requestId, projectIdentity: "workspace.alpha" };
}

function context(requestId = REQUEST_A) {
  return { requestId, projectIdentity: "workspace.alpha", sessionName: "alpha" };
}

describe("PaneStreamLeaseManager", () => {
  it("issues a ps1 ticket and redeems it once", async () => {
    let now = 1_000;
    const lease = manager(() => now);
    const issued = await lease.issue(request(), context());
    expect(issued.redemptionTicket).toMatch(/^ps1_[A-Za-z0-9_-]{43}$/u);
    expect(issued.descriptor.status).toBe("awaiting-redemption");
    expect(issued.descriptor.panes).toEqual(["pane.editor", "pane.shell"]);
    expect(issued.descriptor.sessionName).toBe("alpha");
    expect(JSON.stringify(issued.descriptor)).not.toContain("ps1_");

    now = 2_000;
    const redeemed = await lease.redeem(issued.redemptionTicket, binding());
    expect(redeemed.descriptor.status).toBe("active");
    await expect(lease.redeem(issued.redemptionTicket, binding())).rejects.toMatchObject({
      code: "invalid-ticket",
    });
  });

  it("rejects duplicate requests and mismatched bindings", async () => {
    const lease = manager(() => 1_000);
    const issued = await lease.issue(request(), context());
    await expect(lease.issue(request({ panes: ["pane.other"] }), context())).rejects.toMatchObject(
      { code: "duplicate-request" },
    );
    await expect(
      lease.redeem(issued.redemptionTicket, binding(REQUEST_B)),
    ).rejects.toMatchObject({ code: "binding-mismatch" });
    await expect(
      lease.redeem(issued.redemptionTicket, { ...binding(), projectIdentity: "workspace.other" }),
    ).rejects.toMatchObject({ code: "binding-mismatch" });
    // The failed attempts did not burn the ticket.
    await expect(lease.redeem(issued.redemptionTicket, binding())).resolves.toBeTruthy();
  });

  it("scopes the interactive grant per pane", async () => {
    const lease = manager(() => 1_000);
    await lease.issue(request({ panes: ["pane.editor", "pane.shell"] }), context());
    // Overlap on one pane conflicts.
    await expect(
      lease.issue(request({ panes: ["pane.shell", "pane.logs"] }), context(REQUEST_B)),
    ).rejects.toMatchObject({ code: "interactive-viewer-conflict" });
    // Disjoint interactive set and read-only overlap both coexist.
    await expect(
      lease.issue(request({ panes: ["pane.logs"] }), context(REQUEST_B)),
    ).resolves.toBeTruthy();
    const readOnly = await lease.issue(
      request({ panes: ["pane.editor"], viewerMode: "read-only" }),
      { ...context("2d7e4c3a-4d5e-4f70-8b12-3c4d5e6f7a81"), projectIdentity: "workspace.alpha" },
    );
    expect(readOnly.descriptor.viewerMode).toBe("read-only");
  });

  it("releases the grant with the lease", async () => {
    const lease = manager(() => 1_000);
    const issued = await lease.issue(request({ panes: ["pane.editor"] }), context());
    await lease.release(issued.descriptor.leaseId, binding());
    await expect(
      lease.issue(request({ panes: ["pane.editor"] }), context(REQUEST_B)),
    ).resolves.toBeTruthy();
    // The released ticket can no longer be redeemed.
    await expect(lease.redeem(issued.redemptionTicket, binding())).rejects.toMatchObject({
      code: "invalid-ticket",
    });
  });

  it("expires an unredeemed ticket and frees its grant after the processing grace", async () => {
    let now = 1_000;
    const lease = manager(() => now, { ticketTtlMs: 1_000, redemptionProcessingTtlMs: 2_000 });
    const issued = await lease.issue(request({ panes: ["pane.editor"] }), context());
    const reissue = () => lease.issue(request({ panes: ["pane.editor"] }), context(REQUEST_B));
    // Inside the grace window the grant is still held: a delivered-in-time
    // redemption could still be queued behind serialized work.
    now = 2_500;
    await expect(reissue()).rejects.toMatchObject({ code: "interactive-viewer-conflict" });
    // Late delivery is rejected at the TTL regardless of the grace...
    await expect(
      lease.redeem(issued.redemptionTicket, binding(), 2_400),
    ).rejects.toMatchObject({ code: "ticket-expired" });
    // ...and the failed redemption freed the grant immediately.
    await expect(reissue()).resolves.toBeTruthy();
  });

  it("treats the ticket TTL as a delivery bound, not a completion deadline", async () => {
    let now = 1_000;
    const lease = manager(() => now, { ticketTtlMs: 1_000, redemptionProcessingTtlMs: 60_000 });
    const issued = await lease.issue(request(), context());
    // The frame arrived in time; the redemption only EXECUTES after a queue
    // wait that outlives the ticket TTL. Delivery is judged at receivedAt.
    const receivedAt = 1_500;
    now = 5_000;
    const redeemed = await lease.redeem(issued.redemptionTicket, binding(), receivedAt);
    expect(redeemed.descriptor.status).toBe("active");
  });

  it("bounds execution with its own processing budget", async () => {
    let now = 1_000;
    const lease = manager(() => now, { ticketTtlMs: 1_000, redemptionProcessingTtlMs: 2_000 });
    const issued = await lease.issue(request(), context());
    const receivedAt = 1_500;
    now = 4_000; // deliveredAt + processing budget = 3_500 < now
    await expect(lease.redeem(issued.redemptionTicket, binding(), receivedAt)).rejects.toMatchObject(
      { code: "ticket-expired" },
    );
  });

  it("rejects late delivery even when claimed early", async () => {
    let now = 1_000;
    const lease = manager(() => now, { ticketTtlMs: 1_000 });
    const issued = await lease.issue(request(), context());
    now = 2_500;
    // A claimed FUTURE arrival never precedes now.
    await expect(
      lease.redeem(issued.redemptionTicket, binding(), 10_000),
    ).rejects.toMatchObject({ code: "ticket-expired" });
  });

  it("is a PaneStreamLeaseError for every failure", async () => {
    const lease = manager(() => 1_000);
    await expect(lease.redeem("ps1_not-a-ticket", binding())).rejects.toBeInstanceOf(
      PaneStreamLeaseError,
    );
    await expect(lease.release("not-a-lease", binding())).resolves.toEqual({ released: false });
  });
});
