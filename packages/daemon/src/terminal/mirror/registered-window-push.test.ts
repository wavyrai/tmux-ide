/**
 * #764: after link-window, does the daemon tell the session it is now shared
 * without the user doing anything? The guard is invalidated by the
 * structural notification; the channel's own debounced sync re-verifies it
 * (beforeIdentityRepair) and pushes onSharedWindowConflict.
 */
import { describe, expect, it, vi } from "vitest";
import { OwnedSnapshotChannel } from "./__tests__/owned-snapshot-channel.ts";
import { fixtureAutoReply, fixtureState, FIXTURE } from "./__tests__/simulated-channel.ts";
import { MirrorService } from "./mirror-service.ts";

function rig(onSharedWindowConflict: (session: string, conflicted: boolean) => void) {
  const sims: OwnedSnapshotChannel[] = [];
  const service = new MirrorService({
    createIo: (_session, handlers) => {
      const sim = new OwnedSnapshotChannel(
        handlers,
        (cmd) => {
          const auto = fixtureAutoReply(fixtureState())(cmd);
          if (auto) return auto;
          if (cmd.startsWith("capture-pane")) return ["seed"];
          if (cmd.startsWith("display-message")) return ["0 0 100 50"];
          return [];
        },
        () => ["seed"],
        () => "0 0 100 50",
      );
      sims.push(sim);
      return sim;
    },
    generatePaneId: () => "pane.mirror.gen1",
    onSharedWindowConflict,
  });
  return { service, sims };
}

describe("a window linked into another registered session", () => {
  it("is pushed as a conflict by the channel's own sync, with no operation", async () => {
    const pushed: [string, boolean][] = [];
    const { service, sims } = rig((session, conflicted) => pushed.push([session, conflicted]));
    const subscription = await service.subscribe({
      session: FIXTURE.session,
      semanticPaneId: "pane.alpha",
      onEvent: () => {},
    });
    let rows = [{ session: FIXTURE.session, window: "@1" }];
    try {
      service.setRegisteredWindowReader(async () => rows);
      await service.verifyRegisteredWindows();
      rows = [...rows, { session: "journey-beta", window: "@1" }];
      sims[0]!.feedLines("%window-add @1");
      await vi.waitFor(() => expect(pushed).toContainEqual([FIXTURE.session, true]), {
        timeout: 2_000,
      });
    } finally {
      await subscription.close();
      await service.dispose();
    }
  });

  it("is still pushed when the first re-read of registered windows fails", async () => {
    const pushed: [string, boolean][] = [];
    const { service, sims } = rig((session, conflicted) => pushed.push([session, conflicted]));
    const subscription = await service.subscribe({
      session: FIXTURE.session,
      semanticPaneId: "pane.alpha",
      onEvent: () => {},
    });
    let rows = [{ session: FIXTURE.session, window: "@1" }];
    let failNext = false;
    try {
      service.setRegisteredWindowReader(async () => {
        if (failNext) {
          failNext = false;
          throw new Error("registered window read timed out");
        }
        return rows;
      });
      await service.verifyRegisteredWindows();
      rows = [...rows, { session: "journey-beta", window: "@1" }];
      failNext = true;
      sims[0]!.feedLines("%window-add @1");
      // The user does nothing: no input, no fit, no mutation.
      await vi.waitFor(() => expect(pushed).toContainEqual([FIXTURE.session, true]), {
        timeout: 2_000,
      });
    } finally {
      expect(service.windowOwnershipMessage(FIXTURE.session)).not.toMatch(/being verified/);
      await subscription.close();
      await service.dispose();
    }
  });
});
