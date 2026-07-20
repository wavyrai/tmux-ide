import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCanonicalDaemonInfo,
  getCanonicalDaemonInfoPath,
  isCanonicalDaemonAlive,
  probeCanonicalDaemonHealth,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";

let tempDir: string;
let previousDir: string | undefined;
let server: Server | null = null;

beforeEach(() => {
  previousDir = process.env.TMUX_IDE_DAEMON_INFO_DIR;
  tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-daemon-info-"));
  process.env.TMUX_IDE_DAEMON_INFO_DIR = tempDir;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  if (previousDir === undefined) delete process.env.TMUX_IDE_DAEMON_INFO_DIR;
  else process.env.TMUX_IDE_DAEMON_INFO_DIR = previousDir;
  rmSync(tempDir, { recursive: true, force: true });
});

function info(port: number): CanonicalDaemonInfo {
  return {
    pid: process.pid,
    port,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    version: "0.0.0-test",
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: null,
  };
}

function listen(): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          version: "0.0.0-test",
          uptime: 42,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("canonical daemon info", () => {
  it("atomically writes, reads, probes, and clears daemon info", async () => {
    const port = await listen();
    writeCanonicalDaemonInfo(info(port));

    expect(getCanonicalDaemonInfoPath()).toBe(join(tempDir, "daemon.json"));
    expect(readCanonicalDaemonInfo()?.port).toBe(port);
    expect(await isCanonicalDaemonAlive(info(port))).toBe(true);
    expect((await probeCanonicalDaemonHealth(info(port)))?.protocolVersion).toBe(
      DAEMON_WIRE_PROTOCOL_VERSION,
    );

    clearCanonicalDaemonInfo();
    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("treats a dead PID as stale", async () => {
    const port = await listen();
    expect(await isCanonicalDaemonAlive({ ...info(port), pid: 999_999_999 })).toBe(false);
  });

  it("retains ownership for a live PID even when health is unreachable", async () => {
    expect(await isCanonicalDaemonAlive(info(9))).toBe(true);
    expect(await probeCanonicalDaemonHealth(info(9))).toBeNull();
  });

  it("returns null when no daemon file exists", () => {
    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("rejects an empty canonical authentication token", () => {
    writeFileSync(getCanonicalDaemonInfoPath(), JSON.stringify({ ...info(6060), authToken: "" }), {
      mode: 0o600,
    });
    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("retains an unknown positive wire version so ownership is not lost", () => {
    const path = getCanonicalDaemonInfoPath();
    writeFileSync(path, JSON.stringify({ ...info(6060), protocolVersion: 2 }), { mode: 0o600 });

    expect(readCanonicalDaemonInfo()?.protocolVersion).toBe(2);
  });

  it("does not serialize a local bypass token if one is present on the input object", async () => {
    const port = await listen();
    writeCanonicalDaemonInfo({ ...info(port), localBypassToken: "secret" } as CanonicalDaemonInfo);

    const raw = JSON.parse(readFileSync(getCanonicalDaemonInfoPath(), "utf-8")) as Record<
      string,
      unknown
    >;

    expect(raw.localBypassToken).toBeUndefined();
  });

  it("writes token-bearing daemon info owner-only", async () => {
    const port = await listen();
    writeCanonicalDaemonInfo({ ...info(port), authToken: "remote-secret" });

    expect(statSync(getCanonicalDaemonInfoPath()).mode & 0o777).toBe(0o600);
    expect(readCanonicalDaemonInfo()?.authToken).toBe("remote-secret");
  });

  it("rejects a token-bearing file with group or world access", () => {
    const path = getCanonicalDaemonInfoPath();
    writeFileSync(path, JSON.stringify({ ...info(6060), authToken: "leaked" }), { mode: 0o644 });
    chmodSync(path, 0o644);

    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("rejects symlinks and oversized daemon info", () => {
    const path = getCanonicalDaemonInfoPath();
    const target = join(tempDir, "target.json");
    writeFileSync(target, JSON.stringify(info(6060)), { mode: 0o600 });
    symlinkSync(target, path);
    expect(readCanonicalDaemonInfo()).toBeNull();

    rmSync(path);
    writeFileSync(path, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("deliberately treats an explicit empty daemon directory like an unset value", () => {
    const previousRegistry = process.env.TMUX_IDE_REGISTRY_DIR;
    process.env.TMUX_IDE_DAEMON_INFO_DIR = "";
    process.env.TMUX_IDE_REGISTRY_DIR = tempDir;
    try {
      expect(getCanonicalDaemonInfoPath()).toBe(join(tempDir, "daemon.json"));
    } finally {
      if (previousRegistry === undefined) delete process.env.TMUX_IDE_REGISTRY_DIR;
      else process.env.TMUX_IDE_REGISTRY_DIR = previousRegistry;
    }
  });
});
