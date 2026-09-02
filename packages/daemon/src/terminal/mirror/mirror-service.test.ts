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

function stampDetachedFixture(state: ReturnType<typeof fixtureState>): void {
  state.descriptorRows[2] = state.descriptorRows[2]!.replace("%3\t\t", "%3\tpane.gamma\t").replace(
    "\t\tzz-sim\t1\t2",
    "\twindow.test.two\tzz-sim\t1\t2",
  );
}

describe("MirrorService refcounting", () => {
  it("rejects a descriptor pane-set splice before authoritative replay", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const layouts: unknown[] = [];
    let sim!: SimulatedChannel;
    const service = new MirrorService({
      createIo: (_session, handlers) => {
        sim = new SimulatedChannel(handlers, fixtureAutoReply(state));
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
    });

    await expect(
      service.subscribeLayout(FIXTURE.session, (layout) => layouts.push(layout), {
        expectedSemanticPaneIds: ["pane.alpha", "pane.beta"],
        expectedRuntimeSessionId: "$1",
      }),
    ).rejects.toMatchObject({ name: "MirrorTopologyChangedError" });
    expect(layouts).toHaveLength(0);
    await vi.waitFor(() => expect(sim.disposed).toBe(true));
  });

  it("refreshes and replays every detached window before activating a global layout subscriber", async () => {
    const state = fixtureState();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.gamma\t",
    ).replace("\t\tzz-sim\t1\t2", "\twindow.test.two\tzz-sim\t1\t2");
    let sim!: SimulatedChannel;
    const service = new MirrorService({
      createIo: (_session, handlers) => {
        sim = new SimulatedChannel(handlers, fixtureAutoReply(state));
        return sim;
      },
    });
    const layouts: Array<{ semanticWindowId: string | null; panes: readonly unknown[] }> = [];

    const subscription = await service.subscribeLayout(
      FIXTURE.session,
      (layout) => layouts.push({ semanticWindowId: layout.semanticWindowId, panes: layout.panes }),
      {
        expectedSemanticPaneIds: ["pane.alpha", "pane.beta", "pane.gamma"],
        expectedRuntimeSessionId: "$1",
      },
    );

    expect(layouts.map(({ semanticWindowId }) => semanticWindowId)).toEqual([
      "window.test.one",
      "window.test.two",
    ]);
    expect(layouts.map(({ panes }) => panes.length)).toEqual([2, 1]);
    expect(sim.written.filter((command) => command.startsWith("list-windows"))).toHaveLength(3);
    await subscription.close();
    expect(sim.disposed).toBe(true);
  });

  it("fails a global layout subscription when fresh truth omits a detached window", async () => {
    const state = fixtureState();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.gamma\t",
    ).replace("\t\tzz-sim\t1\t2", "\twindow.test.two\tzz-sim\t1\t2");
    state.windowRows = state.windowRows.slice(0, 1);
    let sim!: SimulatedChannel;
    const service = new MirrorService({
      createIo: (_session, handlers) => {
        sim = new SimulatedChannel(handlers, fixtureAutoReply(state));
        return sim;
      },
    });

    await expect(service.subscribeLayout(FIXTURE.session, () => undefined)).rejects.toThrow(
      /trusted inventory.*(?:degraded|verified identity)|incomplete windows/u,
    );
    await vi.waitFor(() => expect(sim.disposed).toBe(true));
  });

  it("prunes a stale detached window before authoritative layout replay", async () => {
    const state = fixtureState();
    state.descriptorRows[2] = state.descriptorRows[2]!.replace(
      "%3\t\t",
      "%3\tpane.gamma\t",
    ).replace("\t\tzz-sim\t1\t2", "\twindow.test.two\tzz-sim\t1\t2");
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const retention = await service.retainSession(FIXTURE.session);
    state.truthRows = state.truthRows.slice(0, 2);
    state.windowRows = state.windowRows.slice(0, 1);
    state.descriptorRows = state.descriptorRows
      .slice(0, 2)
      .map((row) => row.replace(/\t2\t2$/u, "\t2\t1"));
    const layouts: string[] = [];

    const subscription = await service.subscribeLayout(FIXTURE.session, (layout) => {
      if (layout.semanticWindowId) layouts.push(layout.semanticWindowId);
    });

    expect(layouts).toEqual(["window.test.one"]);
    await subscription.close();
    await retention.close();
  });

  it("rejects malformed fresh geometry atomically without replaying or partially swapping stale layout", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const incumbent: Array<{ window: string | null; cols: number }> = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      incumbent.push({ window: layout.semanticWindowId, cols: layout.cols });
    });
    incumbent.length = 0;
    state.windowRows = FIXTURE.windowRows("cccc,180x40,0,0{90x40,0,0,1,89x40,91,0,2}", "bad");

    await expect(service.subscribeLayout(FIXTURE.session, () => undefined)).rejects.toThrow(
      /window layout truth.*malformed/u,
    );
    expect(incumbent).toEqual([]);

    state.windowRows = FIXTURE.windowRows(FIXTURE.layoutW1, FIXTURE.layoutW2);
    const replay: Array<{ window: string | null; cols: number }> = [];
    const second = await service.subscribeLayout(FIXTURE.session, (layout) => {
      replay.push({ window: layout.semanticWindowId, cols: layout.cols });
    });
    expect(replay).toEqual([
      { window: "window.test.one", cols: 200 },
      { window: "window.test.two", cols: 200 },
    ]);
    await second.close();
    await first.close();
  });

  it.each([
    [
      "duplicate",
      (state: ReturnType<typeof fixtureState>) => [state.windowRows[0]!, state.windowRows[0]!],
    ],
    ["missing", (_state: ReturnType<typeof fixtureState>) => []],
  ])("rejects %s authoritative window layout truth", async (_name, mutate) => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const retention = await service.retainSession(FIXTURE.session);
    state.windowRows = mutate(state);
    await expect(service.subscribeLayout(FIXTURE.session, () => undefined)).rejects.toThrow(
      /window layout truth.*(?:malformed|missing)/u,
    );
    await retention.close();
  });

  it("publishes detached geometry-only refresh to an incumbent before replaying current truth to a new subscriber", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const incumbent: Array<{ window: string | null; cols: number; rows: number }> = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      incumbent.push({ window: layout.semanticWindowId, cols: layout.cols, rows: layout.rows });
    });
    incumbent.length = 0;
    state.windowRows = FIXTURE.windowRows(FIXTURE.layoutW1, "cccc,180x40,0,0,3");
    const newcomer: Array<{ window: string | null; cols: number; rows: number }> = [];

    const second = await service.subscribeLayout(FIXTURE.session, (layout) => {
      newcomer.push({ window: layout.semanticWindowId, cols: layout.cols, rows: layout.rows });
    });

    expect(incumbent).toEqual([{ window: "window.test.two", cols: 180, rows: 40 }]);
    expect(newcomer).toEqual([
      { window: "window.test.one", cols: 200, rows: 50 },
      { window: "window.test.two", cols: 180, rows: 40 },
    ]);
    await second.close();
    await first.close();
  });

  it.each([
    ["missing leaf", "aaaa,200x50,0,0,1", FIXTURE.layoutW2],
    ["duplicate leaf", "aaaa,200x50,0,0{100x50,0,0,1,99x50,101,0,1}", FIXTURE.layoutW2],
    ["extra leaf", "aaaa,200x50,0,0{100x50,0,0,1,99x50,101,0,9}", FIXTURE.layoutW2],
    ["cross-window leaf", "aaaa,200x50,0,0{100x50,0,0,1,99x50,101,0,3}", "bbbb,200x50,0,0,2"],
  ])("rejects stable %s geometry without mutating incumbent truth", async (_name, w1, w2) => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const incumbent: string[] = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      if (layout.semanticWindowId) incumbent.push(layout.semanticWindowId);
    });
    incumbent.length = 0;
    state.windowRows = FIXTURE.windowRows(w1, w2);
    const newcomer = vi.fn();

    await expect(service.subscribeLayout(FIXTURE.session, newcomer)).rejects.toThrow(
      /trusted inventory.*verified identity/u,
    );
    expect(incumbent).toEqual([]);
    expect(newcomer).not.toHaveBeenCalled();
    await first.close();
  });

  it("publishes both surviving windows when only current-window authority changes", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const incumbent: Array<{ window: string | null; current: boolean }> = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      incumbent.push({ window: layout.semanticWindowId, current: layout.currentWindow });
    });
    incumbent.length = 0;
    state.windowRows = state.windowRows.map((row, index) => {
      const fields = row.split("\t");
      fields[3] = index === 1 ? "1" : "0";
      return fields.join("\t");
    });
    state.descriptorRows = state.descriptorRows.map((row, index) => {
      const fields = row.split("\t");
      fields[14] = index === 2 ? "1" : index === 0 ? "1" : "0";
      fields[15] = index === 2 ? "1" : "0";
      return fields.join("\t");
    });
    const newcomer: Array<{ window: string | null; current: boolean }> = [];

    const second = await service.subscribeLayout(FIXTURE.session, (layout) => {
      newcomer.push({ window: layout.semanticWindowId, current: layout.currentWindow });
    });

    expect(incumbent).toEqual([
      { window: "window.test.one", current: false },
      { window: "window.test.two", current: true },
    ]);
    expect(newcomer).toEqual(incumbent);
    await second.close();
    await first.close();
  });

  it("publishes only the final stable transaction after pane truth churns between reads", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    let transactional = false;
    let descriptorReads = 0;
    let windowReads = 0;
    const changedDescriptors = state.descriptorRows.map((row, index) =>
      index === 0 ? row.replace("Alpha IDE", "Alpha stable") : row,
    );
    const intermediateWindows = FIXTURE.windowRows(FIXTURE.layoutW1, "cccc,180x40,0,0,3");
    const finalWindows = FIXTURE.windowRows(FIXTURE.layoutW1, "dddd,170x35,0,0,3");
    const service = new MirrorService({
      createIo: (_session, handlers) =>
        new SimulatedChannel(handlers, (command) => {
          if (transactional && command.includes("qa:@tmux_ide_pane_id")) {
            descriptorReads += 1;
            return descriptorReads === 1 ? state.descriptorRows : changedDescriptors;
          }
          if (transactional && command.startsWith("list-windows")) {
            windowReads += 1;
            return windowReads === 1 ? intermediateWindows : finalWindows;
          }
          return fixtureAutoReply(state)(command);
        }),
    });
    const incumbent: Array<{ window: string | null; cols: number }> = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      incumbent.push({ window: layout.semanticWindowId, cols: layout.cols });
    });
    incumbent.length = 0;
    transactional = true;
    const newcomer: Array<{ window: string | null; cols: number }> = [];

    const second = await service.subscribeLayout(FIXTURE.session, (layout) => {
      newcomer.push({ window: layout.semanticWindowId, cols: layout.cols });
    });

    expect(descriptorReads).toBe(4);
    expect(windowReads).toBe(4);
    expect(incumbent).toEqual([{ window: "window.test.two", cols: 170 }]);
    expect(newcomer).toEqual([
      { window: "window.test.one", cols: 200 },
      { window: "window.test.two", cols: 170 },
    ]);
    expect(incumbent).not.toContainEqual({ window: "window.test.two", cols: 180 });
    await second.close();
    await first.close();
  });

  it("exhausts a churning trusted transaction without mutating or publishing incumbent state", async () => {
    const state = fixtureState();
    stampDetachedFixture(state);
    let transactional = false;
    let windowReads = 0;
    const service = new MirrorService({
      createIo: (_session, handlers) =>
        new SimulatedChannel(handlers, (command) => {
          if (transactional && command.startsWith("list-windows")) {
            windowReads += 1;
            return FIXTURE.windowRows(
              FIXTURE.layoutW1,
              windowReads % 2 === 1 ? "cccc,180x40,0,0,3" : "dddd,170x35,0,0,3",
            );
          }
          return fixtureAutoReply(state)(command);
        }),
    });
    const incumbent: Array<{ window: string | null; cols: number }> = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      incumbent.push({ window: layout.semanticWindowId, cols: layout.cols });
    });
    incumbent.length = 0;
    transactional = true;

    await expect(service.subscribeLayout(FIXTURE.session, () => undefined)).rejects.toThrow(
      /trusted inventory.*did not settle/u,
    );
    expect(incumbent).toEqual([]);
    await first.close();
  });

  it.each([
    ["zero-active", ["0", "0"]],
    ["multiple-active", ["1", "1"]],
    ["descriptor-mismatch", ["0", "1"]],
  ])("rejects %s fresh window authority without publishing", async (_name, activeTokens) => {
    const state = fixtureState();
    stampDetachedFixture(state);
    const service = new MirrorService({
      createIo: (_session, handlers) => new SimulatedChannel(handlers, fixtureAutoReply(state)),
    });
    const incumbent: string[] = [];
    const first = await service.subscribeLayout(FIXTURE.session, (layout) => {
      if (layout.semanticWindowId) incumbent.push(layout.semanticWindowId);
    });
    incumbent.length = 0;
    state.windowRows = state.windowRows.map((row, index) => {
      const fields = row.split("\t");
      fields[3] = activeTokens[index]!;
      return fields.join("\t");
    });

    await expect(service.subscribeLayout(FIXTURE.session, () => undefined)).rejects.toThrow(
      /inconsistent active window|lacks verified identity/u,
    );
    expect(incumbent).toEqual([]);
    await first.close();
  });

  it("yields geometry only from event-driven proof of a non-control tmux client", async () => {
    const onNativeClientActivity = vi.fn();
    let sim!: SimulatedChannel;
    const service = new MirrorService({
      createIo: (_session, handlers) => {
        sim = new SimulatedChannel(handlers, (cmd) => {
          const auto = fixtureAutoReply(fixtureState())(cmd);
          if (auto) return auto;
          if (cmd.startsWith("list-clients")) return ["0\t123456", "1\t123455"];
          if (cmd.startsWith("capture-pane")) return ["seed"];
          if (cmd.startsWith("display-message")) return ["0 0 100 50"];
          return [];
        });
        return sim;
      },
      generatePaneId: () => "pane.mirror.gen1",
      onNativeClientActivity,
    });
    const retention = await service.retainSession(FIXTURE.session);

    sim.feedLines("%client-resized /dev/ttys001", "%client-resized /dev/ttys001");
    await vi.waitFor(() => expect(onNativeClientActivity).toHaveBeenCalledWith(FIXTURE.session));
    expect(sim.written.filter((command) => command.startsWith("list-clients"))).toHaveLength(1);
    await retention.close();
  });

  it("never returns a channel that exited between start settlement and acquire continuation", async () => {
    const sims: SimulatedChannel[] = [];
    let creation = 0;
    const service = new MirrorService({
      createIo: (_session, handlers) => {
        creation += 1;
        const sim = new SimulatedChannel(handlers, (cmd) => {
          const auto = fixtureAutoReply(fixtureState())(cmd);
          if (auto) return auto;
          if (cmd.startsWith("capture-pane")) return ["seed"];
          if (cmd.startsWith("display-message")) return ["0 0 100 50"];
          return [];
        });
        sims.push(sim);
        const exitDuringStart = creation === 1;
        return {
          start: async () => {
            await sim.start();
            if (exitDuringStart) handlers.onExit("exited during start handoff");
          },
          request: (command) => sim.request(command),
          commandInline: (command, onReply) => sim.commandInline(command, onReply),
          commandListInline: (command, replyCount, resultIndex, onReply) =>
            sim.commandListInline(command, replyCount, resultIndex, onReply),
          send: (command) => sim.send(command),
          dispose: () => sim.dispose(),
        };
      },
      generatePaneId: () => "pane.mirror.gen1",
    });

    const retention = await service.retainSession(FIXTURE.session);

    expect(sims).toHaveLength(2);
    expect(sims[0]!.disposed).toBe(true);
    expect(sims[1]!.disposed).toBe(false);
    expect(service.activeChannelCount()).toBe(1);
    await retention.close();
  });

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
