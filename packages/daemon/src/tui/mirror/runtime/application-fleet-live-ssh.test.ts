import { expect, it } from "vitest";
import { createApplicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { createApplicationMachineCatalog } from "./application-machine-catalog.ts";

// Opt-in, read-only remote qualification. Never starts/stops the remote daemon or tmux.
const alias = process.env.TMUX_IDE_FLEET_TEST_SSH;
it.skipIf(!alias)(
  "keeps two independent SSH clients alive and deduplicates authenticated routes",
  async () => {
    const first = createApplicationMachineAuthorityManager();
    const second = createApplicationMachineAuthorityManager();
    const catalog = createApplicationMachineCatalog({ manager: first });
    const id = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    try {
      const start = performance.now();
      const profile = { id, label: "Qualification remote", sshTarget: alias!, enabled: true };
      first.initialize([profile, { ...profile, id: other, label: "Second route" }]);
      second.initialize([profile]);
      expect(first.snapshot().selectedMachineId).toBe("local");
      const ready = await Promise.all([
        first.getMachine(id)!.ready,
        first.getMachine(other)!.ready,
        second.getMachine(id)!.ready,
      ]);
      expect(ready).toEqual([true, true, true]);
      catalog.start();
      await expect
        .poll(
          () =>
            catalog
              .getSnapshot()
              .groups.filter(
                (g) => g.id !== "local" && g.state === "ready" && g.routeIds?.length === 2,
              ),
          { timeout: 10000 },
        )
        .toHaveLength(1);
      const group = catalog.getSnapshot().groups.find((g) => g.id !== "local")!;
      expect(group.routeIds).toHaveLength(2);
      expect(group.environmentId).toBe(second.getMachine(id)!.read()!.environmentId);
      const before = second.getMachine(id)!.read()!;
      first.dispose();
      expect(await second.getMachine(id)!.isAlive(before)).toBe(true);
      console.log(
        JSON.stringify({
          qualification: "real-ssh-two-clients",
          readyMs: Math.round(performance.now() - start),
          routes: 3,
          remoteGroups: 1,
          sessions: group.sessions.length,
          survivingClient: true,
        }),
      );
    } finally {
      catalog.dispose();
      first.dispose();
      second.dispose();
    }
  },
  30000,
);
