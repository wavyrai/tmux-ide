/** Opt-in real OpenSSH and HTTP proof; owns no production daemon or tmux session. */
import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { createApp } from "../../../command-center/server.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
} from "../../../lib/ssh-daemon-transport.ts";
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
  "reconnects the same authority over real SSH after a missing record and changed daemon port",
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
    const transports: Awaited<ReturnType<typeof openSshDaemonTransport>>[] = [];
    let current: CanonicalDaemonInfo | null = null;
    let missingHandshakes = 0;
    const environmentId = randomUUID();
    async function backend() {
      const identity = {
        instanceId: randomUUID(),
        environmentId,
        startedAt: new Date().toISOString(),
        productVersion: "reconnect-fixture",
      };
      const authToken = randomUUID();
      const app = createApp({
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
        handshake: () => {
          if (!current) missingHandshakes++;
          return current
            ? { version: 1, daemon: current }
            : { version: 1, error: { code: "daemon-missing" } };
        },
        onAllocated: (a: (typeof allocations)[number]) => allocations.push(a),
      });
      authority = createApplicationDaemonAuthority({
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
                spawn("/usr/bin/ssh", ["-F", ssh.config, ...args], {
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
    } catch (error) {
      console.error(
        "Owned SSH fixture diagnostics",
        allocations.map((a) => a.diagnostics?.()),
      );
      throw error;
    } finally {
      process.umask(previousUmask);
      authority?.dispose();
      for (const t of transports) {
        t.dispose();
        await t.closed;
      }
      for (const server of servers) await closeServer(server);
      await tracker.dispose();
      for (const t of transports) await waitForPort(Number(new URL(t.baseUrl).port), false);
      for (const a of allocations.reverse()) await a.disposeFiles();
      rmSync(root, { recursive: true });
    }
  },
  45000,
);
