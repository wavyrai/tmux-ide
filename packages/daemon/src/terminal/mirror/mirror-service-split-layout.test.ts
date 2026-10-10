import { expect, it, vi } from "vitest";
import type { WindowLinkTarget } from "@tmux-ide/contracts";
import { MirrorService } from "./mirror-service.ts";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
} from "./__tests__/simulated-channel.ts";
import type { MirrorLayoutAuthoritySnapshot } from "./events.ts";

function rig(epoch: string | null = "11111111-1111-4111-8111-111111111111", heldStart = false) {
  const sims: SimulatedChannel[] = [];
  const releases: (() => void)[] = [];
  const exits: (() => void)[] = [];
  const service = new MirrorService({
    splitLayoutEpoch: () => epoch,
    createIo: (_session, handlers) => {
      const state = fixtureState();
      state.descriptorRows[2] = state.descriptorRows[2]!.replace(
        "%3\t\t",
        "%3\tpane.gamma\t",
      ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
      state.descriptorRows = state.descriptorRows.map((row) => row + "11");
      const sim = new SimulatedChannel(handlers, fixtureAutoReply(state));
      sims.push(sim);
      exits.push(() => handlers.onExit("fixture exit"));
      if (heldStart) {
        const start = sim.start.bind(sim);
        const ready = Promise.withResolvers<void>();
        releases.push(ready.resolve);
        sim.start = async () => {
          await ready.promise;
          await start();
        };
      }
      return sim;
    },
  });
  return { service, sims, releases, exits };
}

async function retained(service: MirrorService) {
  const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
  const subscription = await service.subscribeLayout(FIXTURE.session, () => {}, {
    expectedRuntimeSessionId: "$1",
    expectedSemanticPaneIds: ["pane.alpha", "pane.beta", "pane.gamma"],
    onAuthority: (snapshot) => snapshots.push(snapshot),
  });
  const topology = snapshots.at(-1)!.windowLinks;
  const link = topology.links[0]!;
  const target: WindowLinkTarget = {
    liveSessionId: topology.liveSessionId,
    linkId: link.linkId,
    linkRevision: topology.linkRevision,
    expectedSemanticWindowId: link.semanticWindowId,
  };
  return { subscription, target, snapshots };
}

it("reads stable opaque handles from retained real control state without retaining another reference", async () => {
  const r = rig();
  try {
    const first = await retained(r.service);
    const resource = await r.service.readWindowSplitLayout(FIXTURE.session, first.target);
    expect(resource.splits).toHaveLength(1);
    expect(await r.service.readWindowSplitLayout(FIXTURE.session, first.target)).toEqual(resource);
    expect(JSON.stringify(first.snapshots)).not.toContain("layoutId");
    await first.subscription.close();
    expect(r.service.activeChannelCount()).toBe(0);
    await expect(r.service.readWindowSplitLayout(FIXTURE.session, first.target)).rejects.toThrow();
    expect(r.sims).toHaveLength(1);
    const next = await retained(r.service);
    await expect(r.service.readWindowSplitLayout(FIXTURE.session, first.target)).rejects.toThrow();
    const replacement = await r.service.readWindowSplitLayout(FIXTURE.session, next.target);
    expect(replacement.layoutId).not.toBe(resource.layoutId);
    await next.subscription.close();
  } finally {
    await r.service.dispose();
  }
});

it("refuses missing epoch and never attaches for a read", async () => {
  const r = rig(null);
  try {
    await expect(
      r.service.readWindowSplitLayout(FIXTURE.session, {} as WindowLinkTarget),
    ).rejects.toThrow();
    expect(r.sims).toHaveLength(0);
    const current = await retained(r.service);
    await expect(
      r.service.readWindowSplitLayout(FIXTURE.session, current.target),
    ).rejects.toThrow();
    await current.subscription.close();
  } finally {
    await r.service.dispose();
  }
});

it("refuses a read whose retained entry is disposed during startup", async () => {
  const r = rig(undefined, true);
  const retaining = r.service.retainSession(FIXTURE.session).then(
    () => true,
    () => false,
  );
  await vi.waitFor(() => expect(r.sims).toHaveLength(1));
  const reading = r.service.readWindowSplitLayout(FIXTURE.session, {} as WindowLinkTarget).then(
    () => true,
    () => false,
  );
  const disposed = r.service.dispose();
  r.releases[0]!();
  expect(await reading).toBe(false);
  expect(await retaining).toBe(false);
  await disposed;
  expect(r.sims).toHaveLength(1);
});

it("retires handles when the underlying control client exits", async () => {
  const r = rig();
  try {
    const current = await retained(r.service);
    await r.service.readWindowSplitLayout(FIXTURE.session, current.target);
    r.exits[0]!();
    await expect(
      r.service.readWindowSplitLayout(FIXTURE.session, current.target),
    ).rejects.toThrow();
    await current.subscription.close();
  } finally {
    await r.service.dispose();
  }
});
