import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cliBundlePlugins } from "./cli-bundle-policy.mjs";

/** Real systemd ownership with current CLI code and deliberately older version metadata. */
export async function qualifyLegacySystemd({
  repo,
  cliPath,
  state,
  env,
  run,
  panePid,
  before,
  receipt,
}) {
  const target = `tmux-ide-legacy.${createHash("sha256").update(state).digest("hex").slice(0, 24)}.service`;
  const output = (receipt.legacySystemd = {
    target,
    scope:
      "Real unregistered systemd service; current CLI code with older version metadata, not a historical published binary",
    passed: false,
  });
  const manager = (...args) => run("systemctl", ["--user", ...args]);
  const absent = () => {
    const result = manager("show", target, "--property=LoadState,MainPID");
    return (
      [0, 4].includes(result.status) &&
      /^LoadState=not-found$/mu.test(result.stdout) &&
      /^MainPID=0$/mu.test(result.stdout)
    );
  };
  const recordPath = join(state, "daemon.json");
  const oldCli = join(dirname(cliPath), "legacy-fixture.mjs");
  let attempted = false;
  let owner;
  try {
    assert(absent(), "Unique legacy service must be absent before allocation");
    assert(!existsSync(recordPath), "Legacy fixture requires an empty private namespace");
    const packagePath = join(repo, "package.json");
    await build({
      entryPoints: [join(repo, "bin/cli.ts")],
      outfile: oldCli,
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      logLevel: "warning",
      plugins: [
        {
          name: "fixture-older-version",
          setup(builder) {
            builder.onLoad({ filter: /package\.json$/ }, ({ path }) =>
              path === packagePath
                ? {
                    contents: JSON.stringify({
                      ...JSON.parse(readFileSync(path, "utf8")),
                      version: "2.9.0-beta.9",
                    }),
                    loader: "json",
                  }
                : undefined,
            );
          },
        },
        ...cliBundlePlugins(),
      ],
    });
    output.fixtureCliSha256 = createHash("sha256").update(readFileSync(oldCli)).digest("hex");
    assert.equal(
      run(process.execPath, [oldCli, "--version"]).stdout.trim(),
      "tmux-ide v2.9.0-beta.9",
    );
    const namespace = Object.entries(env).filter(
      ([key]) =>
        key === "HOME" ||
        key === "PATH" ||
        key.startsWith("TMUX_IDE_") ||
        key === "XDG_CONFIG_HOME",
    );
    attempted = true;
    const start = run("systemd-run", [
      "--user",
      `--unit=${target}`,
      "--property=Type=exec",
      "--property=Restart=always",
      "--property=RestartSec=1",
      "--property=KillMode=process",
      ...namespace.map(([key, value]) => `--setenv=${key}=${value}`),
      process.execPath,
      oldCli,
      "--headless",
      "--json",
    ]);
    assert.equal(start.status, 0, "Legacy systemd start must succeed");
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        owner = JSON.parse(readFileSync(recordPath, "utf8"));
      } catch {
        /* not published yet */
      }
      if (owner?.productVersion === "2.9.0-beta.9") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(owner?.productVersion, "2.9.0-beta.9");
    assert.equal(owner.provenance?.supervisor, "systemd");
    assert.equal(owner.supervisionId, undefined);
    assert.equal(existsSync(join(state, "service.json")), false);
    assert.equal(
      manager("show", target, "--property=MainPID", "--value").stdout.trim(),
      String(owner.pid),
    );
    output.pid = owner.pid;
    output.instanceId = owner.instanceId;
    const originalRecord = readFileSync(recordPath, "utf8");
    for (let attempt = 0; attempt < 2; attempt++) {
      const update = run(process.execPath, [
        cliPath,
        "update",
        "--daemon",
        "--if-running",
        "--json",
      ]);
      assert.equal(update.error, undefined, "Upgrade refusal must finish within its deadline");
      assert.notEqual(update.status, 0);
      const text = update.stdout + update.stderr;
      assert(text.includes("supervisor reservation"));
      assert(!owner.authToken || !text.includes(owner.authToken));
      assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
      assert.equal(
        manager("show", target, "--property=MainPID", "--value").stdout.trim(),
        String(owner.pid),
      );
      assert.equal(panePid(), before);
    }
    output.repeatedUpgradeRefused = true;
    output.ownerAndRecordPreserved = true;
    output.panePreserved = true;
  } finally {
    if (attempted) {
      const stopped = manager("stop", target);
      output.stopSucceeded = stopped.status === 0;
      // A failed transient unit can remain registered after stopping.
      manager("reset-failed", target);
    }
    const cleanupDeadline = Date.now() + 5000;
    while (!absent() && Date.now() < cleanupDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    output.managerAbsent = absent();
    output.ownerAbsent =
      !owner ||
      (() => {
        try {
          process.kill(owner.pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH";
        }
      })();
    output.recordAbsent = !existsSync(recordPath);
    assert(
      output.managerAbsent && output.ownerAbsent && output.recordAbsent,
      "Legacy service cleanup must retire its exact owner and record",
    );
  }
  output.passed =
    output.repeatedUpgradeRefused && output.ownerAndRecordPreserved && output.panePreserved;
}
