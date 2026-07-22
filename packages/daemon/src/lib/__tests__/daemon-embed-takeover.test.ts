import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import { setDaemonShutdownBackend } from "../../command-center/actions/handlers/daemon-shutdown.ts";
import {
  getCanonicalDaemonClaimPath,
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfo,
  readCanonicalDaemonInfo,
  releaseCanonicalDaemonClaim,
  tryAcquireCanonicalDaemonClaim,
  writeCanonicalDaemonInfo,
  type CanonicalDaemonClaim,
  type CanonicalDaemonInfo,
} from "../canonical-daemon.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { WorkspaceRegistry, _setDefaultWorkspaceRegistryForTests } from "../workspace-registry.ts";

const INSTANCE_A = "9bcf33b0-c837-4a94-b5e8-c0977f54464f";
const INSTANCE_B = "76088827-c1f1-4451-bc2e-0a3ae7747434";

let stateDir: string;
let previousEnv: Record<string, string | undefined>;
const handles = new Set<EmbeddedDaemonHandle>();
const claims = new Set<CanonicalDaemonClaim>();
const servers = new Set<{ server: Server; sockets: Set<Socket> }>();

function trackHandle(handle: EmbeddedDaemonHandle): EmbeddedDaemonHandle {
  handles.add(handle);
  return handle;
}

function claimCanonicalSlot(): CanonicalDaemonClaim {
  const attempt = tryAcquireCanonicalDaemonClaim();
  if (attempt.status !== "acquired") throw new Error(`claim failed: ${attempt.status}`);
  claims.add(attempt.claim);
  return attempt.claim;
}

function daemonInfo(
  port: number,
  overrides: Partial<CanonicalDaemonInfo> = {},
): CanonicalDaemonInfo {
  return {
    pid: process.pid,
    port,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.8.0",
    instanceId: INSTANCE_A,
    startedAt: "2026-07-21T00:00:00.000Z",
    bindHostname: "127.0.0.1",
    authToken: null,
    ...overrides,
  };
}

async function fakeOwner(options: {
  action: "accept-stuck" | "refuse" | "timeout";
  identityInstanceId?: string;
  authToken?: string | null;
}): Promise<{
  info: CanonicalDaemonInfo;
  actionRequests: Array<{ authorization: string | undefined; body: unknown }>;
}> {
  const actionRequests: Array<{ authorization: string | undefined; body: unknown }> = [];
  let info!: CanonicalDaemonInfo;
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/identity") {
      res.end(
        JSON.stringify({
          ok: true,
          pid: info.pid,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          instanceId: options.identityInstanceId ?? info.instanceId,
          startedAt: info.startedAt,
        }),
      );
      return;
    }
    if (req.url === "/health") {
      res.end(
        JSON.stringify({
          ok: true,
          protocolVersion: info.protocolVersion,
          productVersion: info.productVersion,
          uptime: 1,
        }),
      );
      return;
    }
    if (req.url === "/api/v2/action/daemon.shutdown") {
      let raw = "";
      for await (const chunk of req) raw += chunk.toString();
      actionRequests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(raw),
      });
      if (options.action === "timeout") return;
      if (options.action === "accept-stuck") {
        res.end(JSON.stringify({ ok: true, result: { stopping: true } }));
        return;
      }
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: { code: "shutdown_already_in_progress" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.add({ server, sockets });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake owner did not bind TCP");
  info = daemonInfo(address.port, { authToken: options.authToken ?? null });
  writeCanonicalDaemonInfo(info, claimCanonicalSlot());
  return { info, actionRequests };
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tmux-ide-takeover-"));
  previousEnv = {
    TMUX_IDE_DAEMON_INFO_DIR: process.env.TMUX_IDE_DAEMON_INFO_DIR,
    TMUX_IDE_REGISTRY_DIR: process.env.TMUX_IDE_REGISTRY_DIR,
    TMUX_IDE_SETTINGS_DIR: process.env.TMUX_IDE_SETTINGS_DIR,
    TMUX_IDE_HOME: process.env.TMUX_IDE_HOME,
  };
  process.env.TMUX_IDE_DAEMON_INFO_DIR = stateDir;
  process.env.TMUX_IDE_REGISTRY_DIR = stateDir;
  process.env.TMUX_IDE_SETTINGS_DIR = stateDir;
  process.env.TMUX_IDE_HOME = stateDir;
  _setDefaultWorkspaceRegistryForTests(
    new WorkspaceRegistry({ dir: stateDir, listSessions: () => [] }),
  );
  setDaemonShutdownBackend(null);
});

afterEach(async () => {
  for (const handle of [...handles].reverse()) await handle.stop().catch(() => undefined);
  handles.clear();
  setDaemonShutdownBackend(null);
  for (const claim of claims) releaseCanonicalDaemonClaim(claim);
  claims.clear();
  for (const entry of servers) {
    for (const socket of entry.sockets) socket.destroy();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
  servers.clear();
  _setDefaultWorkspaceRegistryForTests(null);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe.sequential("embedded daemon cooperative takeover", () => {
  it("makes concurrent stop callers join canonical cleanup", async () => {
    const handle = trackHandle(await startEmbeddedDaemon({ silent: true }));
    const connection = connect({ host: "127.0.0.1", port: handle.port });
    await once(connection, "connect");

    const firstStop = handle.stop({ gracefulMs: 50 });
    await handle.stop();

    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(false);
    await firstStop;
    connection.destroy();
  });

  it("keeps the remotely shared token out of owner state during authenticated takeover", async () => {
    const owner = trackHandle(
      await startEmbeddedDaemon({
        bindHostname: "0.0.0.0",
        authToken: "remotely-shared-secret",
        localBypassToken: "old-owner-secret",
        silent: true,
      }),
    );
    const oldInfo = readCanonicalDaemonInfo();
    expect(oldInfo).toMatchObject({ instanceId: owner.instanceId, authToken: "old-owner-secret" });
    expect(JSON.stringify(oldInfo)).not.toContain("remotely-shared-secret");

    const replacement = trackHandle(
      await startEmbeddedDaemon({
        takeoverIfRunning: true,
        bindHostname: "127.0.0.1",
        authToken: null,
        silent: true,
      }),
    );
    expect(replacement.instanceId).not.toBe(owner.instanceId);
    expect(readCanonicalDaemonInfo()).toMatchObject({
      instanceId: replacement.instanceId,
      pid: replacement.pid,
      port: replacement.port,
    });

    await owner.stop();
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(replacement.instanceId);
    await replacement.stop();
    expect(existsSync(getCanonicalDaemonInfoPath())).toBe(false);
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(false);
  });

  it("leaves a refusing owner and its claim untouched while authenticating and pinning the request", async () => {
    const { info, actionRequests } = await fakeOwner({
      action: "refuse",
      authToken: "owner-secret",
    });

    await expect(
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    ).rejects.toMatchObject({ reason: "canonical_takeover_refused" });
    expect(actionRequests).toEqual([
      {
        authorization: "Bearer owner-secret",
        body: { reason: "takeover", expectedInstanceId: info.instanceId },
      },
    ]);
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(info.instanceId);
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(true);
  });

  it("times out without acquiring or clearing an unresponsive owner's claim", async () => {
    const { info } = await fakeOwner({ action: "timeout" });

    await expect(
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    ).rejects.toMatchObject({ reason: "canonical_takeover_timeout" });
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(info.instanceId);
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(true);
  });

  it("releases a briefly acquired replacement claim when an accepting owner never quiesces", async () => {
    const { info } = await fakeOwner({ action: "accept-stuck" });
    for (const claim of claims) releaseCanonicalDaemonClaim(claim);
    claims.clear();
    const claimPath = getCanonicalDaemonClaimPath();
    mkdirSync(claimPath, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(claimPath, "owner.json"),
      `${JSON.stringify({
        claimId: randomUUID(),
        pid: 2_147_483_647,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    ).rejects.toMatchObject({ reason: "canonical_takeover_timeout" });
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(info.instanceId);
    expect(existsSync(claimPath)).toBe(false);
  }, 15_000);

  it("refuses identity drift before sending a shutdown request", async () => {
    const { info, actionRequests } = await fakeOwner({
      action: "refuse",
      identityInstanceId: INSTANCE_B,
    });

    await expect(
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    ).rejects.toMatchObject({ reason: "canonical_takeover_identity_mismatch" });
    expect(actionRequests).toEqual([]);
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(info.instanceId);
  });

  it("allows exactly one replacement to win a simultaneous takeover race", async () => {
    const owner = trackHandle(await startEmbeddedDaemon({ silent: true }));

    const results = await Promise.allSettled([
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
      startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    ]);
    const winners = results.filter(
      (result): result is PromiseFulfilledResult<EmbeddedDaemonHandle> =>
        result.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    const replacement = trackHandle(winners[0]!.value);
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(replacement.instanceId);

    await owner.stop();
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(replacement.instanceId);
    await replacement.stop();
    expect(inspectCanonicalDaemonInfo().status).toBe("missing");
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(false);
  });

  it("recovers a dead stale claim and cleans the replacement generation", async () => {
    const deadPid = 2_147_483_647;
    const claimPath = getCanonicalDaemonClaimPath();
    mkdirSync(claimPath, { recursive: true, mode: 0o700 });
    chmodSync(claimPath, 0o700);
    writeFileSync(
      join(claimPath, "owner.json"),
      `${JSON.stringify({ claimId: randomUUID(), pid: deadPid, acquiredAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      getCanonicalDaemonInfoPath(),
      `${JSON.stringify(daemonInfo(4010, { pid: deadPid }))}\n`,
      { mode: 0o600 },
    );

    const replacement = trackHandle(
      await startEmbeddedDaemon({ takeoverIfRunning: true, silent: true }),
    );
    expect(readCanonicalDaemonInfo()?.instanceId).toBe(replacement.instanceId);
    await replacement.stop();
    expect(existsSync(getCanonicalDaemonInfoPath())).toBe(false);
    expect(existsSync(getCanonicalDaemonClaimPath())).toBe(false);
  });
});
