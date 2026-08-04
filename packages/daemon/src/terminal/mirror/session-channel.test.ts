/**
 * SessionChannel unit tests over a simulated control channel (the real
 * ControlChannelCore fed raw protocol lines — see __tests__/simulated-channel).
 */
import { describe, expect, it, vi } from "vitest";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
  type FixtureState,
} from "./__tests__/simulated-channel.ts";
import type { MirrorLayoutEvent, MirrorPaneEvent } from "./events.ts";
import { SessionChannel } from "./session-channel.ts";

const dec = new TextDecoder();

interface Rig {
  channel: SessionChannel;
  sim: SimulatedChannel;
  state: FixtureState;
  pendingSyncs: Array<() => void>;
}

async function startedRig(): Promise<Rig> {
  const state = fixtureState();
  const pendingSyncs: Array<() => void> = [];
  let sim: SimulatedChannel | null = null;
  const channel = new SessionChannel({
    session: FIXTURE.session,
    createIo: (handlers) => {
      sim = new SimulatedChannel(handlers, fixtureAutoReply(state));
      return sim;
    },
    generatePaneId: () => "pane.mirror.gen1",
    generateWindowId: () => "window.mirror.gen1",
    scheduleSync: (callback) => {
      pendingSyncs.push(callback);
      return () => {};
    },
  });
  await channel.start();
  await vi.waitFor(() => {
    expect(channel.describe().panes).toHaveLength(3);
  });
  return { channel, sim: sim!, state, pendingSyncs };
}

function collect(): { events: MirrorPaneEvent[]; onEvent: (e: MirrorPaneEvent) => void } {
  const events: MirrorPaneEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

function bytesOf(events: readonly MirrorPaneEvent[]): string[] {
  return events
    .filter((event) => event.type === "seed" || event.type === "delta")
    .map((event) => dec.decode((event as { data: Uint8Array }).data));
}

describe("identity join", () => {
  it("verifies stamps, generates+stamps back the unstamped pane, and never leaks runtime ids", async () => {
    const { channel, sim } = await startedRig();
    const description = channel.describe();
    const ids = description.panes.map((pane) => pane.semanticPaneId).sort();
    expect(ids).toEqual(["pane.alpha", "pane.beta", "pane.mirror.gen1"]);
    expect(
      sim.written.some((cmd) =>
        cmd.startsWith('set-option -p -t %3 @tmux_ide_pane_id "pane.mirror.gen1"'),
      ),
    ).toBe(true);
    // Semantic window join rides the same description.
    const gamma = description.panes.find((pane) => pane.semanticPaneId === "pane.mirror.gen1")!;
    expect(gamma.semanticWindowId).toBe("window.test.two");
    // Runtime addresses stay inside the boundary.
    expect(JSON.stringify(description)).not.toMatch(/%[0-9]/);
    await channel.dispose();
  });

  it("keeps a generated identity unpublished when its stamp-back fails", async () => {
    const state = fixtureState();
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session: FIXTURE.session,
      createIo: (handlers) => {
        sim = new SimulatedChannel(handlers, (cmd) => {
          if (cmd.startsWith("set-option -p")) return null; // manual: fail it
          return fixtureAutoReply(state)(cmd);
        });
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    const started = channel.start();
    await vi.waitFor(() => {
      expect(sim!.written.some((cmd) => cmd.startsWith("set-option -p"))).toBe(true);
    });
    sim!.reply(["no such option"], false);
    await started;
    await vi.waitFor(() => {
      expect(channel.describe().panes).toHaveLength(2);
    });
    const description = channel.describe();
    expect(description.degraded).toBe(true);
    expect(description.diagnostics.some((diag) => diag.code === "SEMANTIC_STAMP_BACK_FAILED")).toBe(
      true,
    );
    await channel.dispose();
  });
});

describe("seed recipe (the FIFO seam)", () => {
  it("discards pre-reply output, holds the probe window, and emits one atomic batch", async () => {
    const { channel, sim } = await startedRig();
    const alpha = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    // The two probes left back-to-back.
    const capture = sim.written.filter((cmd) => cmd.startsWith("capture-pane"));
    expect(capture).toHaveLength(1);
    expect(capture[0]).toContain("-t %1");
    expect(sim.written.some((cmd) => cmd.startsWith("display-message -p -t %1"))).toBe(true);

    sim.output("%1", "PRE"); // produced before the capture instant → in the capture
    expect(alpha.events).toHaveLength(0);
    sim.reply(["CAPTURED:PRE"]); // the capture reply lands (FIFO seam)
    sim.output("%1", "MID"); // strictly-after-capture, probe window → held
    sim.reply(["4 9 100 50"]); // the cursor probe reply → atomic batch
    expect(alpha.events.map((event) => event.type)).toEqual(["reset", "seed", "delta", "cursor"]);
    expect(alpha.events[0]).toEqual({ type: "reset", cols: 100, rows: 50 });
    expect(bytesOf(alpha.events)).toEqual(["CAPTURED:PRE", "MID"]);
    expect(alpha.events[3]).toEqual({ type: "cursor", x: 4, y: 9 });

    sim.output("%1", "POST");
    expect(bytesOf(alpha.events).at(-1)).toBe("POST");
    await channel.dispose();
  });

  it("routes bytes only to the pane's own subscribers", async () => {
    const { channel, sim } = await startedRig();
    const alpha = collect();
    const beta = collect();
    channel.subscribePane("pane.alpha", alpha.onEvent);
    sim.reply(["seed-a"]);
    sim.reply(["0 0 100 50"]);
    channel.subscribePane("pane.beta", beta.onEvent);
    sim.reply(["seed-b"]);
    sim.reply(["0 0 99 50"]);

    sim.output("%1", "FOR-ALPHA");
    sim.output("%2", "FOR-BETA");
    expect(bytesOf(alpha.events)).toEqual(["seed-a", "FOR-ALPHA"]);
    expect(bytesOf(beta.events)).toEqual(["seed-b", "FOR-BETA"]);
    await channel.dispose();
  });
});

describe("flow control", () => {
  async function seededPair(rig: Rig): Promise<{
    alpha: ReturnType<typeof collect>;
    beta: ReturnType<typeof collect>;
  }> {
    const alpha = collect();
    const beta = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed-a"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["seed-b"]);
    rig.sim.reply(["0 0 99 50"]);
    alpha.events.length = 0;
    beta.events.length = 0;
    return { alpha, beta };
  }

  it("recovers EVERY backpressure-paused pane on any recovery (sticky %pause)", async () => {
    const rig = await startedRig();
    const { alpha, beta } = await seededPair(rig);

    // The stall paused the flooding pane AND the quiet sibling (measured
    // sticky behavior). Feed both pauses in one chunk, then answer the
    // recovery reseeds in FIFO order.
    rig.sim.feedLines("%pause %1");
    expect(rig.sim.written.filter((cmd) => cmd === "refresh-client -A '%1:continue'")).toHaveLength(
      1,
    );
    rig.sim.reply(["reseed-a"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.sim.feedLines("%pause %2");
    expect(rig.sim.written.filter((cmd) => cmd === "refresh-client -A '%2:continue'")).toHaveLength(
      1,
    );
    rig.sim.reply(["reseed-b"]);
    rig.sim.reply(["0 0 99 50"]);

    expect(alpha.events.map((event) => event.type)).toEqual([
      "flow",
      "flow",
      "reset",
      "seed",
      "cursor",
    ]);
    expect(alpha.events[0]).toEqual({ type: "flow", state: "paused", reason: "backpressure" });
    expect(alpha.events[1]).toEqual({ type: "flow", state: "resumed", reason: "backpressure" });
    expect(bytesOf(beta.events)).toEqual(["reseed-b"]);
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });

  it("leaves a pane paused when nobody unfrozen is watching, and recovers it on subscribe", async () => {
    const rig = await startedRig();
    rig.sim.feedLines("%pause %1"); // no subscribers at all
    expect(rig.sim.written.some((cmd) => cmd.includes("%1:continue"))).toBe(false);

    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:continue'")).toBe(true);
    rig.sim.reply(["late-seed"]);
    rig.sim.reply(["0 0 100 50"]);
    expect(bytesOf(alpha.events)).toEqual(["late-seed"]);
    await rig.channel.dispose();
  });

  it("freezes one pane without touching siblings, and thaws with continue+reseed", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const beta = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["seed-a"]);
    rig.sim.reply(["0 0 100 50"]);
    const betaHandle = rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["seed-b"]);
    rig.sim.reply(["0 0 99 50"]);
    alpha.events.length = 0;
    beta.events.length = 0;

    // beta briefly has TWO subscribers; freezing one must not park the pane.
    const betaHandle2 = rig.channel.subscribePane("pane.beta", () => {});
    rig.sim.reply(["z"]);
    rig.sim.reply(["0 0 99 50"]);
    betaHandle2.freeze();
    expect(rig.sim.written.some((cmd) => cmd.includes("%2:pause"))).toBe(false);
    betaHandle2.close();

    betaHandle.freeze();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%2:pause'")).toBe(true);
    expect(rig.channel.flowSnapshot().requested).toEqual(["pane.beta"]);
    rig.sim.output("%2", "WHILE-FROZEN");
    expect(bytesOf(beta.events)).toEqual([]); // frozen: nothing delivered

    // Sibling alpha keeps flowing the whole time.
    rig.sim.output("%1", "SIBLING");
    expect(bytesOf(alpha.events)).toEqual(["SIBLING"]);

    betaHandle.thaw();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%2:continue'")).toBe(true);
    rig.sim.reply(["thawed-seed"]);
    rig.sim.reply(["0 0 99 50"]);
    const flows = beta.events.filter((event) => event.type === "flow");
    expect(flows).toEqual([
      { type: "flow", state: "paused", reason: "requested" },
      { type: "flow", state: "resumed", reason: "requested" },
    ]);
    expect(bytesOf(beta.events)).toEqual(["thawed-seed"]);
    await rig.channel.dispose();
  });

  it("returns the pause ticket when a frozen pane's last subscriber departs", async () => {
    const rig = await startedRig();
    const alpha = collect();
    const handle = rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    handle.freeze();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:pause'")).toBe(true);
    handle.close();
    expect(rig.sim.written.some((cmd) => cmd === "refresh-client -A '%1:continue'")).toBe(true);
    expect(rig.channel.flowSnapshot()).toEqual({ backpressured: [], requested: [] });
    await rig.channel.dispose();
  });
});

describe("layout push", () => {
  it("emits joined layout events ahead of subsequent output, in channel order", async () => {
    const rig = await startedRig();
    const order: string[] = [];
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      (event) => order.push(event.type),
      (event) => {
        layouts.push(event);
        order.push("layout");
      },
    );
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    order.length = 0;

    // One chunk: the layout notification, then output at the new size — the
    // channel-order invariant says the layout event must be seen first.
    rig.sim.feedLines(
      `%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0{150x50,0,0,1,49x50,151,0,2} 0`,
      "%output %1 NEWSIZE",
    );
    expect(order).toEqual(["layout", "delta"]);
    const layout = layouts.at(-1)!;
    expect(layout.semanticWindowId).toBe("window.test.one");
    expect(layout.session).toBe(FIXTURE.session);
    expect(layout.cols).toBe(200);
    expect(layout.panes.map((pane) => pane.semanticPaneId)).toEqual(["pane.alpha", "pane.beta"]);
    expect(layout.panes[0]!.width).toBe(150);
    await rig.channel.dispose();
  });

  it("re-flags the active pane from %window-pane-changed", async () => {
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.beta",
      () => {},
      (event) => layouts.push(event),
    );
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 99 50"]);
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines("%window-pane-changed @1 %2");
    const layout = layouts.at(-1)!;
    expect(layout.panes.find((pane) => pane.semanticPaneId === "pane.beta")!.active).toBe(true);
    await rig.channel.dispose();
  });
});

describe("closure (truth-driven, never probe-failure)", () => {
  it("closes a subscribed pane only when a successful truth reply omits it", async () => {
    const rig = await startedRig();
    const gamma = collect();
    rig.channel.subscribePane("pane.mirror.gen1", gamma.onEvent);
    rig.sim.reply(["g"]);
    rig.sim.reply(["0 0 200 50"]);
    gamma.events.length = 0;

    rig.state.truthRows.splice(2, 1); // %3 is gone from tmux truth
    rig.state.descriptorRows.splice(2, 1);
    rig.sim.feedLines("%window-close @2");
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.pop()!();
    await vi.waitFor(() => {
      expect(gamma.events).toEqual([{ type: "closed" }]);
    });
    expect(
      rig.channel
        .describe()
        .panes.map((pane) => pane.semanticPaneId)
        .sort(),
    ).toEqual(["pane.alpha", "pane.beta"]);
    await rig.channel.dispose();
  });

  it("schedules a truth sync when a known pane vanishes from a surviving window's layout", async () => {
    const rig = await startedRig();
    const beta = collect();
    rig.channel.subscribePane("pane.beta", beta.onEvent);
    rig.sim.reply(["b"]);
    rig.sim.reply(["0 0 99 50"]);
    beta.events.length = 0;

    // kill-pane on %2: window @1 survives, so tmux emits ONLY %layout-change
    // whose leaves are all already known. The truth now omits %2; without a
    // sync its subscriber would never receive `closed`.
    rig.state.truthRows.splice(1, 1);
    rig.state.descriptorRows.splice(1, 1);
    rig.sim.feedLines("%layout-change @1 cccc,200x50,0,0,1 cccc,200x50,0,0,1 0");
    expect(rig.pendingSyncs.length).toBeGreaterThan(0);
    rig.pendingSyncs.pop()!();
    await vi.waitFor(() => {
      expect(beta.events).toEqual([{ type: "closed" }]);
    });
    expect(
      rig.channel
        .describe()
        .panes.map((pane) => pane.semanticPaneId)
        .sort(),
    ).toEqual(["pane.alpha", "pane.mirror.gen1"]);
    await rig.channel.dispose();
  });
});

describe("input path", () => {
  it("coalesces literals per pane and sends named keys after pending literals", async () => {
    const rig = await startedRig();
    const handle = rig.channel.subscribePane("pane.alpha", () => {});
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    const before = rig.sim.written.length;
    handle.sendText("hi");
    handle.sendText("!");
    handle.sendKey("Enter");
    const sent = rig.sim.written.slice(before);
    expect(sent).toEqual(["send-keys -t %1 -H 68 69 21", "send-keys -t %1 Enter"]);
    await rig.channel.dispose();
  });
});

describe("age telemetry", () => {
  it("retains %extended-output ages keyed by semantic pane id", async () => {
    const rig = await startedRig();
    const alpha = collect();
    rig.channel.subscribePane("pane.alpha", alpha.onEvent);
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.sim.feedLines("%extended-output %1 750 : flooded");
    expect(bytesOf(alpha.events)).toEqual(["s", "flooded"]);
    expect(rig.channel.ageTelemetry()).toEqual({
      maxAgeMs: 750,
      byPane: { "pane.alpha": 750 },
    });
    await rig.channel.dispose();
  });
});
