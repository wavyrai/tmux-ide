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

function rig(
  epoch: string | null = "11111111-1111-4111-8111-111111111111",
  heldStart = false,
  capability = async () => true,
  prepare?: () => Promise<boolean>,
) {
  const sims: SimulatedChannel[] = [];
  const releases: (() => void)[] = [];
  const exits: (() => void)[] = [];
  const service = new MirrorService({
    splitLayoutEpoch: () => epoch,
    splitLayoutCapability: capability,
    splitLayoutPrepare: prepare,
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
  return {
    service,
    sims,
    releases,
    exits,
    setEpoch: (value: string | null) => {
      epoch = value;
    },
  };
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

it("withholds split resources for an observation-capable server without split mutation support", async () => {
  let supported = false;
  const r = rig(undefined, false, async () => supported);
  try {
    const current = await retained(r.service);
    await expect(
      r.service.readWindowSplitLayout(FIXTURE.session, current.target),
    ).rejects.toThrow();
    supported = true;
    const resource = await r.service.readWindowSplitLayout(FIXTURE.session, current.target);
    expect(resource.splits).toHaveLength(1);
    supported = false;
    await expect(
      r.service.readWindowSplitLayout(FIXTURE.session, current.target),
    ).rejects.toThrow();
    await current.subscription.close();
  } finally {
    await r.service.dispose();
  }
});

it.each(["epoch", "retire"])("rejects capability completion after %s changes", async (change) => {
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<boolean>();
  const r = rig(undefined, false, () => {
    entered.resolve();
    return ready.promise;
  });
  try {
    const current = await retained(r.service);
    const reading = r.service.readWindowSplitLayout(FIXTURE.session, current.target);
    const rejected = expect(reading).rejects.toThrow();
    await entered.promise;
    if (change === "epoch") r.setEpoch("22222222-2222-4222-8222-222222222222");
    else await current.subscription.close();
    ready.resolve(true);
    await rejected;
    await current.subscription.close();
  } finally {
    ready.resolve(false);
    await r.service.dispose();
  }
});

it("does not issue handles after retirement during lazy preparation", async () => {
  const entered = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<boolean>();
  const r = rig(
    undefined,
    false,
    async () => true,
    () => {
      entered.resolve();
      return prepared.promise;
    },
  );
  try {
    const current = await retained(r.service);
    const reading = r.service.readWindowSplitLayout(FIXTURE.session, current.target);
    const rejected = expect(reading).rejects.toThrow();
    await entered.promise;
    await current.subscription.close();
    const replacement = await retained(r.service);
    prepared.resolve(true);
    await rejected;
    const result = await r.service.readWindowSplitLayout(FIXTURE.session, replacement.target);
    expect(result.splits).toHaveLength(1);
    await replacement.subscription.close();
  } finally {
    prepared.resolve(false);
    await r.service.dispose();
  }
});
