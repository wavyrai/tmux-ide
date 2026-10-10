import { SplitLayoutPublicationPending } from "./session-channel.ts";
import { expect, it } from "vitest";
import type { WindowLinkTarget } from "@tmux-ide/contracts";
import { SessionChannel } from "./session-channel.ts";
import {
  SimulatedChannel,
  fixtureAutoReply,
  fixtureState,
  FIXTURE,
} from "./__tests__/simulated-channel.ts";
import type { MirrorLayoutAuthoritySnapshot } from "./events.ts";

async function rig(birth = "11") {
  const state = fixtureState();
  state.descriptorRows[2] = state.descriptorRows[2]!.replace("%3\t\t", "%3\tpane.gamma\t").replace(
    "\t\tzz-sim",
    "\twindow.test.two\tzz-sim",
  );
  state.descriptorRows = state.descriptorRows.map((row) => row + birth);
  let sim!: SimulatedChannel;
  let holdWindows = false;
  const channel = new SessionChannel({
    session: FIXTURE.session,
    createIo: (handlers) => {
      const reply = fixtureAutoReply(state);
      sim = new SimulatedChannel(handlers, (cmd) => {
        if (holdWindows && cmd.startsWith("list-windows")) return null;
        if (holdWindows && cmd.endsWith('"#{pane-border-status}"')) return null;
        return reply(cmd);
      });
      return sim;
    },
    generatePaneId: () => "pane.mirror.gen1",
    generateWindowId: () => "window.mirror.gen1",
    scheduleSync: () => () => {},
  });
  await channel.start();
  const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
  await channel.subscribeAuthoritativeLayout(
    () => {},
    undefined,
    (snapshot) => snapshots.push(snapshot),
  );
  const topology = snapshots.at(-1)!.windowLinks;
  const link = topology.links.find((row) => row.semanticWindowId === "window.test.one")!;
  const target: WindowLinkTarget = {
    liveSessionId: topology.liveSessionId,
    linkRevision: topology.linkRevision,
    linkId: link.linkId,
    expectedSemanticWindowId: link.semanticWindowId,
  };
  return {
    snapshots,
    channel,
    sim,
    state,
    target,
    holdWindows: () => {
      holdWindows = true;
    },
  };
}

it("retains exact staged ancestry and immutable verified identities without changing public frames", async () => {
  const r = await rig();
  try {
    const value = r.channel.describeSplitLayout(r.target);
    expect(value).toEqual({
      sessionName: "zz-sim",
      sessionCreated: "1700000000",
      runtimeSessionId: "$1",
      runtimeWindowId: "@1",
      semanticWindowId: "window.test.one",
      rawLayout: FIXTURE.layoutW1,
      panes: [
        { runtimePaneId: "%1", semanticPaneId: "pane.alpha", nativePaneBirthId: "11" },
        { runtimePaneId: "%2", semanticPaneId: "pane.beta", nativePaneBirthId: "11" },
      ],
    });
    expect(Object.isFrozen(value.panes)).toBe(true);
    expect(JSON.stringify(r.snapshots)).not.toContain("rawLayout");
    expect(() =>
      r.channel.describeSplitLayout({ ...r.target, linkRevision: r.target.linkRevision + 1 }),
    ).toThrow();
  } finally {
    await r.channel.dispose();
  }
  expect(() => r.channel.describeSplitLayout(r.target)).toThrow();
});

it("refuses pending geometry then retains exact notification layout over an older inventory", async () => {
  const r = await rig();
  try {
    r.holdWindows();
    const sync = r.channel.syncNow();
    await Promise.resolve();
    await Promise.resolve();
    const changed = "cccc,200x50,0,0{120x50,0,0,1,79x50,121,0,2}";
    // The older list-windows command precedes the border reply in control FIFO.
    r.sim.feedLines(`%layout-change @1 ${changed} ${changed} 0`);
    expect(() => r.channel.describeSplitLayout(r.target)).toThrow(SplitLayoutPublicationPending);
    const rows = fixtureAutoReply(r.state)("list-windows")!;
    r.sim.reply(rows);
    r.sim.reply(["off"]);
    await sync;
    expect(r.channel.describeSplitLayout(r.target).rawLayout).toBe(changed);
  } finally {
    await r.channel.dispose();
  }
});

it("refuses missing native birth identity", async () => {
  const r = await rig("");
  try {
    expect(() => r.channel.describeSplitLayout(r.target)).toThrow("identity incomplete");
  } finally {
    await r.channel.dispose();
  }
});

it("refuses zoomed and malformed ancestry rather than reconstructing rectangles", async () => {
  const r = await rig();
  try {
    r.sim.feedLines(`%layout-change @1 ${FIXTURE.layoutW1} aaaa,200x50,0,0,1 Z`);
    expect(() => r.channel.describeSplitLayout(r.target)).toThrow();
    const malformed = "aaaa,200x50,0,0{120x50,0,0,1,99x50,101,0,2}";
    r.sim.feedLines(`%layout-change @1 ${malformed} ${malformed} 0`);
    expect(() => r.channel.describeSplitLayout(r.target)).toThrow();
  } finally {
    await r.channel.dispose();
  }
});

it("refuses fresh layout membership not yet joined to verified pane records", async () => {
  const r = await rig();
  try {
    const replaced = "aaaa,200x50,0,0{100x50,0,0,1,99x50,101,0,9}";
    r.sim.feedLines(`%layout-change @1 ${replaced} ${replaced} 0`);
    expect(() => r.channel.describeSplitLayout(r.target)).toThrow();
  } finally {
    await r.channel.dispose();
  }
});
