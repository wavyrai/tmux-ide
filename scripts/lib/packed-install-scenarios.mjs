import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { privatePackedInstallEnvironment } from "./packed-install-environment.mjs";
import { settlePackedChildren, waitForPackedSocketRemoval } from "./packed-install-cleanup.mjs";

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function verifyPackedLaneArtifact(installedRoot, primaryCli, version) {
  assert.equal(
    JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")).version,
    version,
  );
  const sha256 = hash(join(installedRoot, "bin", "cli.js"));
  assert.equal(
    sha256,
    hash(primaryCli),
    "Second installation must contain the exact same compiled CLI",
  );
  return { version, cliSha256: sha256 };
}
export function requirePackedFailure(result, { code, includes } = {}) {
  assert.equal(
    result.error,
    undefined,
    "A spawn timeout/error is not the expected installed failure",
  );
  assert.equal(result.signal, null, "A killed child is not the expected installed failure");
  assert.ok(
    Number.isInteger(result.status) && result.status !== 0,
    "Installed command must refuse",
  );
  if (code) assert.equal(JSON.parse(result.stderr.trim()).code, code);
  if (includes) assert.ok(`${result.stdout}\n${result.stderr}`.includes(includes));
  return { exitCode: result.status, ...(code ? { code } : {}) };
}
export function verifyPackedRecord(path, bytes, parentMode, recordMode) {
  assert.equal(
    hash(path),
    createHash("sha256").update(bytes).digest("hex"),
    "Refusal/reuse must preserve the exact record bytes",
  );
  assert.equal(statSync(dirname(path)).mode & 0o777, parentMode);
  assert.equal(statSync(path).mode & 0o777, recordMode);
}

export async function probePackedIdentity(selected, remainingMs, fetchImpl = fetch) {
  if (remainingMs <= 0) return false;
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${selected.port}/identity`, {
      signal: AbortSignal.timeout(Math.min(1000, remainingMs)),
    });
  } catch {
    return false;
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  const identity = await response.json();
  for (const key of ["pid", "instanceId", "startedAt", "productVersion", "protocolVersion"])
    assert.ok(
      identity[key] === selected[key],
      "Installed identity does not match the selected owner",
    );
  return true;
}

/** A second install of the same tarball; owns only children and the supplied private lane/socket. */
export async function runPackedInstallScenarios(options, receipt) {
  const {
    root,
    socket,
    tarball,
    primaryCli,
    version,
    runtimeBinary,
    platform,
    baseEnvironment,
    runtimeEnvironment,
    node = process.execPath,
  } = options;
  const home = join(root, "home"),
    project = join(root, "project"),
    state = join(home, ".tmux-ide");
  const env = privatePackedInstallEnvironment(baseEnvironment, {
    home,
    cache: join(root, "npm-cache"),
    overrides: {
      ...runtimeEnvironment,
      HOME: home,
      ZDOTDIR: home,
      TMUX_IDE_HOME: state,
      TMUX_IDE_TMUX_SOCKET_PATH: socket,
    },
  });
  // The caller's runtime overrides select the mock release channel, never another HOME/cache.
  env.USERPROFILE = home;
  const primaryBin = join(dirname(dirname(dirname(primaryCli))), ".bin");
  env.PATH = [
    join(project, "node_modules", ".bin"),
    ...env.PATH.split(":").filter((entry) => entry !== primaryBin),
  ].join(":");
  const children = [],
    exits = new Map();
  let failure = null;
  let serverPid = null,
    serverStarted = false;
  Object.assign(receipt, {
    install: { manager: "npm", scripts: "disabled", tarballSha256: hash(tarball) },
    scope: { cliAndHeadless: true, explicitRuntimeAcquisition: true, renderingQualified: false },
    cases: [],
    cleanupConfirmed: false,
    ownedPids: [],
  });
  const command = (file, args, override = {}, timeout = 15_000) =>
    spawnSync(file, args, {
      cwd: project,
      env: { ...env, ...override },
      encoding: "utf8",
      timeout,
      maxBuffer: 1024 * 1024,
    });
  const success = (result) => {
    assert.equal(result.error, undefined, "Installed scenario subprocess failed to complete");
    assert.equal(result.status, 0, "Installed scenario subprocess refused");
    return result;
  };
  const owned = (file, args) => {
    const child = spawn(file, args, { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) child.kill("SIGTERM");
      });
    const closed = new Promise((resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    void closed.catch(() => {});
    exits.set(child, closed);
    children.push(child);
    if (child.pid) receipt.ownedPids.push(child.pid);
    return child;
  };
  const wait = async (predicate, ms = 10_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Packed installed scenario deadline exceeded");
  };
  const dead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
  };
  const boundedClose = async (child) => {
    let timer;
    try {
      return await Promise.race([
        exits.get(child),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Packed installed child close deadline exceeded")),
            10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const caseRun = async (name, body) => {
    const entry = { name, installMode: "scripts-disabled", status: "failed" };
    receipt.cases.push(entry);
    const started = Date.now();
    try {
      Object.assign(entry, await body(), { status: "passed" });
    } finally {
      entry.elapsedMs = Date.now() - started;
    }
  };
  try {
    for (const path of [home, project]) mkdirSync(path, { recursive: true, mode: 0o700 });
    success(command("npm", ["init", "-y"]));
    success(
      command(
        "npm",
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
        {},
        180_000,
      ),
    );
    assert.equal(
      hash(tarball),
      receipt.install.tarballSha256,
      "Tarball changed during installation",
    );
    const installedRoot = join(project, "node_modules", "tmux-ide"),
      cli = join(installedRoot, "bin", "cli.js"),
      info = join(state, "daemon.json");
    receipt.artifact = verifyPackedLaneArtifact(installedRoot, primaryCli, version);
    await caseRun("scripts-disabled-version", async () => {
      assert.equal(
        success(command(node, [cli, "--version"]))
          .stdout.trim()
          .replace(/^tmux-ide v/u, ""),
        version,
      );
      assert.equal(existsSync(info), false);
      return { version, daemonStarted: false };
    });
    await caseRun("scripts-disabled-offline-first-app", async () => {
      const raw = command(node, [cli, "app"], { TMUX_IDE_PACK_FETCH_MODE: "offline" });
      const result = requirePackedFailure(raw, {
        includes: "Automatic OpenTUI runtime acquisition failed",
      });
      assert.ok(`${raw.stdout}\n${raw.stderr}`.includes("mock release channel offline"));
      assert.ok(`${raw.stdout}\n${raw.stderr}`.includes("tmux-ide update --tui-binary"));
      assert.equal(existsSync(info), false);
      assert.ok(result.exitCode !== 0);
      return { ...result, daemonStarted: false, expectedFailure: "runtime-acquisition-offline" };
    });
    await caseRun("scripts-disabled-explicit-runtime-acquisition", async () => {
      const downloaded = join(state, "bin", `tmux-ide-tui-${platform}-${version}`);
      assert.equal(existsSync(downloaded), false);
      success(
        command(
          node,
          [cli, "update", "--tui-binary"],
          { TMUX_IDE_PACK_FETCH_MODE: "success" },
          30_000,
        ),
      );
      assert.equal(hash(downloaded), hash(runtimeBinary));
      const acquired = JSON.parse(
        success(command(downloaded, ["__release-provenance"])).stdout.trim(),
      );
      const expected = JSON.parse(
        success(command(runtimeBinary, ["__release-provenance"])).stdout.trim(),
      );
      assert.deepEqual(acquired, expected);
      assert.equal(acquired.version, version);
      assert.equal(existsSync(info), false);
      return {
        runtimeSha256: hash(downloaded),
        provenance: acquired,
        daemonStarted: false,
        renderingQualified: false,
      };
    });
    const emptyPath = join(root, "empty-path");
    mkdirSync(emptyPath, { mode: 0o700 });
    await caseRun("missing-node", async () => {
      const result = requirePackedFailure(
        command(cli, ["--version"], { PATH: emptyPath, NODE_OPTIONS: "" }),
        { includes: "node" },
      );
      assert.equal(result.exitCode, 127);
      assert.equal(existsSync(info), false);
      return { ...result, daemonStarted: false, expectedFailure: "node-not-on-path" };
    });
    const which = success(command("sh", ["-c", "command -v which"])).stdout.trim();
    symlinkSync(which, join(emptyPath, "which"));
    await caseRun("missing-tmux-doctor", async () => {
      const raw = command(node, [cli, "doctor", "--json"], { PATH: emptyPath });
      assert.equal(raw.error, undefined);
      assert.equal(raw.signal, null);
      const diagnostic = JSON.parse(raw.stdout);
      assert.equal(diagnostic.ok, false);
      const row = diagnostic.checks.find((item) => item.label === "tmux installed");
      assert.equal(row?.pass, false);
      assert.ok(row.detail.includes("not found on PATH"));
      assert.equal(existsSync(info), false);
      return {
        expectedFailure: "tmux-not-on-path",
        daemonStarted: false,
        exitCode: raw.status,
        check: { label: row.label, pass: row.pass },
      };
    });
    mkdirSync(state, { recursive: true, mode: 0o700 });
    await caseRun("legacy-live-owner-refused-and-permissions-hardened", async () => {
      const bytes = Buffer.from(JSON.stringify({ pid: process.pid, version: "0.0.1" }));
      writeFileSync(info, bytes, { mode: 0o644 });
      chmodSync(info, 0o644);
      chmodSync(state, 0o755);
      const result = requirePackedFailure(command(node, [cli, "--headless", "--json"]), {
        code: "DAEMON_INFO_INVALID",
      });
      verifyPackedRecord(info, bytes, 0o700, 0o600);
      return {
        ...result,
        originalOwnerAlive: !dead(process.pid),
        bytesPreserved: true,
        parentMode: "0700",
        recordMode: "0600",
      };
    });
    await caseRun("untrusted-world-writable-record-refused", async () => {
      const bytes = readFileSync(info);
      chmodSync(info, 0o666);
      const result = requirePackedFailure(command(node, [cli, "--headless", "--json"]), {
        code: "DAEMON_INFO_INVALID",
      });
      verifyPackedRecord(info, bytes, 0o700, 0o666);
      chmodSync(info, 0o600);
      return { ...result, bytesPreserved: true, unsafeModePreserved: true };
    });
    const exited = owned(node, ["-e", "process.exit(0)"]);
    assert.equal((await boundedClose(exited)).code, 0);
    assert.ok(dead(exited.pid));
    serverStarted = true;
    success(
      command("tmux", ["-S", socket, "new-session", "-d", "-s", "packed-migration", "-c", project]),
    );
    serverPid = Number(
      success(command("tmux", ["-S", socket, "display-message", "-p", "#{pid}"])).stdout.trim(),
    );
    assert.ok(Number.isSafeInteger(serverPid) && serverPid > 1);
    receipt.tmuxPid = serverPid;
    let owner;
    await caseRun("proven-dead-legacy-record-replaced", async () => {
      assert.ok(dead(exited.pid));
      writeFileSync(info, JSON.stringify({ pid: exited.pid, version: "0.0.1" }));
      chmodSync(info, 0o644);
      chmodSync(state, 0o755);
      owner = owned(node, [cli, "--headless", "--json"]);
      let selected;
      const readinessDeadline = Date.now() + 10_000;
      await wait(async () => {
        try {
          selected = JSON.parse(readFileSync(info, "utf8"));
        } catch {
          return false;
        }
        if (selected.pid !== owner.pid || !Number.isInteger(selected.port)) return false;
        assert.equal(selected.productVersion, version);
        return await probePackedIdentity(selected, readinessDeadline - Date.now());
      });
      verifyPackedRecord(info, readFileSync(info), 0o700, 0o600);
      return {
        retiredPid: exited.pid,
        ownerPid: owner.pid,
        instanceId: selected.instanceId,
        productVersion: selected.productVersion,
        parentMode: "0700",
        recordMode: "0600",
      };
    });
    await caseRun("live-owner-permission-repair-reuses-same-owner", async () => {
      const bytes = readFileSync(info),
        selected = JSON.parse(bytes);
      chmodSync(info, 0o644);
      chmodSync(state, 0o755);
      const result = success(command(node, [cli, "--headless", "--json"]));
      const reused = JSON.parse(result.stdout.trim());
      assert.equal(reused.status, "already-running");
      assert.equal(reused.pid, owner.pid);
      assert.equal(reused.port, selected.port);
      verifyPackedRecord(info, bytes, 0o700, 0o600);
      return {
        ownerPid: owner.pid,
        bytesPreserved: true,
        sameOwner: true,
        parentMode: "0700",
        recordMode: "0600",
      };
    });
    owner.kill("SIGTERM");
    assert.equal((await boundedClose(owner)).code, 0);
    await wait(() => !existsSync(info));
  } catch (error) {
    failure = error;
  } finally {
    const cleanup = (receipt.cleanup = {
      children: await settlePackedChildren(children, exits),
      tmuxSocketRemoved: !existsSync(socket),
      tmuxOwnerDead: !serverStarted,
    });
    if (serverStarted) {
      command("tmux", ["-S", socket, "kill-server"]);
      cleanup.tmuxSocketRemoved = await waitForPackedSocketRemoval(socket);
      if (serverPid) {
        try {
          await wait(() => dead(serverPid), 2000);
          cleanup.tmuxOwnerDead = true;
        } catch {
          cleanup.tmuxOwnerDead = false;
        }
      }
    }
    receipt.cleanupConfirmed =
      cleanup.children.confirmed && cleanup.tmuxSocketRemoved && cleanup.tmuxOwnerDead;
  }
  if (failure) throw failure;
  if (!receipt.cleanupConfirmed || !receipt.cleanup.children.graceful)
    throw new Error("Packed installed scenario cleanup unconfirmed");
}
