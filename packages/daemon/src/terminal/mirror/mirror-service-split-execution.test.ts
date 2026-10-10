import type { createGuardedNativeSplitResize } from "../../lib/guarded-native-split-resize.ts";
import { expect, it } from "vitest";
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

it.each(["valid", "retired", "replaced", "layout", "revoked"] as const)(
  "revalidates retained canonical authority after asynchronous native preparation: %s",
  async (scenario) => {
    const r = rig();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let effects = 0;
    let allowed = true;
    const run: ReturnType<typeof createGuardedNativeSplitResize> = async (request, authority) => {
      expect(request.sessionId).toBe("$1");
      expect(request.windowId).toBe("@1");
      expect(request.boundary).toBe(110);
      expect(authority.session).toEqual({ id: "$1", name: FIXTURE.session, created: "1700000000" });
      expect(authority.anchor).toEqual({ paneId: "%1", paneBirthId: "11" });
      entered.resolve();
      await resume.promise;
      authority.authorizeBeforeEffect();
      effects++;
      // Sentinel fake result: no native process is launched by this owner-boundary test.
      return { status: "refused", reason: "unsupported" };
    };
    try {
      const current = await retained(r.service);
      const layout = await r.service.readWindowSplitLayout(FIXTURE.session, current.target);
      const target = {
        window: current.target,
        layoutId: layout.layoutId,
        splitId: layout.splits[0]!.splitId,
        boundary: 110,
      };
      const pending = r.service
        .resizeWindowSplit(
          FIXTURE.session,
          target,
          "22222222-2222-4222-8222-222222222222",
          () => {
            if (!allowed) throw new Error("geometry revoked");
          },
          run,
        )
        .then(
          () => true,
          () => false,
        );
      // Caller mutation after submission cannot change the captured target.
      target.boundary = 999;
      await entered.promise;
      if (scenario === "retired" || scenario === "replaced") await current.subscription.close();
      if (scenario === "replaced") await retained(r.service);
      if (scenario === "layout") {
        const changed = "cccc,200x50,0,0{120x50,0,0,1,79x50,121,0,2}";
        r.sims[0]!.feedLines(`%layout-change @1 ${changed} ${changed} 0`);
      }
      if (scenario === "revoked") allowed = false;
      resume.resolve();
      expect(await pending).toBe(scenario === "valid");
      expect(effects).toBe(scenario === "valid" ? 1 : 0);
    } finally {
      resume.resolve();
      await r.service.dispose();
    }
  },
);

it("never creates split authority or calls native for missing/malformed handles", async () => {
  const r = rig();
  let calls = 0;
  const run: ReturnType<typeof createGuardedNativeSplitResize> = async () => {
    calls++;
    return { status: "refused", reason: "unsupported" };
  };
  try {
    const current = await retained(r.service);
    const target = {
      window: current.target,
      layoutId: "22222222-2222-4222-8222-222222222222",
      splitId: "33333333-3333-4333-8333-333333333333",
      boundary: 110,
    };
    await expect(
      r.service.resizeWindowSplit(
        FIXTURE.session,
        target,
        "44444444-4444-4444-8444-444444444444",
        () => {},
        run,
      ),
    ).rejects.toThrow();
    await r.service.readWindowSplitLayout(FIXTURE.session, current.target);
    await expect(
      r.service.resizeWindowSplit(
        FIXTURE.session,
        target,
        "44444444-4444-4444-8444-444444444444",
        () => {},
        run,
      ),
    ).rejects.toThrow();
    await expect(
      r.service.resizeWindowSplit(
        FIXTURE.session,
        { ...target, boundary: -1 },
        "44444444-4444-4444-8444-444444444444",
        () => {},
        run,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(r.sims).toHaveLength(1);
  } finally {
    await r.service.dispose();
  }
});

it.each(["unchanged", "publication-timeout", "retired"] as const)(
  "preserves applied native outcome without redispatch when successor is %s",
  async (scenario) => {
    const r = rig();
    const retainedState = await retained(r.service);
    let calls = 0;
    try {
      const resource = await r.service.readWindowSplitLayout(FIXTURE.session, retainedState.target);
      const split = resource.splits[0]!;
      const target = {
        window: retainedState.target,
        layoutId: resource.layoutId,
        splitId: split.splitId,
        boundary: split.boundary,
      };
      const run: ReturnType<typeof createGuardedNativeSplitResize> = async (request, authority) => {
        authority.authorizeBeforeEffect();
        calls++;
        if (scenario === "retired") await r.service.dispose();
        // The timeout case deliberately withholds matching canonical publication.
        const layout =
          scenario === "publication-timeout"
            ? request.expectedLayout.replace(/^[^,]+/, "ffff")
            : request.expectedLayout;
        const { parseLayoutTree } = await import("../protocol/layout-parse.ts");
        return {
          status: "applied",
          boundary: split.boundary,
          layout,
          tree: parseLayoutTree(layout)!,
          changed: false,
        };
      };
      const result = await r.service.resizeWindowSplit(
        FIXTURE.session,
        target,
        "22222222-2222-4222-8222-222222222222",
        () => {},
        run,
      );
      expect(result.status).toBe("applied");
      expect(calls).toBe(1);
      if (scenario === "unchanged") expect(result.successor?.resource).toEqual(resource);
      else expect(result.successor).toBeNull();
    } finally {
      await retainedState.subscription.close();
      await r.service.dispose();
    }
  },
);
