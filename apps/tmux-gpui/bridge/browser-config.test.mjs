import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { stopFixtureChild } from "./fixture-child.mjs";

function isolatedEnvironment(directory) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX") &&
          ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
            "TMPDIR",
            "HOME",
          ].includes(key),
      ),
    ),
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: directory,
    XDG_CACHE_HOME: directory,
    TMPDIR: directory,
  };
}

// Observe startup failure directly; never include child output in failure diagnostics.
// This bounds process startup/import and first publication, not product latency.
function firstPublication(child, lines, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0,
      stderrBytes = 0;
    const finish = (error, line) => {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      if (error) reject(error);
      else resolve(line);
    };
    const onLine = (line) =>
      Buffer.byteLength(line) > 65536
        ? finish(new Error("Browser startup output exceeded 64 KiB"))
        : finish(null, line);
    const onError = () => finish(new Error("Browser startup spawn failed"));
    const onClose = (code, signal) =>
      finish(
        new Error(
          `Browser closed before publication (exit=${code}, signal=${signal}, stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes})`,
        ),
      );
    const count = (stream, chunk) => {
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > 65536)
        finish(new Error("Browser startup output exceeded 64 KiB"));
    };
    const onStdout = (chunk) => count("stdout", chunk);
    const onStderr = (chunk) => count("stderr", chunk);
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Browser startup publication deadline (stdoutBytes=${stdoutBytes}, stderrBytes=${stderrBytes}, exit=${child.exitCode})`,
          ),
        ),
      timeoutMs,
    );
    child.on("error", onError);
    child.on("close", onClose);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    lines.once("line", onLine);
  });
}

test("malformed private config stays recoverable without leaking its contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpui-browser-config-"));
  let child, closed, lines;
  let stderr = "";
  try {
    const path = join(directory, "host.json");
    await writeFile(path, '{"ownerToken":"PRIVATE_TEST_SENTINEL", broken', { mode: 0o600 });
    child = spawn(process.execPath, ["--import", "tsx", "apps/tmux-gpui/bridge/browser.ts", path], {
      stdio: ["pipe", "pipe", "pipe"],
      env: isolatedEnvironment(directory),
    });
    closed = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve([code, signal])),
    );
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) < 65536)
        stderr += chunk.toString().slice(0, 65536 - Buffer.byteLength(stderr));
    });
    lines = createInterface({ input: child.stdout });
    const line = await firstPublication(child, lines);
    const event = JSON.parse(line);
    assert.equal(child.exitCode, null);
    assert.equal(event.snapshot, null);
    assert.equal(event.inputReady, false);
    assert.match(event.status, /unavailable/);
    assert.ok(!line.includes("PRIVATE_TEST_SENTINEL"));
    child.stdin.end();
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Browser did not stop after EOF")), 5000);
        closed.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.deepEqual(result, [0, null]);
    assert.match(stderr, /Could not read private native-browser host configuration/);
    assert.ok(!stderr.includes("PRIVATE_TEST_SENTINEL"));
  } finally {
    lines?.close();
    await stopFixtureChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup failure is reported at child exit without exposing diagnostic contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpui-browser-startup-"));
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('PRIVATE_TEST_SENTINEL');process.exit(7)"],
    { stdio: ["ignore", "pipe", "pipe"], env: isolatedEnvironment(directory) },
  );
  const lines = createInterface({ input: child.stdout });
  try {
    await assert.rejects(firstPublication(child, lines), (error) => {
      assert.match(error.message, /closed before publication \(exit=7/);
      assert.ok(!error.message.includes("PRIVATE_TEST_SENTINEL"));
      return true;
    });
  } finally {
    lines.close();
    await stopFixtureChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});
