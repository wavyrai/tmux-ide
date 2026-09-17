import { spawn } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  lstatSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { settlePackedChildren } from "./packed-install-cleanup.mjs";
import {
  capturePackedInstallEnvironment,
  privatePackedInstallEnvironment,
} from "./packed-install-environment.mjs";

export function developmentCiIdentity(env, lane) {
  const values = [
    env.GITHUB_RUN_ID,
    env.GITHUB_RUN_ATTEMPT,
    env.GITHUB_JOB,
    lane,
    process.platform,
    process.arch,
    process.versions.node.split(".")[0],
  ];
  if (values.some((v) => typeof v !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(v)))
    throw new Error("CI identity requires run, attempt, job and lane");
  return values.join("-");
}
export function developmentCiScope(paths) {
  return paths.some((p) =>
    /^(bin\/|packages\/|scripts\/|docker\/|native\/|\.github\/|package\.json$|pnpm-|\.bun-version$)/.test(
      p,
    ),
  );
}
export function developmentCiPlan(source, lane) {
  const node = process.execPath;
  const vitest = join(source, "node_modules/vitest/vitest.mjs");
  const daemon = join(source, "packages/daemon");
  if (lane === "fast") {
    const helperNames = [
      "development-manager-cache",
      "development-container-packed-lock",
      "development-isolation-resources",
      "development-container-prepare",
      "development-container-context",
      "packed-install-environment",
      "packed-install-cleanup",
      "packed-cancellation",
      "packed-interruption-qualification",
      "release-source-state",
      "packed-install-scenarios",
      "owned-systemd-fixture",
      "owned-launchd-fixture",
      "owned-ssh-fixture",
      "owned-ssh-pressure",
      "development-ci",
    ];
    const tests = readdirSync(join(daemon, "src/__tests__"))
      .filter((f) => /^development-.*\.test\.ts$/.test(f))
      .sort();
    if (tests.length < 15) throw new Error("Development test inventory incomplete");
    return [
      {
        name: "helpers",
        executable: node,
        args: [
          "--test",
          "--test-concurrency=1",
          ...helperNames.map((n) => `scripts/lib/${n}.test.mjs`),
        ],
        cwd: source,
        timeoutMs: 180000,
      },
      {
        name: "development",
        executable: node,
        args: [vitest, "run", "--maxWorkers=1", ...tests.map((f) => `src/__tests__/${f}`)],
        cwd: daemon,
        timeoutMs: 300000,
      },
    ];
  }
  if (lane === "installed")
    return [
      {
        name: "ssh-contracts",
        executable: node,
        args: [
          vitest,
          "run",
          "--maxWorkers=1",
          "src/lib/ssh-daemon-transport.test.ts",
          "src/lib/ssh-daemon-relay.test.ts",
        ],
        cwd: daemon,
        timeoutMs: 180000,
      },
      {
        name: "installed-package",
        executable: node,
        args: ["scripts/pack-check-run.mjs"],
        cwd: source,
        timeoutMs: 900000,
        cancelGraceMs: 210000,
      },
    ];
  throw new Error("Unknown development CI lane");
}

/** Owns retained direct children only. Each qualification owns its own descendants/resources. */
export async function runDevelopmentCi({
  root,
  commands,
  signal,
  env = process.env,
  graceMs = 45000,
}) {
  root = resolve(root);
  mkdirSync(root, { mode: 0o700 }); // Fresh only; never adopt an existing run.
  const work = realpathSync(mkdtempSync("/tmp/ti13-"));
  const witness = lstatSync(work);
  for (const name of ["home", "cache", "tmp", "state"])
    mkdirSync(join(work, name), { mode: 0o700 });
  const childEnv = privatePackedInstallEnvironment(capturePackedInstallEnvironment(env), {
    home: join(work, "home"),
    cache: join(work, "cache"),
    overrides: {
      TMPDIR: join(work, "tmp"),
      TMP: join(work, "tmp"),
      TEMP: join(work, "tmp"),
      TMUX_IDE_DEVELOPMENT_STORE: join(work, "state"),
      TMUX_IDE_PACK_EVIDENCE_DIR: join(root, "package"),
      GOMAXPROCS: "2",
      npm_config_child_concurrency: "1",
    },
  });
  const children = [],
    exits = new Map();
  const receipt = {
    version: 1,
    status: "running",
    checks: [],
    workRoot: work,
    cleanup: { confirmed: false, scope: "retained-direct-children-and-private-work" },
    startedAt: new Date().toISOString(),
  };
  const save = () =>
    writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
  save();
  try {
    for (const command of commands) {
      if (signal?.aborted) throw new Error("cancelled");
      const entry = {
        name: command.name,
        status: "running",
        pid: null,
        logBytes: 0,
        logTruncated: false,
      };
      receipt.checks.push(entry);
      save();
      let log = Buffer.alloc(0),
        total = 0,
        timedOut = false;
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      entry.pid = child.pid ?? null;
      const closed = new Promise((r) => {
        child.once("error", () => {});
        child.once("close", (code, sig) => r({ code, signal: sig }));
      });
      exits.set(child, closed);
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (bytes) => {
          total += bytes.length;
          log = Buffer.concat([log, bytes]).subarray(-1048576);
        });
      let cancel;
      const stopped = new Promise((r) => {
        cancel = () => r(null);
        signal?.addEventListener("abort", cancel, { once: true });
      });
      const timer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, command.timeoutMs);
      let result;
      try {
        result = await Promise.race([closed, stopped]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
      if (!result) {
        const cleanup = await settlePackedChildren([child], exits, {
          graceMs: command.cancelGraceMs ?? graceMs,
          killMs: 2000,
        });
        if (!cleanup.confirmed) throw new Error("child-cleanup-unconfirmed");
        result = await closed;
      }
      entry.status = signal?.aborted
        ? "cancelled"
        : timedOut
          ? "timeout"
          : result.code === 0
            ? "passed"
            : "failed";
      entry.exitCode = result.code;
      entry.signal = result.signal;
      entry.logBytes = total;
      entry.logTruncated = total > log.length;
      writeFileSync(join(root, `${command.name}.log`), log, { mode: 0o600 });
      save();
      if (entry.status !== "passed") throw new Error(entry.status);
    }
    receipt.status = "passed";
  } catch {
    receipt.status = signal?.aborted ? "cancelled" : "failed";
  } finally {
    const cleanup = await settlePackedChildren(children, exits, { graceMs, killMs: 2000 });
    receipt.cleanup.children = cleanup;
    // A killed test runner may not have run its own teardown. Preserve work/evidence;
    // never mistake a reaped test runner for proof that arbitrary descendants died.
    if (cleanup.confirmed && receipt.status === "passed") {
      const current = lstatSync(work);
      if (
        current.dev === witness.dev &&
        current.ino === witness.ino &&
        current.uid === witness.uid &&
        !current.isSymbolicLink()
      ) {
        rmSync(work, { recursive: true });
        receipt.cleanup.confirmed = true;
      }
    }
    if (!receipt.cleanup.confirmed && receipt.status === "passed") receipt.status = "failed";
    receipt.finishedAt = new Date().toISOString();
    save();
  }
  return receipt;
}

export function finalizeDevelopmentCi(root) {
  try {
    return JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
  } catch {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const receipt = {
      version: 1,
      status: "not-run-or-interrupted",
      cleanup: { confirmed: false },
      note: "No cleanup proof; hosted runner retirement is not a fixture cleanup pass.",
    };
    writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
    return receipt;
  }
}
