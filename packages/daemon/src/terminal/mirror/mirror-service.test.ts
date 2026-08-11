/**
 * MirrorService refcount/dispose tests over simulated channels.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
} from "./__tests__/simulated-channel.ts";
import { MirrorService, type MirrorServiceOptions } from "./mirror-service.ts";

function rig(options: MirrorServiceOptions = {}): {
  service: MirrorService;
  sims: Map<string, SimulatedChannel[]>;
} {
  const sims = new Map<string, SimulatedChannel[]>();
  const service = new MirrorService({
    createIo: (session, handlers) => {
      const sim = new SimulatedChannel(handlers, (cmd) => {
        const auto = fixtureAutoReply(fixtureState())(cmd);
        if (auto) return auto;
        // Service tests never interleave: answer probes inline too.
        if (cmd.startsWith("capture-pane")) return ["seed"];
        if (cmd.startsWith("display-message")) return ["0 0 100 50"];
        return [];
      });
      const list = sims.get(session) ?? [];
      list.push(sim);
      sims.set(session, list);
      return sim;
    },
    generatePaneId: () => "pane.mirror.gen1",
    ...options,
  });
  return { service, sims };
}

async function subscribed(service: MirrorService, session: string, pane: string) {
  return await service.subscribe({ session, semanticPaneId: pane, onEvent: () => {} });
}

describe("MirrorService refcounting", () => {
  it("rejects a second control-mode owner for the same server session", async () => {
    const first = rig();
    const second = rig();
    const subscription = await subscribed(first.service, FIXTURE.session, "pane.alpha");
    await expect(subscribed(second.service, FIXTURE.session, "pane.alpha")).rejects.toThrow(
      /control-mode authority already exists/,
    );
    await subscription.close();
    const successor = await subscribed(second.service, FIXTURE.session, "pane.alpha");
    await successor.close();
  });

  it("shares one channel per session across subscriptions and disposes with the last one", async () => {
    const { service, sims } = rig();
    const first = await subscribed(service, FIXTURE.session, "pane.alpha");
    const second = await subscribed(service, FIXTURE.session, "pane.beta");
    expect(sims.get(FIXTURE.session)).toHaveLength(1);
    expect(service.activeChannelCount()).toBe(1);

    await first.close();
    expect(sims.get(FIXTURE.session)![0]!.disposed).toBe(false);
    await second.close();
    expect(sims.get(FIXTURE.session)![0]!.disposed).toBe(true);
    expect(service.activeChannelCount()).toBe(0);
  });

  it("spins up a fresh channel after the last subscription released the old one", async () => {
    const { service, sims } = rig();
    const first = await subscribed(service, FIXTURE.session, "pane.alpha");
    await first.close();
    const second = await subscribed(service, FIXTURE.session, "pane.alpha");
    expect(sims.get(FIXTURE.session)).toHaveLength(2);
    await second.close();
    expect(sims.get(FIXTURE.session)![1]!.disposed).toBe(true);
  });

  it("keeps sessions isolated: one channel each", async () => {
    const { service, sims } = rig();
    const a = await subscribed(service, "zz-one", "pane.alpha");
    const b = await subscribed(service, "zz-two", "pane.alpha");
    expect(sims.get("zz-one")).toHaveLength(1);
    expect(sims.get("zz-two")).toHaveLength(1);
    expect(service.activeChannelCount()).toBe(2);
    await a.close();
    await b.close();
    expect(service.activeChannelCount()).toBe(0);
  });

  it("describeSession does not retain the channel", async () => {
    const { service, sims } = rig();
    const description = await service.describeSession(FIXTURE.session);
    expect(description.panes.length).toBeGreaterThan(0);
    expect(description.session).toBe(FIXTURE.session);
    await vi.waitFor(() => {
      expect(sims.get(FIXTURE.session)![0]!.disposed).toBe(true);
    });
    expect(service.activeChannelCount()).toBe(0);
  });

  it("releases the ref when subscribing to an unknown semantic pane", async () => {
    const { service, sims } = rig();
    await expect(
      service.subscribe({
        session: FIXTURE.session,
        semanticPaneId: "pane.nope",
        onEvent: () => {},
      }),
    ).rejects.toThrow(/unknown semantic pane/);
    await vi.waitFor(() => {
      expect(sims.get(FIXTURE.session)![0]!.disposed).toBe(true);
    });
  });

  it("dispose tears down every active channel", async () => {
    const { service, sims } = rig();
    await subscribed(service, "zz-one", "pane.alpha");
    await subscribed(service, "zz-two", "pane.beta");
    await service.dispose();
    expect(sims.get("zz-one")![0]!.disposed).toBe(true);
    expect(sims.get("zz-two")![0]!.disposed).toBe(true);
    await expect(subscribed(service, "zz-one", "pane.alpha")).rejects.toThrow(/disposed/);
  });
});
