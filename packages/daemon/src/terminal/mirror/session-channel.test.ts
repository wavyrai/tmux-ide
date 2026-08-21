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
import type { MirrorOutputTiming } from "./control-channel.ts";

const dec = new TextDecoder();

interface Rig {
  channel: SessionChannel;
  sim: SimulatedChannel;
  state: FixtureState;
  pendingSyncs: Array<() => void>;
}

async function startedRig(
  options: {
    onNativeClientActivity?: () => void;
    onOutputObserved?: (
      semanticPaneId: string,
      ageMs: number | null,
      timing?: MirrorOutputTiming,
    ) => void;
  } = {},
): Promise<Rig> {
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
    onNativeClientActivity: options.onNativeClientActivity,
    onOutputObserved: options.onOutputObserved,
  });
  await channel.start();
  await vi.waitFor(() => {
    expect(channel.describe().panes).toHaveLength(3);
  });
  return { channel, sim: sim!, state, pendingSyncs };
}

describe("native client activity", () => {
  it("subscribes to attached-client changes and proves native presence from inventory", async () => {
    const onNativeClientActivity = vi.fn();
    const rig = await startedRig({ onNativeClientActivity });
    expect(rig.sim.written).toContain(
      "refresh-client -B 'tmux-ide-native-clients::#{session_attached}'",
    );
    rig.sim.feedLines(`%subscription-changed tmux-ide-native-clients $1 @1 0 %1 : 2`);
    await vi.waitFor(() => {
      expect(
        rig.sim.written.some((command) =>
          command.startsWith(`list-clients -t "${FIXTURE.session}"`),
        ),
      ).toBe(true);
    });
    rig.sim.reply(["0\t123"]);
    await vi.waitFor(() => expect(onNativeClientActivity).toHaveBeenCalledTimes(1));
    await rig.channel.dispose();
  });
});

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
  it("strictly recovers the retained control client's Unicode session identity", async () => {
    const session = "zz-café-😀";
    const state = fixtureState();
    state.descriptorRows = state.descriptorRows.map((row) =>
      Buffer.from(row.replace("\tzz-sim\t", `\t"${session}"\t`), "utf8").toString("latin1"),
    );
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session,
      createIo: (handlers) => {
        const baseReply = fixtureAutoReply(state);
        sim = new SimulatedChannel(handlers, (command) =>
          command.startsWith('display-message -p "#{qa:session_name}')
            ? [Buffer.from(`"${session}"\t$1`, "utf8").toString("latin1")]
            : baseReply(command),
        );
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    await channel.start();
    await expect(channel.attachedSessionIdentity()).resolves.toEqual({
      sessionName: session,
      runtimeSessionId: "$1",
    });
    await channel.dispose();
  });

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

  it("projects one coherent refreshed trusted inventory and keeps raw ids daemon-private", async () => {
    const { channel, sim, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const beforeQueries = sim.written.filter((command) =>
      command.includes("qa:@tmux_ide_pane_id"),
    ).length;

    const trusted = await channel.describeTrustedInventory("$1");

    expect(trusted).toMatchObject({ sessionName: FIXTURE.session, runtimeSessionId: "$1" });
    expect(trusted.panes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runtimePaneId: "%1",
          semanticPaneId: "pane.alpha",
          semanticWindowId: "window.test.one",
          windowPaneCount: 2,
          sessionWindowCount: 2,
          active: true,
          paneIndex: 0,
          missionStamp: "mission-a",
        }),
      ]),
    );
    expect(
      sim.written.filter((command) => command.includes("qa:@tmux_ide_pane_id")).length -
        beforeQueries,
    ).toBe(2);
    expect(JSON.stringify(channel.describe())).not.toMatch(/[%@$][0-9]/u);
    await channel.dispose();
  });

  it("fails trusted inventory closed when the coherent fence has no single active pane", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    state.descriptorRows[1] = state.descriptorRows[1]!.replace("\t0\t1\twindow", "\t1\t1\twindow");
    await expect(channel.describeTrustedInventory("$1")).rejects.toThrow("inconsistent");
    await channel.dispose();
  });

  it("rejects a same-name runtime-id mismatch before identity mutation", async () => {
    const { channel, sim, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const mutationsBefore = sim.written.filter((command) =>
      command.startsWith("set-option"),
    ).length;
    await expect(channel.describeTrustedInventory("$9")).rejects.toThrow("inconsistent");
    expect(sim.written.filter((command) => command.startsWith("set-option"))).toHaveLength(
      mutationsBefore,
    );
    await channel.dispose();
  });

  it("rejects a truncated descriptor reply whose self-reported counts do not close", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows.splice(1, 1);
    await expect(channel.describeTrustedInventory("$1")).rejects.toThrow("incomplete counts");
    await channel.dispose();
  });

  it("refreshes topology and global active truth on every trusted read", async () => {
    const { channel, state } = await startedRig();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.mirror.gen1\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    await channel.describeTrustedInventory("$1");

    state.descriptorRows.splice(2, 1);
    state.windowRows.splice(1, 1);
    state.descriptorRows = state.descriptorRows.map((row, index) => {
      const fields = row.split("\t");
      fields[14] = index === 1 ? "1" : "0";
      fields[15] = "1";
      fields[18] = "2";
      fields[19] = "1";
      return fields.join("\t");
    });

    const refreshed = await channel.describeTrustedInventory("$1");
    expect(refreshed.panes).toHaveLength(2);
    expect(refreshed.panes.find((pane) => pane.active)?.semanticPaneId).toBe("pane.beta");
    await channel.dispose();
  });

  it("requires a byte-stable post-repair reread before publishing inventory", async () => {
    const state = fixtureState();
    let sim: SimulatedChannel | null = null;
    const channel = new SessionChannel({
      session: FIXTURE.session,
      createIo: (handlers) => {
        const baseReply = fixtureAutoReply(state);
        sim = new SimulatedChannel(handlers, (command) => {
          if (command.startsWith("set-option -p -t %3")) {
            state.descriptorRows[2] = state.descriptorRows[2]!.replace(
              "%3\t\t",
              "%3\tpane.mirror.gen1\t",
            );
          }
          return baseReply(command);
        });
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });
    await channel.start();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\tpane.mirror.gen1\t",
      "%3\t\t",
    ).replace("\t\tzz-sim", "\twindow.test.two\tzz-sim");
    const before = sim!.written.filter((command) =>
      command.includes("qa:@tmux_ide_pane_id"),
    ).length;

    await expect(channel.describeTrustedInventory("$1")).resolves.toMatchObject({
      panes: expect.any(Array),
    });
    expect(
      sim!.written.filter((command) => command.includes("qa:@tmux_ide_pane_id")).length - before,
    ).toBe(4);
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
    const capture = sim.written.filter((cmd) => cmd.includes("capture-pane"));
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

  it("hands a new pane subscriber only its owning window geometry immediately", async () => {
    /*
     * Bug this catches — and it did, on the first live run of the layout-faithful
     * view: layout frames were emitted only when a layout CHANGED, so a view
     * built from them opened empty and stayed empty until the user moved
     * something. It read as the app failing to find the session's windows.
     */
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => layouts.push(event),
    );
    expect(layouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    // Every pane names an identity. A frame that arrives before the stamp-back
    // carries nulls, and a consumer that renders semantic ids draws nothing for
    // them — which is how a freshly split pane goes missing from the view.
    expect(layouts.every((event) => event.panes.every((pane) => pane.semanticPaneId))).toBe(true);
    await rig.channel.dispose();
  });

  it("never broadcasts one window layout to a subscriber owned by another window", async () => {
    const rig = await startedRig();
    const alphaLayouts: MirrorLayoutEvent[] = [];
    const gammaLayouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => alphaLayouts.push(event),
    );
    rig.sim.reply(["a"]);
    rig.sim.reply(["0 0 100 50"]);
    rig.channel.subscribePane(
      "pane.mirror.gen1",
      () => {},
      (event) => gammaLayouts.push(event),
    );
    rig.sim.reply(["g"]);
    rig.sim.reply(["0 0 200 50"]);
    expect(alphaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(gammaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.two"]);
    alphaLayouts.length = 0;
    gammaLayouts.length = 0;

    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    expect(alphaLayouts).toEqual([]);
    expect(gammaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.two"]);
    gammaLayouts.length = 0;
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    expect(alphaLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(gammaLayouts).toEqual([]);
    await rig.channel.dispose();
  });

  it("emits the exact new owning layout after a delayed truth-sync pane move", async () => {
    const rig = await startedRig();
    const layouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => layouts.push(event),
    );
    rig.sim.reply(["a"]);
    rig.sim.reply(["0 0 100 50"]);
    layouts.length = 0;

    const oldWithoutAlpha = "cccc,200x50,0,0,2";
    const newWithAlpha = "dddd,200x50,0,0{100x50,0,0,1,99x50,101,0,3}";
    // Tmux publishes the destination layout before list-panes truth has moved
    // the record, so the pane-scoped subscriber correctly does not see it yet.
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${newWithAlpha} 0`);
    expect(layouts).toEqual([]);
    // The old owning layout is relevant and invalidates the old lease.
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${oldWithoutAlpha} 0`);
    expect(layouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    expect(layouts[0]!.panes.some((pane) => pane.semanticPaneId === "pane.alpha")).toBe(false);

    rig.state.truthRows = ["%1\t1\t@2\t1", "%2\t1\t@1\t0", "%3\t0\t@2\t1"];
    rig.state.windowRows = FIXTURE.windowRows(oldWithoutAlpha, newWithAlpha);
    expect(rig.pendingSyncs).toHaveLength(1);
    rig.pendingSyncs.shift()!();

    await vi.waitFor(() => {
      expect(layouts.some((event) => event.semanticWindowId === "window.test.two")).toBe(true);
    });
    const movedIndex = layouts.findIndex((event) => event.semanticWindowId === "window.test.two");
    expect(movedIndex).toBeGreaterThan(0);
    expect(
      layouts.slice(movedIndex).every((event) => event.semanticWindowId === "window.test.two"),
    ).toBe(true);
    const moved = layouts[movedIndex]!;
    expect(moved.panes.find((pane) => pane.semanticPaneId === "pane.alpha")).toMatchObject({
      width: 100,
      height: 50,
      active: true,
    });
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

  it("keeps pane layout delivery scoped while global layout listeners receive both windows", async () => {
    /*
     * Bug this catches: `currentWindow` is carried on the layout frame and only
     * %session-window-changed moves it, so without a re-emit a view whose window
     * tabs come from these frames keeps marking the window the user just left as
     * the one they are in — until something unrelated happens to change a layout.
     */
    const rig = await startedRig();
    const paneLayouts: MirrorLayoutEvent[] = [];
    const globalLayouts: MirrorLayoutEvent[] = [];
    rig.channel.subscribePane(
      "pane.alpha",
      () => {},
      (event) => paneLayouts.push(event),
    );
    const global = rig.channel.subscribeLayout((event) => globalLayouts.push(event));
    rig.sim.reply(["s"]);
    rig.sim.reply(["0 0 100 50"]);
    // Seed a layout for both windows so each has geometry to re-emit.
    rig.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} ${FIXTURE.layoutW1} 0`);
    rig.sim.feedLines(`%layout-change @2 ${FIXTURE.layoutW2} ${FIXTURE.layoutW2} 0`);
    paneLayouts.length = 0;
    globalLayouts.length = 0;

    rig.sim.feedLines("%session-window-changed $0 @2");

    expect(paneLayouts.map((event) => event.semanticWindowId)).toEqual(["window.test.one"]);
    const byWindow = new Map(
      globalLayouts.map((event) => [event.semanticWindowId, event.currentWindow]),
    );
    expect(byWindow.get("window.test.two")).toBe(true);
    // The window that was left says so in the same burst, so no tab is left
    // claiming to be current alongside the new one.
    expect(byWindow.get("window.test.one")).toBe(false);
    global.close();
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
    rig.channel.fitViewport(120, 40);
    handle.sendKey("Enter");
    const sent = rig.sim.written.slice(before);
    expect(sent).toEqual([
      "send-keys -t %1 -H 68 69 21",
      "refresh-client -C 120x40",
      "send-keys -t %1 Enter",
    ]);
    await rig.channel.dispose();
  });

  it("changes geometry participation only on authority edges", async () => {
    const rig = await startedRig();
    const before = rig.sim.written.length;
    rig.channel.setGeometryParticipation(true);
    rig.channel.setGeometryParticipation(true);
    rig.channel.setGeometryParticipation(false);
    rig.channel.setGeometryParticipation(false);
    expect(rig.sim.written.slice(before)).toEqual([
      "refresh-client -f !ignore-size",
      "refresh-client -f ignore-size",
    ]);
    await rig.channel.dispose();
  });
});

describe("age telemetry", () => {
  it("retains %extended-output ages keyed by semantic pane id", async () => {
    const onOutputObserved = vi.fn();
    const rig = await startedRig({ onOutputObserved });
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
    expect(onOutputObserved).toHaveBeenCalledWith("pane.alpha", 750, undefined);
    await rig.channel.dispose();
  });
});
