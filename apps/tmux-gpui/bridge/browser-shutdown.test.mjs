import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { stopFixtureChild } from "./fixture-child.mjs";

const { AbortController, AbortSignal } = globalThis;

for (const trigger of ["SIGTERM", "SIGINT", "stdin-eof", "oversized-input"]) {
  test(`browser shutdown: ${trigger}`, { timeout: 15000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "gpui-stop-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX_IDE_") &&
          !["TMUX", "TMUX_PANE", "NODE_OPTIONS", "NODE_PATH"].includes(key),
      ),
    );
    Object.assign(env, {
      HOME: home,
      TMUX_IDE_HOME: home,
      TMUX_IDE_DAEMON_INFO_DIR: home,
      TMUX_IDE_REGISTRY_DIR: home,
    });
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(new URL("./browser.ts", import.meta.url)),
        "--local",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    const cleanup = new AbortController();
    const signal = AbortSignal.any([cleanup.signal, AbortSignal.timeout(5000)]);
    const closed = once(child, "close", { signal });
    // Observe a spawn/exit failure immediately, including while awaiting startup.
    void closed.catch(() => {});
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    try {
      // A publication establishes that the actual helper has installed its signal
      // handlers and entered startup. Keep draining so shutdown isn't backpressured.
      await Promise.race([
        once(child.stdout, "data", { signal }),
        closed.then(() => {
          throw new Error("Browser exited before startup publication");
        }),
      ]);
      child.stdout.resume();
      if (trigger === "oversized-input") child.stdin.write("x".repeat(1024 * 1024));
      else if (trigger === "stdin-eof") child.stdin.end();
      else child.kill(trigger);
      const [code, exitSignal] = await closed;
      assert.equal(exitSignal, null);
      if (trigger === "oversized-input") {
        assert.equal(code, 1);
        assert.match(stderr, /Native browser connection failed/);
      } else {
        assert.equal(code, 0, stderr);
        assert.doesNotMatch(stderr, /Native browser connection failed/);
      }
    } finally {
      cleanup.abort();
      try {
        await stopFixtureChild(child);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  });
}
