import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCanonicalDaemonInfo,
  getCanonicalDaemonInfoPath,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";

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
      res.end(JSON.stringify({ ok: true }));
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

    clearCanonicalDaemonInfo();
    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("treats a dead PID as stale", async () => {
    const port = await listen();
    expect(await isCanonicalDaemonAlive({ ...info(port), pid: 999_999_999 })).toBe(false);
  });

  it("treats a live PID with no healthy server as stale", async () => {
    expect(await isCanonicalDaemonAlive(info(9))).toBe(false);
  });

  it("returns null when no daemon file exists", () => {
    expect(readCanonicalDaemonInfo()).toBeNull();
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
});
