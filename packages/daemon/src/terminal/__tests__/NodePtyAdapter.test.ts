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
 *
 * Runner: vitest only. This file is registered in
 * `packages/daemon/vitest.config.ts`. When `bun test` discovers it via
 * the wider `bun test src/` invocation we skip the suite — node-pty's
 * `onData` callback does not fire under bun (T085/T087 finding sealed
 * by the PtyAdapter abstraction; same reason daemon-watchdog spawns
 * tsx-via-node instead of bun in `src/lib/tmux.ts`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePtyAdapter, ensureNodePtySpawnHelperExecutable } from "../NodePtyAdapter.ts";
import { PtySpawnError } from "../PtyAdapter.ts";

const skipOnWin = process.platform === "win32";
// node-pty's `onData` callback never fires under bun's runtime. This
// suite is a vitest-only integration test; under `bun test` we skip
// the entire describe block. See file header.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

describe.skipIf(skipOnWin || isBun)("NodePtyAdapter", () => {
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
      shell: "/bin/sh",
      args: ["-lc", "printf NodePtyAdapter-ok; sleep 0.1"],
      cwd: workDir,
      cols: 80,
      rows: 24,
      env: { ...process.env },
    });
    const data: Buffer[] = [];
    const exitEvents: Array<{ exitCode: number; signal: number | null }> = [];
    let maybeDone: (() => void) | null = null;
    let dataSeen = false;
    proc.onData((b) => {
      data.push(b);
      if (Buffer.concat(data).toString("utf8").includes("NodePtyAdapter-ok")) {
        dataSeen = true;
        maybeDone?.();
      }
    });
    proc.onExit((e) => {
      exitEvents.push(e);
      maybeDone?.();
    });
    await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for PTY data and exit; dataSeen=${dataSeen} exitEvents=${exitEvents.length}`,
          ),
        );
      }, 10_000);
      maybeDone = () => {
        if (dataSeen && exitEvents.length > 0) {
          clearTimeout(watchdog);
          resolve();
        }
      };
    });
    maybeDone = null;
    const combined = Buffer.concat(data).toString("utf8");
    expect(combined).toContain("NodePtyAdapter-ok");
    expect(exitEvents.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

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
