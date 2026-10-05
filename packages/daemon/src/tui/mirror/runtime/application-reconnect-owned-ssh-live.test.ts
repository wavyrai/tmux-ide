/** Opt-in real OpenSSH and HTTP proof; owns no production daemon or tmux session. */
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { loadSavedMachines, watchSavedMachines } from "../../../lib/saved-machines.ts";
import { TmuxServerOwners } from "../../../lib/tmux-server-owners.ts";
import type { NativeTmuxServerOwner } from "../../../lib/tmux-server-owner.ts";
import { createApp } from "../../../command-center/server.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";
import { createApplicationMachineAuthorityManager } from "./application-machine-authority.ts";
import { createApplicationMachineCatalog } from "./application-machine-catalog.ts";
import { createApplicationDaemonAuthority } from "./application-daemon-authority-owner.ts";
// @ts-expect-error Private JS test fixture has no public declaration surface.
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
  unusedLoopbackPort,
  waitForPort,
} from "../../../../../../scripts/lib/owned-ssh-fixture.mjs";

it.skipIf(process.env.TMUX_IDE_OWNED_RECONNECT_SSH !== "1" || process.platform !== "darwin")(
  "reconnects over real SSH and groups verified aliases without replacing the surviving route",
  async () => {
    const previousUmask = process.umask(0o077);
    const root = mkdtempSync(join(realpathSync(tmpdir()), "reconnect-"));
    const allocations: Array<{ disposeFiles(): Promise<void>; diagnostics?(): unknown }> = [];
    let kernel: { identify(pid: number): Promise<string | null> };
    const tracker = ownedProcesses({
      identify: (pid: number) => kernel.identify(pid),
      list: async () =>
        execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            return { pid, ppid };
          }),
    });
    const servers: ReturnType<typeof serve>[] = [];
    const registries: TmuxServerOwners<NativeTmuxServerOwner>[] = [];
    const transports: Awaited<ReturnType<typeof openSshDaemonTransport>>[] = [];
    let current: CanonicalDaemonInfo | null = null;
    let missingHandshakes = 0;
    let handshakeGate: Promise<void> | null = null;
    let releaseHandshake: (() => void) | null = null;
    let gatedHandshakes = 0;
    const environmentId = randomUUID();
    async function backend() {
      const identity = {
        instanceId: randomUUID(),
        environmentId,
        startedAt: new Date().toISOString(),
        productVersion: "reconnect-fixture",
      };
      const authToken = randomUUID();
      // Serve the real authenticated modern discovery route with an empty
      // private registry. The protocol fixture never acquires a tmux server.
      const registry = new TmuxServerOwners<NativeTmuxServerOwner>({
        probe: async () => null,
        create: async () => {
          throw new Error("Fixture must not acquire a tmux owner");
        },
      });
      registries.push(registry);
      const app = createApp({
        tmuxServerOwners: registry,
        remoteAccess: { ownerToken: authToken },
        daemonIdentity: identity,
        catalogLiveSessions: () => [],
        catalogFleet: () => [],
      });
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      servers.push(server);
      await vi.waitFor(() => expect(server.address()).not.toBeNull());
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No fixture listener");
      return {
        server,
        info: {
          ...identity,
          pid: process.pid,
          port: address.port,
          bindHostname: "127.0.0.1" as const,
          authToken,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        },
      };
    }
    const closeServer = async (server: ReturnType<typeof serve>) => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
    };
    let authority: ReturnType<typeof createApplicationDaemonAuthority> | undefined;
    let manager: ReturnType<typeof createApplicationMachineAuthorityManager> | undefined;
    let catalog: ReturnType<typeof createApplicationMachineCatalog> | undefined;
    try {
      kernel = await createMacProcessIdentity({
        parent: root,
        onAllocated: (a: (typeof allocations)[number]) => allocations.push(a),
      });
      const first = await backend();
      current = first.info;
      const ssh = await createOwnedSshFixture({
        parent: root,
        node: process.execPath,
        targetPort: first.info.port,
        processes: tracker,
        handshake: async () => {
          if (handshakeGate) {
            gatedHandshakes++;
            await handshakeGate;
          }
          if (!current) missingHandshakes++;
          return current
            ? { version: 1, daemon: current }
            : { version: 1, error: { code: "daemon-missing" } };
        },
        onAllocated: (a: (typeof allocations)[number]) => allocations.push(a),
      });
      const aliasConfig = join(root, "aliases.config");
      const privateConfig = readFileSync(ssh.config, "utf8");
      expect(privateConfig.startsWith("Host target\n")).toBe(true);
      writeFileSync(
        aliasConfig,
        privateConfig.replace("Host target\n", "Host target alternate\n"),
        {
          mode: 0o600,
        },
      );
      const createOwner = () =>
        createApplicationDaemonAuthority({
          readLocal: () => null,
          isLocalAlive: async () => false,
          observeLocal: async () => () => {},
          verify: probeSshDaemonIdentity,
          probeIntervalMs: 25,
          retryDelayMs: 50,
          connect: async (options) => {
            const transport = await openSshDaemonTransport(options, {
              spawn: (args) =>
                tracker.retain(
                  spawn("/usr/bin/ssh", ["-F", aliasConfig, ...args], {
                    stdio: ["ignore", "pipe", "pipe"],
                  }),
                ),
              allocatePort: unusedLoopbackPort,
              probe: probeSshDaemonIdentity,
            });
            transports.push(transport);
            return transport;
          },
        });
      authority = createOwner();
      await authority.initialize("target");
      const oldDescriptor = authority.read()!;
      expect(oldDescriptor.instanceId).toBe(first.info.instanceId);
      current = null;
      await closeServer(first.server);
      await vi.waitFor(() => expect(missingHandshakes).toBeGreaterThanOrEqual(2), {
        timeout: 10000,
      });
      expect(authority.read()).toBeNull();
      const second = await backend();
      expect(second.info.port).not.toBe(first.info.port);
      await ssh.refreshTargetPort(second.info.port);
      current = second.info;
      await vi.waitFor(() => expect(authority!.read()?.instanceId).toBe(second.info.instanceId), {
        timeout: 10000,
      });
      expect(await authority.isAlive(oldDescriptor)).toBe(false);
      expect(
        await probeSshDaemonIdentity(
          authority.endpoint().localBaseUrl!,
          second.info,
          AbortSignal.timeout(2000),
        ),
      ).toBe(true);
      expect(authority.endpoint().diagnostic?.phase).toBe("ready");
      // Use the same private SSH target through two saved routes. Catalog
      // grouping must follow verified environment identity, not alias text.
      manager = createApplicationMachineAuthorityManager({ createOwner });
      const profiles = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ].map((id, index) => ({
        id,
        label: `Route ${index}`,
        sshTarget: index === 0 ? "target" : "alternate",
        enabled: true,
      }));
      const registryPath = join(root, "machines.json");
      const replaceProfiles = (machines: typeof profiles) => {
        const temporary = join(root, "machines.next");
        writeFileSync(temporary, JSON.stringify({ version: 1, machines }), { mode: 0o600 });
        renameSync(temporary, registryPath);
      };
      replaceProfiles(profiles);
      manager.initialize(loadSavedMachines(registryPath).machines);
      const registryError = vi.fn();
      manager.followProfiles((onChange) =>
        watchSavedMachines((registry) => onChange(registry.machines), registryError, registryPath),
      );
      expect(await Promise.all(profiles.map(({ id }) => manager!.getMachine(id)!.ready))).toEqual([
        true,
        true,
      ]);
      catalog = createApplicationMachineCatalog({ manager });
      catalog.start();
      await vi.waitFor(
        () => {
          const remote = catalog!.getSnapshot().groups.filter((group) => group.id !== "local");
          expect(remote).toHaveLength(1);
          expect(remote[0]).toMatchObject({
            state: "ready",
            environmentId,
            routeIds: profiles.map(({ id }) => id),
          });
        },
        { timeout: 10_000 },
      );
      const survivor = manager.getMachine(profiles[1]!.id)!;
      const survivingEpoch = survivor.endpoint().epoch;
      replaceProfiles([{ ...profiles[0]!, enabled: false }, profiles[1]!]);
      await vi.waitFor(() => {
        const remote = catalog!.getSnapshot().groups.filter((group) => group.id !== "local");
        expect(remote).toHaveLength(1);
        expect(remote[0]).toMatchObject({ state: "ready", routeIds: [profiles[1]!.id] });
      });
      expect(manager.getMachine(profiles[0]!.id)).toBeNull();
      expect(manager.getMachine(profiles[1]!.id)).toBe(survivor);
      expect(survivor.endpoint().epoch).toBe(survivingEpoch);
      expect(await survivor.isAlive(survivor.read()!)).toBe(true);

      // Re-enable through another atomic replacement, then edit the SSH target
      // while both routes are connected. The unaffected route must survive.
      replaceProfiles(profiles);
      await vi.waitFor(() =>
        expect(manager!.getMachine(profiles[0]!.id)?.read()?.instanceId).toBe(
          second.info.instanceId,
        ),
      );
      const beforeEdit = manager.getMachine(profiles[0]!.id)!;
      expect(await beforeEdit.ready).toBe(true);
      replaceProfiles([{ ...profiles[0]!, sshTarget: "alternate" }, profiles[1]!]);
      await vi.waitFor(
        () => {
          const edited = manager!.getMachine(profiles[0]!.id);
          expect(edited).not.toBeNull();
          expect(edited).not.toBe(beforeEdit);
          expect(edited!.read()?.instanceId).toBe(second.info.instanceId);
        },
        { timeout: 10000 },
      );
      expect(beforeEdit.read()).toBeNull();
      expect(beforeEdit.endpoint().state).toBe("disconnected");
      expect(manager.getMachine(profiles[1]!.id)).toBe(survivor);
      expect(survivor.endpoint().epoch).toBe(survivingEpoch);

      // A partially written registry must not destroy healthy connections.
      const edited = manager.getMachine(profiles[0]!.id)!;
      writeFileSync(registryPath, "{", { mode: 0o600 });
      await vi.waitFor(() => expect(registryError).toHaveBeenCalled());
      expect(manager.getMachine(profiles[0]!.id)).toBe(edited);
      expect(manager.getMachine(profiles[1]!.id)).toBe(survivor);
      expect(await survivor.isAlive(survivor.read()!)).toBe(true);

      replaceProfiles([profiles[1]!]);
      await vi.waitFor(
        () => {
          expect(manager!.getMachine(profiles[0]!.id)).toBeNull();
          const remote = catalog!.getSnapshot().groups.filter((group) => group.id !== "local");
          expect(remote).toHaveLength(1);
          expect(remote[0]).toMatchObject({ state: "ready", routeIds: [profiles[1]!.id] });
        },
        { timeout: 10000 },
      );
      expect(edited.read()).toBeNull();
      expect(manager.getMachine(profiles[1]!.id)).toBe(survivor);
      expect(survivor.endpoint().epoch).toBe(survivingEpoch);
      expect(await survivor.isAlive(survivor.read()!)).toBe(true);

      for (const mutation of ["disable", "remove", "edit"] as const) {
        const beforeGate = gatedHandshakes;
        handshakeGate = new Promise<void>((resolve) => {
          releaseHandshake = resolve;
        });
        replaceProfiles(profiles);
        await vi.waitFor(() => expect(gatedHandshakes).toBeGreaterThan(beforeGate), {
          timeout: 10000,
        });
        const pending = manager.getMachine(profiles[0]!.id)!;
        expect(pending).not.toBeNull();
        expect(pending.read()).toBeNull();
        replaceProfiles(
          mutation === "remove"
            ? [profiles[1]!]
            : [
                {
                  ...profiles[0]!,
                  ...(mutation === "disable" ? { enabled: false } : { sshTarget: "alternate" }),
                },
                profiles[1]!,
              ],
        );
        await vi.waitFor(() => expect(manager!.getMachine(profiles[0]!.id)).not.toBe(pending));
        expect(await pending.ready).toBe(false);
        releaseHandshake!();
        releaseHandshake = null;
        handshakeGate = null;
        if (mutation === "edit") {
          await vi.waitFor(
            () =>
              expect(manager!.getMachine(profiles[0]!.id)?.read()?.instanceId).toBe(
                second.info.instanceId,
              ),
            { timeout: 10000 },
          );
        } else expect(manager.getMachine(profiles[0]!.id)).toBeNull();
        expect(pending.read()).toBeNull();
        expect(manager.getMachine(profiles[1]!.id)).toBe(survivor);
        expect(survivor.endpoint().epoch).toBe(survivingEpoch);
        expect(await survivor.isAlive(survivor.read()!)).toBe(true);
      }
    } catch (error) {
      if (catalog)
        console.error(
          "Owned catalog states",
          catalog
            .getSnapshot()
            .groups.map(({ id, state, environmentId, identityConflict, note }) => ({
              id,
              state,
              environmentId,
              identityConflict,
              note,
            })),
        );
      console.error(
        "Owned SSH fixture diagnostics",
        allocations.map((a) => a.diagnostics?.()),
      );
      throw error;
    } finally {
      releaseHandshake?.();
      process.umask(previousUmask);
      catalog?.dispose();
      manager?.dispose();
      authority?.dispose();
      for (const t of transports) {
        t.dispose();
        await t.closed;
      }
      for (const server of servers) await closeServer(server);
      for (const registry of registries) await registry.dispose();
      await tracker.dispose();
      for (const t of transports) await waitForPort(Number(new URL(t.baseUrl).port), false);
      for (const a of allocations.reverse()) await a.disposeFiles();
      rmSync(root, { recursive: true });
    }
  },
  45000,
);
