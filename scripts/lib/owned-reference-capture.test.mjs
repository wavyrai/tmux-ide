import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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
    socketPath: "/private/s",
    daemonInfoDir: "/private/d",
    environment: { HOME: "/private/home", TMUX_IDE_HOME: "/private/state" },
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
            environment: { HOME: join(fleetRoot, "home") },
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
            stop: async () => {
              order.push("stop");
              if (mode === "stop-error") throw Error("stop failed");
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
      if (mode === "success") await operation;
      else
        await assert.rejects(operation, (error) => {
          if (mode === "receipt-error") {
            assert.equal(error.errors[0].message, "original run failure");
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
      assert.equal(receipt.status, mode === "success" ? "captured" : "failed");
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
