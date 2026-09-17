import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boundedTmuxRead } from "../bounded-tmux-read.ts";
import { createPinnedWorkspaceTmuxAsyncRunner } from "../workspace-pane-creation.ts";
it("executes the pinned binary with its explicit private selector, not ambient tmux", async () => {
  const root = mkdtempSync(join(tmpdir(), "pinned-fleet-read-"));
  const executablePath = join(root, "fake-tmux");
  writeFileSync(
    executablePath,
    `#!${process.execPath}\nif (process.argv.includes('display-message')) process.exit(1); console.log(JSON.stringify(process.argv.slice(2)));`,
    { mode: 0o755 },
  );
  try {
    const runner = createPinnedWorkspaceTmuxAsyncRunner({
      executablePath,
      socketSelector: { kind: "name", name: "isolated-fleet-fixture" },
    });
    expect(JSON.parse(await runner(["list-panes", "-a"]))).toEqual([
      "-L",
      "isolated-fleet-fixture",
      "-u",
      "list-panes",
      "-a",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("kills an isolated child that ignores TERM before settling cancellation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-fleet-read-"));
  const marker = join(root, "ready");
  const script = join(root, "child.cjs");
  writeFileSync(
    script,
    `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`,
  );
  const controller = new AbortController();
  const read = boundedTmuxRead(process.execPath, [script, marker], {
    env: process.env,
    signal: controller.signal,
    timeoutMs: 2000,
  });
  // Attach rejection handling before deliberately cancelling.
  const result = read.then(
    () => false,
    () => true,
  );
  try {
    const until = Date.now() + 1500;
    while (!existsSync(marker) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    controller.abort();
    expect(await result).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await result;
    rmSync(root, { recursive: true, force: true });
  }
});
it("bounds subprocess deadlines without caller cancellation", async () => {
  const started = Date.now();
  await expect(
    boundedTmuxRead(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: process.env,
      timeoutMs: 20,
    }),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(1500);
});
