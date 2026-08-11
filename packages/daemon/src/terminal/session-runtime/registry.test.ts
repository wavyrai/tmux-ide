import { describe, expect, it, vi } from "vitest";
import type { MirrorServiceOptions } from "../mirror/mirror-service.ts";
import { ControlModeOwnershipRegistry } from "../mirror/control-mode-ownership.ts";
import {
  FIXTURE,
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
} from "../mirror/__tests__/simulated-channel.ts";
import { SessionRuntimeRegistry } from "./registry.ts";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";

function rig(generation = GENERATION_A): {
  registry: SessionRuntimeRegistry;
  sims: SimulatedChannel[];
  mirror: MirrorServiceOptions;
} {
  const sims: SimulatedChannel[] = [];
  const mirror: MirrorServiceOptions = {
    createIo: (_session, handlers) => {
      const sim = new SimulatedChannel(handlers, (command) => {
        const reply = fixtureAutoReply(fixtureState())(command);
        if (reply) return reply;
        if (command.includes("capture-pane")) return ["seed"];
        if (command.startsWith("display-message")) return ["0 0 100 50"];
        return [];
      });
      sims.push(sim);
      return sim;
    },
    generatePaneId: () => "pane.mirror.generated",
    controlModeOwnershipRegistry: new ControlModeOwnershipRegistry(),
  };
  return { registry: new SessionRuntimeRegistry({ generation, mirror }), sims, mirror };
}

function finishSeed(sim: SimulatedChannel): void {
  sim.reply(["seed"]);
  sim.reply(["0 0 100 50"]);
}

describe("SessionRuntimeRegistry", () => {
  it("shares one long-lived control authority across three independent consumer handles", async () => {
    const { registry, sims } = rig();
    const tui = registry.connect(FIXTURE.session, "opentui");
    const webOne = registry.connect(FIXTURE.session, "web:one");
    const webTwo = registry.connect(FIXTURE.session, "web:two");

    const subscriptions = await Promise.all([
      tui.subscribe("pane.alpha", () => {}),
      webOne.subscribe("pane.alpha", () => {}),
      webTwo.subscribe("pane.beta", () => {}),
    ]);

    expect(sims).toHaveLength(1);
    expect(registry.sessionCount()).toBe(1);
    expect(registry.activeControlChannelCount()).toBe(1);
    expect([tui.generation, webOne.generation, webTwo.generation]).toEqual([
      GENERATION_A,
      GENERATION_A,
      GENERATION_A,
    ]);

    await Promise.all(subscriptions.map((subscription) => subscription.close()));
    await Promise.all([tui.close(), webOne.close(), webTwo.close()]);

    // Consumer churn does not churn the session's daemon-owned control lane.
    expect(registry.activeControlChannelCount()).toBe(1);
    expect(sims[0]!.disposed).toBe(false);

    await registry.dispose();
    expect(registry.activeControlChannelCount()).toBe(0);
    expect(sims[0]!.disposed).toBe(true);
  });

  it("isolates a frozen or disconnected consumer from live ingestion", async () => {
    const { registry, sims } = rig();
    const slow = registry.connect(FIXTURE.session, "web:slow");
    const live = registry.connect(FIXTURE.session, "web:live");
    const slowEvents: string[] = [];
    const liveEvents: string[] = [];
    const slowSubscription = await slow.subscribe("pane.alpha", (event) => {
      slowEvents.push(event.type);
    });
    finishSeed(sims[0]!);
    await live.subscribe("pane.alpha", (event) => liveEvents.push(event.type));
    finishSeed(sims[0]!);

    slowEvents.length = 0;
    liveEvents.length = 0;
    slowSubscription.freeze();
    sims[0]!.output("%1", "first");
    expect(slowEvents).toEqual(["flow"]);
    expect(liveEvents).toEqual(["delta"]);

    await slow.close();
    sims[0]!.output("%1", "second");
    expect(liveEvents).toEqual(["delta", "delta"]);
    expect(registry.activeControlChannelCount()).toBe(1);

    await live.close();
    await registry.dispose();
  });

  it("rebuilds one channel on demand after exit under the same generation owner", async () => {
    const { registry, sims } = rig();
    const tui = registry.connect(FIXTURE.session, "opentui");
    const closed: string[] = [];
    await tui.subscribe("pane.alpha", (event) => {
      if (event.type === "closed") closed.push(event.type);
    });

    sims[0]!.feedLines("%exit detached");
    expect(closed).toEqual(["closed"]);
    expect(registry.activeControlChannelCount()).toBe(0);

    const webOne = registry.connect(FIXTURE.session, "web:replacement:one");
    const webTwo = registry.connect(FIXTURE.session, "web:replacement:two");
    await Promise.all([
      webOne.subscribe("pane.alpha", () => {}),
      webTwo.subscribe("pane.beta", () => {}),
    ]);
    expect(sims).toHaveLength(2);
    expect(registry.activeControlChannelCount()).toBe(1);
    expect(webOne.generation).toBe(GENERATION_A);
    expect(webTwo.generation).toBe(GENERATION_A);
    await vi.waitFor(() => expect(sims[0]!.disposed).toBe(true));

    await Promise.all([tui.close(), webOne.close(), webTwo.close()]);
    await registry.dispose();
  });

  it("rebuilds deterministically for a new daemon generation without tmux process ownership", async () => {
    const first = rig(GENERATION_A);
    const firstClient = first.registry.connect(FIXTURE.session, "web:first-generation");
    await firstClient.subscribe("pane.alpha", () => {});
    await first.registry.dispose();

    const second = new SessionRuntimeRegistry({ generation: GENERATION_B, mirror: first.mirror });
    const secondClient = second.connect(FIXTURE.session, "web:second-generation");
    await secondClient.subscribe("pane.alpha", () => {});

    expect(first.sims).toHaveLength(2);
    expect(first.sims[0]!.disposed).toBe(true);
    expect(secondClient.generation).toBe(GENERATION_B);
    expect(second.activeControlChannelCount()).toBe(1);

    await second.dispose();
    expect(first.sims[1]!.disposed).toBe(true);
  });
});
