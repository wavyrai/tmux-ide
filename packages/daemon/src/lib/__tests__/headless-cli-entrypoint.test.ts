import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  DaemonHealthSchema,
  DaemonHealthzSchema,
  DaemonIdentitySchema,
} from "@tmux-ide/contracts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const cliPath = join(repoRoot, "bin/cli.js");
const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version: string }
).version;
const INSTANCE_ID = "9bcf33b0-c837-4a94-b5e8-c0977f54464f";
const STARTED_AT = "2026-07-21T00:00:00.000Z";

let tempDir: string;
let env: NodeJS.ProcessEnv;
const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<Server>();
const childOutput = new WeakMap<
  ChildProcessWithoutNullStreams,
  { stdout: string; stderr: string }
>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-headless-cli-"));
  const home = join(tempDir, "home");
  const state = join(tempDir, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  writeFileSync(
    join(state, "app-settings.json"),
    `${JSON.stringify({ remoteAccess: { enabled: true, token: "must-not-be-inherited" } })}\n`,
  );
  env = {
    ...process.env,
    HOME: home,
    NO_COLOR: "1",
    TMUX_IDE_DAEMON_INFO_DIR: state,
    TMUX_IDE_REGISTRY_DIR: state,
    TMUX_IDE_SETTINGS_DIR: state,
  };
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
  children.clear();
  await Promise.all(
    [...servers].map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
  servers.clear();
  rmSync(tempDir, { recursive: true, force: true });
});

function daemonInfoPath(): string {
  return join(env.TMUX_IDE_DAEMON_INFO_DIR!, "daemon.json");
}

function spawnCli(args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: tempDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const output = { stdout: "", stderr: "" };
  childOutput.set(child, output);
  child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  return child;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const output = childOutput.get(child) ?? { stdout: "", stderr: "" };
  if (child.exitCode != null || child.signalCode != null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
  }
  return await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`CLI did not exit; stderr: ${output.stderr}`)),
      timeoutMs,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal, stdout: output.stdout, stderr: output.stderr });
    });
  });
}

async function waitUntil<T>(read: () => T | null, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for headless daemon state");
}

async function waitForDaemonInfo(
  accept: (info: CanonicalDaemonInfo) => boolean = () => true,
): Promise<CanonicalDaemonInfo> {
  return await waitUntil(() => {
    try {
      const info = JSON.parse(readFileSync(daemonInfoPath(), "utf-8")) as CanonicalDaemonInfo;
      return accept(info) ? info : null;
    } catch {
      return null;
    }
  });
}

function writeLiveDaemonInfo(port: number, protocolVersion = DAEMON_WIRE_PROTOCOL_VERSION): void {
  writeFileSync(
    daemonInfoPath(),
    `${JSON.stringify({
      pid: process.pid,
      port,
      protocolVersion,
      productVersion: protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION ? packageVersion : "future",
      instanceId: INSTANCE_ID,
      startedAt: STARTED_AT,
      bindHostname: "127.0.0.1",
      authToken: null,
    })}\n`,
    { mode: 0o600 },
  );
}

async function listenWithProtocol(protocolVersion: number): Promise<number> {
  const server = createServer((request, response) => {
    if (request.url === "/identity") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          pid: process.pid,
          protocolVersion,
          productVersion:
            protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION ? packageVersion : "future",
          instanceId: INSTANCE_ID,
          startedAt: STARTED_AT,
        }),
      );
      return;
    }
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        protocolVersion,
        productVersion:
          protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION ? packageVersion : "future",
        uptime: 42,
      }),
    );
  });
  servers.add(server);
  return await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe.sequential("shipped tmux-ide --headless entrypoint", () => {
  it("documents the real root flag and preserves the root version command", async () => {
    const help = await waitForExit(spawnCli(["--help"]));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("tmux-ide --headless");
    expect(help.stdout).toContain("--headless");
    expect(help.stdout).toContain("Canonical daemon only; no tmux workspace or TUI");

    const version = await waitForExit(spawnCli(["--version"]));
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^tmux-ide v\d+\.\d+\.\d+$/);

    const mixed = await waitForExit(spawnCli(["--headless", "status"]));
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("--headless cannot be combined");
  }, 15_000);

  it("replaces stale state, reuses a live owner, and exits after API shutdown", async () => {
    writeFileSync(
      daemonInfoPath(),
      `${JSON.stringify({
        pid: 999_999_999,
        port: 9,
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "stale-test",
        instanceId: INSTANCE_ID,
        startedAt: STARTED_AT,
        bindHostname: "127.0.0.1",
        authToken: null,
      })}\n`,
      { mode: 0o600 },
    );

    const owner = spawnCli(["--headless", "--json"]);
    const info = await waitForDaemonInfo((candidate) => candidate.pid === owner.pid);
    expect(info.pid).toBe(owner.pid);
    expect(info.authToken).toEqual(expect.any(String));
    expect(info.productVersion).toBe(packageVersion);
    expect(info.instanceId).toMatch(/^[0-9a-f-]{36}$/u);

    const healthResponse = await fetch(`http://127.0.0.1:${info.port}/health`);
    expect(healthResponse.ok).toBe(true);
    const health = DaemonHealthSchema.parse(await healthResponse.json());
    expect(health.protocolVersion).toBe(DAEMON_WIRE_PROTOCOL_VERSION);
    expect(info.protocolVersion).toBe(health.protocolVersion);
    expect(health.productVersion).toBe(info.productVersion);

    const healthz = DaemonHealthzSchema.parse(
      await (await fetch(`http://127.0.0.1:${info.port}/healthz`)).json(),
    );
    expect(healthz.productVersion).toBe(info.productVersion);

    const identity = DaemonIdentitySchema.parse(
      await (await fetch(`http://127.0.0.1:${info.port}/identity`)).json(),
    );
    expect(identity).toMatchObject({
      pid: info.pid,
      protocolVersion: info.protocolVersion,
      productVersion: info.productVersion,
      instanceId: info.instanceId,
      startedAt: info.startedAt,
    });

    const contender = await waitForExit(spawnCli(["--headless", "--json"]));
    expect(contender.code).toBe(0);
    expect(JSON.parse(contender.stdout.trim())).toMatchObject({
      status: "already-running",
      pid: owner.pid,
      port: info.port,
    });

    const shutdown = await fetch(`http://127.0.0.1:${info.port}/api/v2/action/daemon.shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "entrypoint integration test" }),
    });
    expect(shutdown.ok).toBe(true);

    const ownerExit = await waitForExit(owner);
    expect(ownerExit).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(ownerExit.stdout.trim())).toMatchObject({
      status: "ready",
      pid: owner.pid,
      port: info.port,
    });
    await waitUntil(() => (existsSync(daemonInfoPath()) ? null : true));
  }, 15_000);

  it("elects exactly one owner from simultaneous cold-start contenders", async () => {
    const contenders = Array.from({ length: 20 }, () => spawnCli(["--headless", "--json"]));
    const info = await waitForDaemonInfo();
    const owner = contenders.find((child) => child.pid === info.pid);
    expect(owner).toBeDefined();

    const losers = contenders.filter((child) => child !== owner);
    const loserResults = await Promise.all(losers.map((child) => waitForExit(child, 20_000)));
    for (const result of loserResults) {
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        status: "already-running",
        pid: info.pid,
        port: info.port,
      });
    }

    expect(
      contenders.filter((child) => child.exitCode == null && child.signalCode == null),
    ).toEqual([owner]);
    const identity = DaemonIdentitySchema.parse(
      await (await fetch(`http://127.0.0.1:${info.port}/identity`)).json(),
    );
    expect(identity).toMatchObject({ pid: owner?.pid, instanceId: info.instanceId });

    owner?.kill("SIGTERM");
    await expect(waitForExit(owner!, 15_000)).resolves.toMatchObject({ code: 0, signal: null });
    await waitUntil(() => (existsSync(daemonInfoPath()) ? null : true));
  }, 30_000);

  it("refuses takeover of a live daemon with an incompatible protocol", async () => {
    const port = await listenWithProtocol(2);
    writeLiveDaemonInfo(port, 2);

    const result = await waitForExit(spawnCli(["--headless", "--json"]));

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "DAEMON_PROTOCOL_MISMATCH" });
    expect(JSON.parse(readFileSync(daemonInfoPath(), "utf-8"))).toMatchObject({
      pid: process.pid,
      port,
      protocolVersion: 2,
    });
  });

  it("refuses takeover of a live owner whose identity endpoint is unavailable", async () => {
    writeLiveDaemonInfo(9);

    const result = await waitForExit(spawnCli(["--headless", "--json"]));

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "DAEMON_IDENTITY_UNAVAILABLE" });
    expect(JSON.parse(readFileSync(daemonInfoPath(), "utf-8"))).toMatchObject({
      pid: process.pid,
      port: 9,
    });
  });

  it("refuses live protocol-less, malformed, and insecure canonical records", async () => {
    const valid = {
      pid: process.pid,
      port: 9,
      productVersion: packageVersion,
      instanceId: INSTANCE_ID,
      startedAt: STARTED_AT,
      bindHostname: "127.0.0.1",
      authToken: null,
    };

    writeFileSync(daemonInfoPath(), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
    const protocolLess = await waitForExit(spawnCli(["--headless", "--json"]));
    expect(protocolLess.code).toBe(1);
    expect(JSON.parse(protocolLess.stderr)).toMatchObject({ code: "DAEMON_INFO_INVALID" });
    expect(JSON.parse(readFileSync(daemonInfoPath(), "utf-8"))).toMatchObject({ pid: process.pid });

    writeFileSync(daemonInfoPath(), "{", { mode: 0o600 });
    const malformed = await waitForExit(spawnCli(["--headless", "--json"]));
    expect(malformed.code).toBe(1);
    expect(JSON.parse(malformed.stderr)).toMatchObject({ code: "DAEMON_INFO_INVALID" });
    expect(readFileSync(daemonInfoPath(), "utf-8")).toBe("{");

    writeFileSync(
      daemonInfoPath(),
      `${JSON.stringify({ ...valid, protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION })}\n`,
      { mode: 0o600 },
    );
    chmodSync(daemonInfoPath(), 0o644);
    const insecure = await waitForExit(spawnCli(["--headless", "--json"]));
    expect(insecure.code).toBe(1);
    expect(JSON.parse(insecure.stderr)).toMatchObject({ code: "DAEMON_INFO_INVALID" });
    expect(existsSync(daemonInfoPath())).toBe(true);
  });

  it("cleans canonical state and exits zero on SIGTERM", async () => {
    const owner = spawnCli(["--headless", "--json"]);
    const info = await waitForDaemonInfo();
    expect(info.pid).toBe(owner.pid);

    owner.kill("SIGTERM");

    const result = await waitForExit(owner);
    expect(result).toMatchObject({ code: 0, signal: null });
    await waitUntil(() => (existsSync(daemonInfoPath()) ? null : true));
  }, 15_000);
});
