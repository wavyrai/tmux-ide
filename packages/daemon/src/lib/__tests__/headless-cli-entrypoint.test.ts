import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CanonicalDaemonInfo } from "../canonical-daemon.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const cliPath = join(repoRoot, "bin/cli.js");
const packageVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version: string }
).version;

let tempDir: string;
let env: NodeJS.ProcessEnv;
const children = new Set<ChildProcessWithoutNullStreams>();
const childOutput = new WeakMap<
  ChildProcessWithoutNullStreams,
  { stdout: string; stderr: string }
>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-headless-cli-"));
  const home = join(tempDir, "home");
  const state = join(tempDir, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
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
  });

  it("replaces stale state, reuses a live owner, and exits after API shutdown", async () => {
    writeFileSync(
      daemonInfoPath(),
      `${JSON.stringify({
        pid: 999_999_999,
        port: 9,
        version: "stale-test",
        startedAt: "2026-07-21T00:00:00.000Z",
        bindHostname: "127.0.0.1",
        authToken: null,
      })}\n`,
    );

    const owner = spawnCli(["--headless", "--json"]);
    const info = await waitForDaemonInfo((candidate) => candidate.pid === owner.pid);
    expect(info.pid).toBe(owner.pid);
    expect(info.authToken).toBeNull();
    expect(info.version).toBe(packageVersion);

    const health = await fetch(`http://127.0.0.1:${info.port}/health`);
    expect(health.ok).toBe(true);

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

  it("cleans canonical state and exits zero on SIGTERM", async () => {
    const owner = spawnCli(["--headless", "--json"]);
    const info = await waitForDaemonInfo();
    expect(info.pid).toBe(owner.pid);

    owner.kill("SIGTERM");

    const result = await waitForExit(owner);
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(existsSync(daemonInfoPath())).toBe(false);
  }, 15_000);
});
