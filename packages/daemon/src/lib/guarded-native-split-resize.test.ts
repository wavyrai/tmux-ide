import { expect, it, vi } from "vitest";
import { createGuardedNativeSplitResize } from "./guarded-native-split-resize.ts";
const epoch = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const before = "abcd,9x3,0,0{4x3,0,0,1,4x3,5,0,2}";
const after = "abcd,9x3,0,0{5x3,0,0,1,3x3,6,0,2}";
const capability = {
  schemaVersion: 1,
  capability: "split-resize-v1",
  sessionMembership: "exact-session-link-v1",
  maxDepth: 64,
  maxLeaves: 512,
  maxGrid: 4096,
};
function rig() {
  const observer = {
    nativeServerEpoch: epoch,
    ownedOperationTransport: true,
    ownedOperationEpochGuard: true,
    ownedOperationPaneGuard: true,
    ownedOperationSessionGuard: true,
  };
  let current = observer;
  const request = {
    sessionId: "$7",
    windowId: "@3",
    expectedLayout: before,
    path: [0],
    axis: "cols" as const,
    boundary: 5,
  };
  const authorize = vi.fn();
  const authority = {
    operationId,
    serverEpoch: epoch,
    session: { id: "$7", name: "proof", created: "42" },
    anchor: { paneId: "%1", paneBirthId: "8" },
    authorizeBeforeEffect: authorize,
  };
  const output = (args: readonly string[], body: unknown, connectionId = "7") =>
    [
      { schemaVersion: 2, type: "identity", serverEpoch: epoch, connectionId: "7" },
      {
        schemaVersion: 2,
        type: "operation-identity",
        serverEpoch: epoch,
        connectionId,
        wrapperCommandId: "8",
        operationId: args[args.indexOf("-O") + 1],
      },
      body,
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  const run = vi.fn((args: readonly string[]) =>
    output(
      args,
      args.at(-1)!.includes("'-V'") ? capability : { schemaVersion: 1, boundary: 5, layout: after },
    ),
  );
  const resize = createGuardedNativeSplitResize({ observation: () => current, runPinnedTmux: run });
  return {
    observer,
    request,
    authority,
    authorize,
    run,
    resize,
    output,
    replaceOwner: () => {
      current = { ...observer };
    },
  };
}
it("guards probe and effect on their own connections and validates readback", async () => {
  const r = rig();
  expect(await r.resize(r.request, r.authority)).toMatchObject({ status: "applied", boundary: 5 });
  expect(r.run).toHaveBeenCalledTimes(2);
  expect(r.authorize).toHaveBeenCalledTimes(2);
  const [probe, effect] = r.run.mock.calls.map(([args]) => args);
  expect(probe![probe!.indexOf("-O") + 1]).not.toBe(operationId);
  expect(effect).toEqual([
    "tmux-ide-events",
    "-i",
    ";",
    "tmux-ide-run",
    "-I",
    "-E",
    epoch,
    "-t",
    "%1",
    "-B",
    "8",
    "-s",
    "proof",
    "-S",
    "$7",
    "-C",
    "42",
    "-O",
    operationId,
    "'tmux-ide-resize-split' '-t' '@3' '-s' '$7' '-E' 'abcd,9x3,0,0{4x3,0,0,1,4x3,5,0,2}' '-p' '0' '-a' 'cols' '-c' '5'",
  ]);
});
it.each(["lease", "owner", "epoch", "capability"] as const)(
  "refuses %s retirement between capability and dispatch",
  async (kind) => {
    const r = rig();
    const pending = r.resize(r.request, r.authority);
    if (kind === "lease")
      r.authorize.mockImplementation(() => {
        throw Error("revoked");
      });
    if (kind === "owner") r.replaceOwner();
    if (kind === "epoch") r.observer.nativeServerEpoch = operationId;
    if (kind === "capability") r.observer.ownedOperationSessionGuard = false;
    expect(await pending).toEqual({ status: "refused", reason: "authority-retired" });
    expect(r.run).toHaveBeenCalledTimes(1);
  },
);
it("snapshots target identities and authorization callback before async work", async () => {
  const r = rig();
  const pending = r.resize(r.request, r.authority);
  r.request.sessionId = "$9";
  r.request.path[0] = 1;
  r.authority.session.id = "$9";
  r.authority.anchor.paneId = "%2";
  r.authority.authorizeBeforeEffect = () => {
    throw Error("replacement");
  };
  expect(await pending).toMatchObject({ status: "applied" });
  expect(r.authorize).toHaveBeenCalledTimes(2);
  expect(r.run.mock.calls[1]![0]).toContain("%1");
  expect(r.run.mock.calls[1]![0]).toContain("$7");
});
it.each(["mismatch", "unbound-pane", "zero-birth", "bad-operation"] as const)(
  "refuses invalid authority %s before probing",
  async (kind) => {
    const r = rig();
    if (kind === "mismatch") r.authority.session.id = "$9";
    if (kind === "unbound-pane") r.authority.anchor.paneId = "%99";
    if (kind === "zero-birth") r.authority.anchor.paneBirthId = "0";
    if (kind === "bad-operation") r.authority.operationId = "bad";
    expect(await r.resize(r.request, r.authority)).toEqual({
      status: "refused",
      reason: "invalid-authority",
    });
    expect(r.run).not.toHaveBeenCalled();
  },
);
it.each(["metadata", "receipt", "error", "oversized", "ack-only"] as const)(
  "keeps post-dispatch %s failure uncertain without retry",
  async (kind) => {
    const r = rig();
    const original = r.run.getMockImplementation()!;
    r.run.mockImplementationOnce(original).mockImplementationOnce((args) => {
      if (kind === "error") throw Error("SECRET native failure");
      if (kind === "oversized") return "x".repeat(20000);
      if (kind === "ack-only") return r.output(args, undefined).trimEnd() + "\n";
      return r.output(
        args,
        kind === "receipt"
          ? { schemaVersion: 1 }
          : { schemaVersion: 1, boundary: 5, layout: after },
        kind === "metadata" ? "99" : "7",
      );
    });
    const result = await r.resize(r.request, r.authority);
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(r.run).toHaveBeenCalledTimes(2);
  },
);
it("never dispatches on unsupported wrapper or invalid capability acknowledgement", async () => {
  const r = rig();
  r.observer.ownedOperationEpochGuard = false;
  expect(await r.resize(r.request, r.authority)).toEqual({
    status: "refused",
    reason: "unsupported",
  });
  expect(r.run).not.toHaveBeenCalled();
  r.observer.ownedOperationEpochGuard = true;
  r.run.mockReturnValue("invalid metadata\n");
  expect(await r.resize(r.request, r.authority)).toEqual({
    status: "refused",
    reason: "unsupported",
  });
  expect(r.run).toHaveBeenCalledTimes(1);
});
