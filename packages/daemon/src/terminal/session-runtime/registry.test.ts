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
const TOKEN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOKEN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OP_A = "00000000-0000-4000-8000-000000000001";
const OP_B = "00000000-0000-4000-8000-000000000002";

function resize(workspaceName = "alpha") {
  return {
    verb: "workspace.pane.resize" as const,
    workspaceName,
    semanticPaneId: "pane.alpha",
    axis: "cols" as const,
    cells: 80,
  };
}

function send(workspaceName = "alpha") {
  return {
    verb: "workspace.pane.send" as const,
    workspaceName,
    semanticPaneId: "pane.alpha",
    text: "hello",
    submit: true,
    origin: "gui" as const,
  };
}

function controllerRig(generation = GENERATION_A) {
  const base = rig(generation);
  const executed: string[] = [];
  const tokens = [TOKEN_A, TOKEN_B, TOKEN_C];
  let tokenIndex = 0;
  const registry = new SessionRuntimeRegistry({
    generation,
    mirror: base.mirror,
    createControllerToken: () => tokens[tokenIndex++]!,
    semanticMutations: {
      resolveSession: (workspaceName) => `${workspaceName}-session`,
      execute: async (_operationId, intent) => {
        executed.push(intent.verb);
      },
      publishReceipt: () => {
        throw new Error("receipt publication is not expected in controller authorization tests");
      },
    },
    executeAuthorized: async (_operationId, intent) => {
      executed.push(intent.verb);
    },
  });
  return { registry, executed, sims: base.sims };
}

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
    const tui = registry.connect(FIXTURE.session, "opentui", "client:tui");
    const webOne = registry.connect(FIXTURE.session, "web:one", "client:web:one");
    const webTwo = registry.connect(FIXTURE.session, "web:two", "client:web:two");

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
    const slow = registry.connect(FIXTURE.session, "web:slow", "client:web:slow");
    const live = registry.connect(FIXTURE.session, "web:live", "client:web:live");
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
    const tui = registry.connect(FIXTURE.session, "opentui", "client:tui");
    const closed: string[] = [];
    await tui.subscribe("pane.alpha", (event) => {
      if (event.type === "closed") closed.push(event.type);
    });

    sims[0]!.feedLines("%exit detached");
    expect(closed).toEqual(["closed"]);
    expect(registry.activeControlChannelCount()).toBe(0);

    const webOne = registry.connect(
      FIXTURE.session,
      "web:replacement:one",
      "client:web:replacement:one",
    );
    const webTwo = registry.connect(
      FIXTURE.session,
      "web:replacement:two",
      "client:web:replacement:two",
    );
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
    const firstClient = first.registry.connect(
      FIXTURE.session,
      "web:first-generation",
      "client:web:first-generation",
    );
    await firstClient.subscribe("pane.alpha", () => {});
    await first.registry.dispose();

    const second = new SessionRuntimeRegistry({ generation: GENERATION_B, mirror: first.mirror });
    const secondClient = second.connect(
      FIXTURE.session,
      "web:second-generation",
      "client:web:second-generation",
    );
    await secondClient.subscribe("pane.alpha", () => {});

    expect(first.sims).toHaveLength(2);
    expect(first.sims[0]!.disposed).toBe(true);
    expect(secondClient.generation).toBe(GENERATION_B);
    expect(second.activeControlChannelCount()).toBe(1);

    await second.dispose();
    expect(first.sims[1]!.disposed).toBe(true);
  });

  it("grants exactly one controller while every other connected client is a viewer", async () => {
    const { registry } = controllerRig();
    const tui = registry.connect("alpha-session", "opentui", "client:tui");
    const webOne = registry.connect("alpha-session", "web", "client:web:one");
    const webTwo = registry.connect("alpha-session", "web", "client:web:two");

    const lease = tui.acquireController();
    expect(tui.acquireController()).toEqual(lease);
    expect([tui.controllerRole(), webOne.controllerRole(), webTwo.controllerRole()]).toEqual([
      "controller",
      "viewer",
      "viewer",
    ]);
    expect(registry.activeControllerLeaseCount()).toBe(1);
    expect(() => webOne.acquireController()).toThrowError(
      expect.objectContaining({ code: "controller-conflict" }),
    );
    await registry.dispose();
  });

  it("rejects viewer input and geometry before either tmux executor can run", async () => {
    const { registry, executed } = controllerRig();
    const controller = registry.connect("alpha-session", "web", "client:controller");
    const viewer = registry.connect("alpha-session", "web", "client:viewer");
    const lease = controller.acquireController();

    await expect(viewer.submitIntent(lease, OP_A, send())).rejects.toMatchObject({
      code: "stale-controller-lease",
    });
    await expect(viewer.submitIntent(lease, OP_B, resize())).rejects.toMatchObject({
      code: "stale-controller-lease",
    });
    expect(executed).toEqual([]);
    await registry.dispose();
  });

  it("hands controller authority over without creating another control connection", async () => {
    const { registry, sims } = controllerRig();
    const first = registry.connect("alpha-session", "opentui", "client:first");
    const second = registry.connect("alpha-session", "web", "client:second");
    await Promise.all([
      first.subscribe("pane.alpha", () => {}),
      second.subscribe("pane.beta", () => {}),
    ]);
    const firstLease = first.acquireController();
    const secondLease = first.handoffController(firstLease, second.clientId);
    expect(first.handoffController(firstLease, second.clientId)).toEqual(secondLease);

    expect(first.controllerRole()).toBe("viewer");
    expect(second.controllerRole()).toBe("controller");
    expect(secondLease.revision).toBeGreaterThan(firstLease.revision);
    expect(sims).toHaveLength(1);
    expect(registry.activeControlChannelCount()).toBe(1);
    await expect(first.submitIntent(firstLease, OP_A, resize())).rejects.toMatchObject({
      code: "stale-controller-lease",
    });
    await second.submitIntent(secondLease, OP_B, resize());
    second.releaseController(secondLease);
    expect(() => second.releaseController(secondLease)).not.toThrow();
    await registry.dispose();
  });

  it("refuses an old handoff replay after controller authority advances again", async () => {
    const { registry } = controllerRig();
    const first = registry.connect("alpha-session", "opentui", "client:first");
    const second = registry.connect("alpha-session", "web", "client:second");
    const firstLease = first.acquireController();
    const secondLease = first.handoffController(firstLease, second.clientId);
    const current = second.handoffController(secondLease, first.clientId);

    expect(first.controllerRole()).toBe("controller");
    expect(current.revision).toBeGreaterThan(secondLease.revision);
    expect(() => first.handoffController(firstLease, second.clientId)).toThrowError(
      expect.objectContaining({ code: "stale-controller-lease" }),
    );
    await registry.dispose();
  });

  it("refuses an old handoff replay after its target disconnects", async () => {
    const { registry } = controllerRig();
    const first = registry.connect("alpha-session", "opentui", "client:first");
    const second = registry.connect("alpha-session", "web", "client:second");
    const firstLease = first.acquireController();
    first.handoffController(firstLease, second.clientId);
    await second.close();

    expect(registry.activeControllerLeaseCount()).toBe(0);
    expect(() => first.handoffController(firstLease, second.clientId)).toThrowError(
      expect.objectContaining({ code: "stale-controller-lease" }),
    );
    await registry.dispose();
  });

  it("advances authority on disconnect and refuses stale tokens after reconnect", async () => {
    const { registry } = controllerRig();
    const first = registry.connect("alpha-session", "web", "client:stable");
    const stale = first.acquireController();
    await first.close();
    expect(registry.activeControllerLeaseCount()).toBe(0);

    const reconnected = registry.connect("alpha-session", "web", "client:stable");
    const current = reconnected.acquireController();
    expect(current.revision).toBeGreaterThan(stale.revision);
    expect(current.token).not.toBe(stale.token);
    await expect(reconnected.submitIntent(stale, OP_A, resize())).rejects.toMatchObject({
      code: "stale-controller-lease",
    });
    await registry.dispose();
  });

  it("keeps controller leases independent between sessions", async () => {
    const { registry } = controllerRig();
    const alpha = registry.connect("alpha-session", "web", "client:shared");
    const beta = registry.connect("beta-session", "web", "client:shared");
    const alphaLease = alpha.acquireController();
    const betaLease = beta.acquireController();

    expect(registry.activeControllerLeaseCount()).toBe(2);
    expect(alphaLease.session).toBe("alpha-session");
    expect(betaLease.session).toBe("beta-session");
    await expect(alpha.submitIntent(alphaLease, OP_A, resize("beta"))).rejects.toMatchObject({
      code: "intent-session-mismatch",
    });
    await registry.dispose();
  });

  it("decides controller authority synchronously while a viewer stream is frozen", async () => {
    const { registry, sims } = controllerRig();
    const slow = registry.connect("alpha-session", "web", "client:slow");
    const controller = registry.connect("alpha-session", "opentui", "client:controller");
    const subscription = await slow.subscribe("pane.alpha", () => {});
    finishSeed(sims[0]!);
    subscription.freeze();

    const lease = controller.acquireController();
    expect(lease.clientId).toBe("client:controller");
    expect(controller.controllerRole()).toBe("controller");
    await registry.dispose();
  });

  it("clears leases on registry disposal without acquiring tmux process ownership", async () => {
    const { registry, sims } = controllerRig();
    const controller = registry.connect("alpha-session", "web", "client:controller");
    controller.acquireController();
    expect(registry.activeControllerLeaseCount()).toBe(1);
    expect(sims).toHaveLength(0);

    await registry.dispose();
    expect(registry.activeControllerLeaseCount()).toBe(0);
    expect(sims).toHaveLength(0);
  });
});
