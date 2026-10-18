import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import { stopFixtureChild } from "./fixture-child.mjs";

test("every unavailable discovery publication already includes safe recovery guidance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gpui-discovery-publication-"));
  let child;
  const failures = [];
  try {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX") &&
          ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "HOME",
            "TMPDIR",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
          ].includes(key),
      ),
    );
    child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("apps/tmux-gpui/bridge/browser.ts"),
        "--local",
      ],
      {
        cwd: directory,
        env: {
          ...environment,
          HOME: directory,
          TMPDIR: directory,
          XDG_CONFIG_HOME: directory,
          XDG_STATE_HOME: directory,
          XDG_CACHE_HOME: directory,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await new Promise((done, reject) => {
      let buffer = "",
        bytes = 0;
      const timer = setTimeout(() => reject(new Error("Discovery publication deadline")), 15000);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.once("close", () => fail(new Error("Browser closed before discovery failure")));
      child.stderr.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) fail(new Error("Bounded discovery diagnostics exceeded"));
      });
      child.stdout.on("data", (chunk) => {
        try {
          buffer += chunk.toString();
          assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024);
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const publication = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (publication.home.phase !== "unavailable") continue;
            assert.match(publication.status, /Local sessions are not connected/);
            assert.doesNotMatch(publication.status, /--headless/);
            assert.equal(publication.snapshot, null);
            assert.equal(publication.inputReady, false);
            clearTimeout(timer);
            done();
          }
        } catch (error) {
          fail(error);
        }
      });
    });
  } catch (error) {
    failures.push(error);
  } finally {
    for (const cleanup of [
      () => stopFixtureChild(child),
      () => rm(directory, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Discovery publication regression");
});
