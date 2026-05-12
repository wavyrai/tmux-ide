/**
 * NodePtyAdapter integration test (T087).
 *
 * Spawns a real PTY against `/bin/echo` under a tmpdir to validate the
 * end-to-end wiring without touching the rest of the daemon. Skipped on
 * Windows (no /bin/echo, and node-pty's win32 shape differs).
 *
 * Also covers the `ensureNodePtySpawnHelperExecutable` helper that t3
 * borrows the chmod-on-helper trick from — we can chmod a fake helper at
 * an explicit path and assert no throw.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePtyAdapter, ensureNodePtySpawnHelperExecutable } from "../NodePtyAdapter.ts";
import { PtySpawnError } from "../PtyAdapter.ts";

const skipOnWin = process.platform === "win32";

describe.skipIf(skipOnWin)("NodePtyAdapter", () => {
  let workDir: string;

  beforeAll(() => {
    ensureNodePtySpawnHelperExecutable();
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "node-pty-adapter-"));
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("spawn() returns a process that emits data and exit", async () => {
    const adapter = new NodePtyAdapter({ skipHelperEnsure: true });
    const proc = await adapter.spawn({
      shell: "/bin/echo",
      args: ["NodePtyAdapter-ok"],
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: { ...process.env },
    });
    const data: Buffer[] = [];
    const exitEvents: Array<{ exitCode: number; signal: number | null }> = [];
    proc.onData((b) => data.push(b));
    proc.onExit((e) => exitEvents.push(e));
    await new Promise<void>((resolve) => {
      const watchdog = setTimeout(() => resolve(), 2000);
      proc.onExit(() => {
        clearTimeout(watchdog);
        resolve();
      });
    });
    const combined = Buffer.concat(data).toString("utf8");
    expect(combined).toContain("NodePtyAdapter-ok");
    expect(exitEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("spawnSync() returns a usable process immediately", () => {
    const adapter = new NodePtyAdapter({ skipHelperEnsure: true });
    const proc = adapter.spawnSync({
      shell: "/bin/echo",
      args: ["sync-ok"],
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: { ...process.env },
    });
    expect(proc.pid).toBeGreaterThan(0);
    proc.kill();
  });

  it("spawn() throws PtySpawnError(cwd_invalid) for a missing cwd", async () => {
    const adapter = new NodePtyAdapter({ skipHelperEnsure: true });
    await expect(
      adapter.spawn({
        shell: "/bin/echo",
        cwd: join(workDir, "does-not-exist"),
        cols: 80,
        rows: 24,
        env: { ...process.env },
      }),
    ).rejects.toMatchObject({
      name: "PtySpawnError",
      adapter: "node-pty",
      code: "cwd_invalid",
    });
  });

  it("spawnSync() throws PtySpawnError(cwd_invalid) for a file passed as cwd", () => {
    const adapter = new NodePtyAdapter({ skipHelperEnsure: true });
    const filePath = join(workDir, "not-a-dir");
    writeFileSync(filePath, "x");
    try {
      adapter.spawnSync({
        shell: "/bin/echo",
        cwd: filePath,
        cols: 80,
        rows: 24,
        env: { ...process.env },
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PtySpawnError);
      expect((err as PtySpawnError).code).toBe("cwd_invalid");
    }
  });

  it("spawn() throws PtySpawnError(unknown) for non-integer cols", async () => {
    const adapter = new NodePtyAdapter({ skipHelperEnsure: true });
    await expect(
      adapter.spawn({
        shell: "/bin/echo",
        cwd: workDir,
        cols: 0,
        rows: 24,
        env: { ...process.env },
      }),
    ).rejects.toMatchObject({ code: "unknown" });
  });

  it("ensureNodePtySpawnHelperExecutable chmods a supplied helper to 0755", () => {
    const helper = join(workDir, "spawn-helper");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n");
    chmodSync(helper, 0o600); // start non-executable
    ensureNodePtySpawnHelperExecutable({ explicitPath: helper });
    const mode = statSync(helper).mode & 0o777;
    expect(mode & 0o100).toBe(0o100); // owner-exec bit set
  });

  it("ensureNodePtySpawnHelperExecutable is a no-op for a missing path", () => {
    expect(() =>
      ensureNodePtySpawnHelperExecutable({ explicitPath: join(workDir, "absent") }),
    ).not.toThrow();
    expect(existsSync(join(workDir, "absent"))).toBe(false);
  });
});
