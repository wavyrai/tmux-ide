import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreview } from "./preview-processes.mjs";

const command = (source) => ({ command: process.execPath, args: ["-e", source] });
const live = "setInterval(() => {}, 1000);";
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), "gpui-owner-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const register = (path) =>
  `require('fs').writeFileSync(${JSON.stringify(path)}, String(process.pid));`;
async function gone(path) {
  const pid = Number(await readFile(path, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test(
  "closing viewer reaps an idle helper without waiting for another frame",
  { timeout: 5000 },
  () =>
    fixture(async (dir) => {
      const path = join(dir, "helper");
      const result = await runPreview({
        helper: command(register(path) + "process.stdout.write('ready');" + live),
        native: command("process.stdin.once('data', () => process.exit(0));" + live),
      });
      assert.equal(result, 0);
      await gone(path);
    }),
);

test(
  "cancellation reaps both children, including a helper ignoring SIGTERM",
  { timeout: 5000 },
  () =>
    fixture(async (dir) => {
      const helper = join(dir, "helper");
      const viewer = join(dir, "viewer");
      const controller = new AbortController();
      const run = runPreview({
        helper: command(register(helper) + "process.on('SIGTERM', () => {});" + live),
        native: command(register(viewer) + live),
        signal: controller.signal,
        graceMs: 100,
      });
      // Wait for both children to initialize, not an assumed startup delay.
      const deadline = Date.now() + 2000;
      try {
        while (true) {
          try {
            await Promise.all([readFile(helper), readFile(viewer)]);
            break;
          } catch {
            assert.ok(Date.now() < deadline, "children did not initialize");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      } finally {
        controller.abort();
      }
      assert.equal(await run, 1);
      await gone(helper);
      await gone(viewer);
    }),
);

test(
  "helper EOF reaches viewer and helper failure remains a failure",
  { timeout: 5000 },
  async () => {
    assert.equal(
      await runPreview({
        helper: command("process.stdout.write('frame'); process.exitCode = 7;"),
        native: command(
          "process.stdin.resume(); process.stdin.once('end', () => process.exit(0));",
        ),
      }),
      7,
    );
  },
);

test("missing executable reaps the other owned child", { timeout: 5000 }, async () => {
  assert.equal(
    await runPreview({
      helper: command(live),
      native: { command: "/nonexistent/tmux-gpui-test-executable", args: [] },
    }),
    1,
  );
});

test("already cancelled launch starts no processes", async () => {
  assert.equal(
    await runPreview({
      helper: command("process.exit(99)"),
      native: command("process.exit(99)"),
      signal: AbortSignal.abort(),
    }),
    1,
  );
});

test(
  "duplex bridge carries native commands and helper publications",
  { timeout: 5000 },
  async () => {
    assert.equal(
      await runPreview({
        duplex: true,
        helper: command(
          "process.stdin.once('data', b => { if (b.toString() !== 'choose\\n') process.exit(9); process.stdout.write('frame\\n'); });" +
            live,
        ),
        native: command(
          "process.stdout.write('choose\\n'); process.stdin.once('data', b => process.exit(b.toString() === 'frame\\n' ? 0 : 8));" +
            live,
        ),
      }),
      0,
    );
  },
);
