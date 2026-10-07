import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareOwnedReferenceArtifact,
  validateOwnedWorktree,
  ownedReferenceEnvironment,
  withOwnedReferenceCapture,
} from "./owned-reference-capture.mjs";
import { referenceTarget } from "./performance-reference-target.mjs";
test("primary/dirty worktrees refuse, complete private environment cannot inherit tmux hooks", () => {
  assert.throws(() => validateOwnedWorktree({ common: "/same", local: "/same", dirty: false }));
  assert.throws(() => validateOwnedWorktree({ common: "/common", local: "/linked", dirty: true }));
  validateOwnedWorktree({ common: "/common", local: "/linked", dirty: false });
  const fleet = {
    root: "/private",
    socketPath: "/tmp/private-s",
    daemonInfoDir: "/private/d",
    environment: {
      HOME: "/private/home",
      TMUX_IDE_HOME: "/private/state",
      TMUX: "/tmp/private-s,123,0",
    },
  };
  const env = ownedReferenceEnvironment(
    { TMUX: "old", TMUX_IDE_CONFIG: "old", NODE_OPTIONS: "bad" },
    fleet,
    "/trace",
    "/tui",
  );
  assert.equal(env.TMUX_IDE_CONFIG, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, "/private/home");
  assert.equal(env.TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR, env.TMUX_IDE_TESTDRIVE_CANONICAL_HOME);
  assert.equal(referenceTarget("/repo", env).isolated, true);
});
test("owned lifecycle builds TUI before daemon, preserves final traces, and cleans failures", async () => {
  const parent = await mkdtemp(join(tmpdir(), "owned-reference-"));
  try {
    for (const mode of [
      "success",
      "run-error",
      "incomplete",
      "stop-error",
      "retire-error",
      "copy-error",
      "receipt-error",
      "inspect-error",
      "output-error",
      "large-output",
    ]) {
      const root = join(parent, mode),
        output = join(root, "out"),
        fleetRoot = join(root, "fleet"),
        tui = join(root, "tui");
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(join(root, "bin/cli.js"), "cli");
      const rendererManifest = join(root, "renderer.json");
      await writeFile(rendererManifest, "{}");
      const order = [];
      const original = process.env.TMUX_IDE_HOSTILE;
      const originalCommit = process.env.TMUX_IDE_RELEASE_COMMIT;
      process.env.TMUX_IDE_RELEASE_COMMIT = "false-source";
      process.env.TMUX_IDE_HOSTILE = "forbidden";
      const reportPath = join(root, "report.json");
      const operation = withOwnedReferenceCapture({
        root,
        rendererManifest,
        output,
        source: { commit: "c", tree: "t", dirty: false },
        prepare: async () => {
          order.push("build-tui");
          assert.equal(process.env.TMUX_IDE_HOSTILE, undefined);
          assert.equal(process.env.TMUX_IDE_RELEASE_COMMIT, undefined);
          await writeFile(tui, "binary");
          return tui;
        },
        createFleet: async () => {
          order.push("fleet");
          await mkdir(join(fleetRoot, "reference-tui"), { recursive: true });
          return {
            root: fleetRoot,
            socketPath: join(fleetRoot, "sock"),
            daemonInfoDir: join(fleetRoot, "daemon"),
            environment: {
              HOME: join(fleetRoot, "home"),
              TMUX: `${join(fleetRoot, "sock")},123,0`,
            },
          };
        },
        inspectNative: () => {
          if (mode === "inspect-error") throw Error("PID probe failed");
          return 123;
        },
        startDaemon: async () => {
          order.push("daemon");
          assert.equal(process.env.TMUX_IDE_HOSTILE, undefined);
          return {
            record: { pid: 456, instanceId: "g" },
            output: () =>
              (mode === "large-output" ? "x".repeat(3 * 1024 * 1024) : "") +
              (order.includes("stop") ? "final daemon failure" : "before daemon stop"),
            stop: async () => {
              order.push("stop");
              if (mode === "stop-error" || mode === "output-error") throw Error("stop failed");
            },
          };
        },
        run: async () => {
          await writeFile(join(fleetRoot, "reference-tui/input-trace.jsonl"), "trace\n");
          await writeFile(
            join(fleetRoot, "reference-tui/input-trace.jsonl.controller-attempts.json"),
            "{}\n",
          );
          await writeFile(
            reportPath,
            JSON.stringify({
              measurements: {
                inputToPaint: {
                  sourceArtifact: { path: "old" },
                  controllerMapping: { status: "matched", path: "old" },
                },
              },
            }),
          );
          if (mode === "output-error") await mkdir(join(output, "daemon-output.log"));
          if (mode === "copy-error") await mkdir(join(output, "input-trace.jsonl"));
          if (mode === "receipt-error") {
            await mkdir(join(output, "owner-result.json"));
            throw Error("original run failure");
          }
          if (mode === "run-error") throw Error("run failed");
          return {
            reportPath,
            inputAdmission: { complete: mode !== "incomplete" },
            controllerMapping: { status: "matched" },
          };
        },
        retire: async (_fleet, _pid, { retainRoot }) => {
          order.push("retire");
          if (mode === "retire-error") throw Error("retire failed");
          assert.equal(retainRoot, mode === "copy-error" || mode === "inspect-error");
          if (!retainRoot) await rm(fleetRoot, { recursive: true, force: true });
        },
      });
      if (mode === "success" || mode === "large-output") await operation;
      else
        await assert.rejects(operation, (error) => {
          if (mode === "receipt-error") {
            assert.equal(error.errors[0].message, "original run failure");
            assert.equal(error.errors.length, 2);
          }
          if (mode === "output-error") {
            assert.equal(error.errors[0].message, "stop failed");
            assert.equal(error.errors.length, 2);
          }
          return true;
        });
      assert.deepEqual(
        order,
        mode === "inspect-error"
          ? ["build-tui", "fleet", "retire"]
          : ["build-tui", "fleet", "daemon", "stop", "retire"],
      );
      assert.equal(process.env.TMUX_IDE_HOSTILE, "forbidden");
      assert.equal(process.env.TMUX_IDE_RELEASE_COMMIT, "false-source");
      if (originalCommit === undefined) delete process.env.TMUX_IDE_RELEASE_COMMIT;
      else process.env.TMUX_IDE_RELEASE_COMMIT = originalCommit;
      if (original === undefined) delete process.env.TMUX_IDE_HOSTILE;
      else process.env.TMUX_IDE_HOSTILE = original;
      if (mode === "receipt-error") continue;
      if (mode === "inspect-error") {
        const receipt = JSON.parse(await readFile(join(output, "owner-result.json"), "utf8"));
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.retainedSourceRoot, fleetRoot);
        continue;
      }
      assert.equal(
        await readFile(
          join(
            mode === "copy-error" ? join(fleetRoot, "reference-tui") : output,
            "input-trace.jsonl",
          ),
          "utf8",
        ),
        "trace\n",
      );
      const receipt = JSON.parse(await readFile(join(output, "owner-result.json"), "utf8"));
      assert.equal(
        receipt.status,
        mode === "success" || mode === "large-output" ? "captured" : "failed",
      );
      assert.equal(receipt.daemonOutput.length, 2);
      if (mode !== "output-error") {
        const bytes = await readFile(join(output, "daemon-output.log"));
        assert.ok(bytes.toString().endsWith("final daemon failure"));
        assert.ok(bytes.length <= 2 * 1024 * 1024);
        assert.equal(receipt.daemonOutput[1].truncated, mode === "large-output");
      }
      if (mode === "success")
        assert.equal(
          JSON.parse(await readFile(reportPath, "utf8")).measurements.inputToPaint.sourceArtifact
            .path,
          join(output, "input-trace.jsonl"),
        );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("build command uses actual build-tui default output in the selected worktree", () => {
  const calls = [];
  assert.equal(
    prepareOwnedReferenceArtifact("/linked", "/renderer.json", (...args) => calls.push(args)),
    "/linked/packages/daemon/dist/tui/tmux-ide-tui",
  );
  assert.deepEqual(calls, [
    [
      "pnpm",
      ["build:tui", "--release-scroll-manifest", "/renderer.json"],
      { cwd: "/linked", stdio: "pipe", timeout: 120000 },
    ],
  ]);
});

test("bare tmux subprocess inherits only validated private locator; empty/mismatched locators refuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-routing-"));
  try {
    const executable = join(root, "tmux");
    await writeFile(executable, '#!/bin/sh\nprintf "%s" "$TMUX"\n');
    await chmod(executable, 0o700);
    const socketPath = join(root, "t.sock");
    const fleet = {
      root,
      socketPath,
      daemonInfoDir: join(root, "daemon"),
      environment: { TMUX: `${socketPath},123,0` },
    };
    const environment = ownedReferenceEnvironment(
      { ...process.env, TMUX: "/tmp/default,1,0" },
      fleet,
      join(root, "trace"),
      "/tui",
    );
    environment.PATH = root;
    assert.equal(
      execFileSync("tmux", ["list-sessions"], { env: environment, encoding: "utf8" }),
      fleet.environment.TMUX,
    );
    for (const invalid of [
      undefined,
      "",
      "/tmp/other.sock,123,0",
      `${socketPath},0,0`,
      `${socketPath},123`,
    ])
      assert.throws(
        () =>
          ownedReferenceEnvironment(
            {},
            { ...fleet, environment: { TMUX: invalid } },
            "/trace",
            "/tui",
          ),
        /private fleet TMUX locator/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
