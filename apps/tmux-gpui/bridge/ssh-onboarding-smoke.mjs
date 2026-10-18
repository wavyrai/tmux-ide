import process from "node:process";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import console from "node:console";
// Real owned OpenSSH failure, saved Add, private repair and explicit Retry.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat, mkdir, writeFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
import { discoverPreviewHost } from "./discovery.ts";
import { createPreviewCatalog } from "./catalog.ts";

import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
  unusedLoopbackPort,
} from "../../../scripts/lib/owned-ssh-fixture.mjs";
process.umask(0o077);
const useSsh = true;
const failureKind = process.env.TMUX_GPUI_TEST_SSH_FAILURE ?? "authentication";
assert.ok(
  ["authentication", "host-key", "missing-cli", "unreachable"].includes(failureKind),
  "Unknown SSH failure fixture",
);
const expectedFailure =
  failureKind === "unreachable"
    ? "unavailable"
    : failureKind === "missing-cli"
      ? "remote-cli-missing"
      : failureKind === "host-key"
        ? "ssh-host-key"
        : "ssh-authentication";
let trustedKnownHosts;
let ownedCliBytes;
let ownedConfigBytes;
const endpointRepair = {
  port: null,
  refusedBefore: false,
  refusedAfter: false,
  sshdAlive: false,
  originalSha256: null,
  restoredSha256: null,
};
async function assertRefused(port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Released loopback endpoint unexpectedly accepts connections"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Released loopback endpoint refusal timed out"));
    });
    socket.once("error", (error) => {
      socket.destroy();
      error.code === "ECONNREFUSED"
        ? resolve()
        : reject(new Error("Released loopback endpoint did not refuse connection"));
    });
  });
}
const ownedCliRepair = { removed: false, originalSha256: null, restoredSha256: null };
const publicDiscovery = process.env.TMUX_GPUI_TEST_PUBLIC_DISCOVERY === "1";
assert.ok(
  !["missing-cli", "unreachable"].includes(failureKind) || publicDiscovery,
  "Runtime and reachability cases require actual public discovery",
);
const output = process.env.TMUX_GPUI_TEST_OUTPUT;
assert.ok(output && isAbsolute(output), "Explicit private receipt prefix required");
assert.match(process.version, /^v24\./);
const trace = [];
const facts = {
  realSsh: true,
  failureKind,
  actualSavedAdd: false,
  denial: false,
  repaired: false,
  input: false,
  deniedInputAbsent: false,
  cleanup: false,
};
const failures = [];
const allocations = [];
let kernel, ssh, currentInfo, sshRoot;
const tracker = ownedProcesses({
  identify: (pid) => kernel.identify(pid),
  list: async () =>
    execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        return { pid, ppid };
      }),
});
let machineId;
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli) && (await stat(cli)).isFile(), "Supply an isolated built CLI");
const cliArtifact = { kind: "explicit-cli", packageVersion: null };
if (process.env.TMUX_GPUI_TEST_INSTALLED_CLI === "1") {
  const canonicalCli = await realpath(cli);
  const packageRoot = dirname(dirname(canonicalCli));
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.name, "tmux-ide");
  assert.equal(metadata.version, "2.9.7");
  assert.equal(metadata.bin?.["tmux-ide"], "bin/cli.js");
  assert.equal(await realpath(join(packageRoot, metadata.bin["tmux-ide"])), canonicalCli);
  cliArtifact.kind = "installed-package-input";
  cliArtifact.packageVersion = metadata.version;
}

const scratch = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-ssh-onboard",
});
const env = { ...process.env };
for (const key of Object.keys(env))
  if (key.startsWith("TMUX_IDE_") || key === "TMUX" || key === "TMUX_TMPDIR") delete env[key];
Object.assign(env, scratch.environment);
env.TMUX_IDE_TMUX_SOCKET_PATH = scratch.socketPath;
delete env.TMUX_PANE;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
let localDaemon, localScratch;
let daemon,
  browser,
  latest,
  buffer = "",
  stderr = "";
let fatal;
let closing = false;
const own = (child) => {
  child.on("error", () => {
    fatal ??= new Error("Owned child spawn failed");
  });
  child.on("exit", () => {
    if (!closing) fatal ??= new Error("Owned child exited early");
  });
  return child;
};
let phase = "startup";
const until = async (predicate) => {
  const deadline = Date.now() + 45000;
  while (!(await predicate())) {
    if (fatal) throw fatal;
    assert.ok(
      Date.now() < deadline,
      `Recovery deadline; phase=${phase}; status=${latest?.status}; diagnostics=${stderr}`,
    );
    await delay(25);
  }
};
const start = async () => {
  daemon = own(
    spawn(process.execPath, [cli, "--headless"], {
      env,
      cwd: scratch.root,
      stdio: "ignore",
    }),
  );
  await until(async () => {
    assert.equal(daemon.exitCode, null, "private daemon exited");
    try {
      return (
        JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8")).pid ===
        daemon.pid
      );
    } catch {
      return false;
    }
  });
  currentInfo = JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8"));
};
const deniedMarker = "NR08_DENIED_" + randomUUID().replaceAll("-", "").slice(0, 12);
let deniedPane;
const ownedPane = () =>
  execFileSync(
    env.TMUX_IDE_TMUX_BIN,
    [
      "-S",
      scratch.socketPath,
      "display-message",
      "-p",
      "-t",
      scratch.initialPanes[0].paneId,
      "#{pane_id}\t#{@tmux_ide_pane_id}",
    ],
    { env, encoding: "utf8", timeout: 5000 },
  )
    .trim()
    .split("\t");
const send = (value) => browser.stdin.write(JSON.stringify(value) + "\n");
try {
  await start();
  localScratch = await createScratchFleet({
    sessions: 1,
    windowsPerSession: 1,
    slug: "gpui-ssh-owner",
  });
  const browserEnv = {
    ...env,
    ...localScratch.environment,
    TMUX_IDE_TMUX_SOCKET_PATH: localScratch.socketPath,
  };
  localDaemon = own(
    spawn(process.execPath, [cli, "--headless"], {
      env: browserEnv,
      cwd: localScratch.root,
      stdio: "ignore",
    }),
  );
  await until(async () => {
    try {
      return (
        JSON.parse(await readFile(join(localScratch.daemonInfoDir, "daemon.json"), "utf8")).pid ===
        localDaemon.pid
      );
    } catch {
      return false;
    }
  });
  if (useSsh) {
    sshRoot = await mkdtemp(join(await realpath(tmpdir()), "gpui-ssh-"));
    kernel = await createMacProcessIdentity({
      parent: sshRoot,
      onAllocated: (a) => allocations.push(a),
    });
    ssh = await createOwnedSshFixture({
      parent: sshRoot,
      node: process.execPath,
      targetPort: currentInfo.port,
      ...(publicDiscovery ? { publicDiscoveryCli: cli } : {}),
      processes: tracker,
      handshake: async () =>
        currentInfo
          ? { version: 1, daemon: currentInfo }
          : { version: 1, error: { code: "daemon-missing" } },
      onAllocated: (a) => allocations.push(a),
    });
    if (publicDiscovery) {
      // Mirror only an independently identity-verified owned daemon record. No synthetic response.
      assert.equal(currentInfo.pid, daemon.pid);
      assert.ok(["127.0.0.1", "localhost", "::1"].includes(currentInfo.bindHostname));
      const host = currentInfo.bindHostname === "::1" ? "[::1]" : currentInfo.bindHostname;
      const response = await globalThis.fetch(`http://${host}:${currentInfo.port}/identity`, {
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(2500),
      });
      assert.equal(response.status, 200);
      const identity = await response.json();
      for (const field of ["pid", "instanceId", "startedAt", "protocolVersion", "environmentId"])
        assert.equal(identity[field], currentInfo[field]);
      assert.deepEqual(
        JSON.parse(await readFile(join(scratch.daemonInfoDir, "daemon.json"), "utf8")),
        currentInfo,
      );
      const state = join(ssh.root, "state");
      await mkdir(state, { mode: 0o700 });
      ssh.files.capture("state");
      await writeFile(join(state, "daemon.json"), JSON.stringify(currentInfo), {
        mode: 0o600,
        flag: "wx",
      });
      ssh.files.capture("state/daemon.json");
    }
    const client = join(scratch.root, "client");
    const bin = join(client, "bin");
    await mkdir(bin, { recursive: true, mode: 0o700 });
    await writeFile(join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F '${ssh.config}' "$@"\n`, {
      mode: 0o700,
    });
    // Shared private local registry permits the actual owner-mediated Add path.
    Object.assign(browserEnv, { PATH: bin + ":" + env.PATH });
    if (failureKind === "unreachable") {
      ssh.files.verify("client_config");
      ownedConfigBytes = await readFile(ssh.config);
      endpointRepair.originalSha256 = createHash("sha256").update(ownedConfigBytes).digest("hex");
      endpointRepair.port = await unusedLoopbackPort();
      assert.notEqual(endpointRepair.port, ssh.port);
      await assertRefused(endpointRepair.port);
      endpointRepair.refusedBefore = true;
      const config = ownedConfigBytes.toString("utf8");
      assert.equal(config.match(/^ Port /gm)?.length, 1);
      assert.ok(config.startsWith("Host target\n HostName 127.0.0.1\n"));
      assert.ok(config.includes(`\n Port ${ssh.port}\n`));
      await writeFile(
        ssh.config,
        config.replace(`\n Port ${ssh.port}\n`, `\n Port ${endpointRepair.port}\n`),
        { mode: 0o600 },
      );
      ssh.files.capture("client_config");
      assert.equal(ssh.confirmRefreshedPid().pid, ssh.sshdPid);
    } else if (failureKind === "missing-cli") {
      ssh.files.verify("bin");
      ssh.files.verify("bin/tmux-ide");
      ownedCliBytes = await readFile(join(ssh.root, "bin/tmux-ide"));
      ownedCliRepair.originalSha256 = createHash("sha256").update(ownedCliBytes).digest("hex");
      await rm(join(ssh.root, "bin/tmux-ide"));
      await assert.rejects(stat(join(ssh.root, "bin/tmux-ide")), { code: "ENOENT" });
      ownedCliRepair.removed = true;
    } else if (failureKind === "host-key") {
      ssh.files.verify("known_hosts");
      ssh.files.verify("host.pub");
      trustedKnownHosts = await readFile(join(ssh.root, "known_hosts"), "utf8");
      const endpoint = trustedKnownHosts.split(" ")[0];
      const wrongKey = await readFile(join(ssh.root, "client.pub"), "utf8");
      await writeFile(join(ssh.root, "known_hosts"), endpoint + " " + wrongKey, { mode: 0o600 });
      ssh.files.capture("known_hosts");
    } else {
      ssh.files.verify("authorized_keys");
      await writeFile(join(ssh.root, "authorized_keys"), "", { mode: 0o600 });
      ssh.files.capture("authorized_keys");
    }
  }
  browser = own(
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve(process.env.TMUX_GPUI_TEST_BROWSER ?? "apps/tmux-gpui/bridge/browser.ts"),
        "--local",
      ],
      {
        env: browserEnv,
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    ),
  );
  for (const stream of [browser.stdin, browser.stdout, browser.stderr])
    stream.on("error", () => {
      if (!closing) fatal ??= new Error("Owned browser stream failed");
    });
  browser.stderr.on("data", (b) => {
    stderr = (stderr + b.toString()).slice(-8000);
  });
  browser.stdout.on("data", (b) => {
    try {
      buffer += b.toString();
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024, "Publication overflow");
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    } catch {
      fatal = new Error("Invalid bounded publication");
    }
  });
  send({ type: "presence", active: true, revision: 1 });
  phase = "registry-ready";
  await until(() => latest?.machines?.available && latest?.presenceRevision === 1);
  assert.equal(latest.machines.machines.length, 0);
  phase = "saved-add-denied";
  send({ type: "machine", request: 1, sshTarget: "target" });
  await until(() => latest?.machines?.machines.some((row) => row.sshTarget === "target"));
  const saved = latest.machines.machines.find((row) => row.sshTarget === "target");
  machineId = saved.id;
  const registry = JSON.parse(
    await readFile(join(browserEnv.TMUX_IDE_REGISTRY_DIR, "machines.json"), "utf8"),
  );
  assert.equal(registry.machines.filter((row) => row.id === machineId).length, 1);
  facts.actualSavedAdd = true;
  await until(() =>
    latest?.fleet?.groups.some(
      (group) =>
        group.id === machineId && group.diagnostic?.failure === expectedFailure && group.retry,
    ),
  );
  const denied = latest.fleet.groups.find((group) => group.id === machineId);
  assert.equal(
    denied.diagnostic.phase,
    failureKind === "unreachable" ? "reconnecting" : "needs-attention",
  );
  assert.equal(latest.snapshot, null);
  assert.equal(latest.inputReady, false);
  facts.denial = true;
  // Establish the exact semantic target using supported metadata promotion on the owned daemon.
  // The remote route remains denied in the browser; no terminal input is sent by this setup.
  const setupCatalog = createPreviewCatalog(
    await discoverPreviewHost(join(scratch.daemonInfoDir, "daemon.json")),
  );
  try {
    const sessions = await setupCatalog.sessions();
    const target = sessions.find((session) => session.sessionName === scratch.sessionNames[0]);
    assert.ok(target);
    const panes = await setupCatalog.panes(target.liveSessionId);
    assert.equal(panes.length, 1);
  } finally {
    setupCatalog.dispose();
  }
  const [physical, semantic] = ownedPane();
  assert.equal(physical, scratch.initialPanes[0].paneId);
  assert.ok(semantic, "Owned pane must have a real semantic identity before denied input");
  deniedPane = semantic;
  send({
    type: "input",
    request: latest.request,
    id: deniedPane,
    input: { kind: "text", data: "echo " + deniedMarker },
  });
  send({
    type: "input",
    request: latest.request,
    id: deniedPane,
    input: { kind: "key", data: "Enter" },
  });

  trace.push({ phase, diagnostic: denied.diagnostic, frame: false, input: false });
  // Restore only owned fixture trust, credentials or executable; never weaken SSH verification.
  if (failureKind === "unreachable") {
    ssh.files.verify("client_config");
    assert.ok(ownedConfigBytes);
    await assertRefused(endpointRepair.port);
    endpointRepair.refusedAfter = true;
    assert.equal(ssh.confirmRefreshedPid().pid, ssh.sshdPid);
    endpointRepair.sshdAlive = true;
    await writeFile(ssh.config, ownedConfigBytes, { mode: 0o600 });
    ssh.files.capture("client_config");
    ssh.files.verify("client_config");
    endpointRepair.restoredSha256 = createHash("sha256")
      .update(await readFile(ssh.config))
      .digest("hex");
    assert.equal(endpointRepair.restoredSha256, endpointRepair.originalSha256);
  } else if (failureKind === "missing-cli") {
    ssh.files.verify("bin");
    assert.ok(ownedCliBytes && ownedCliRepair.removed);
    await writeFile(join(ssh.root, "bin/tmux-ide"), ownedCliBytes, { mode: 0o700, flag: "wx" });
    ssh.files.capture("bin/tmux-ide");
    ssh.files.verify("bin/tmux-ide");
    ownedCliRepair.restoredSha256 = createHash("sha256")
      .update(await readFile(join(ssh.root, "bin/tmux-ide")))
      .digest("hex");
    assert.equal(ownedCliRepair.restoredSha256, ownedCliRepair.originalSha256);
  } else if (failureKind === "host-key") {
    ssh.files.verify("known_hosts");
    ssh.files.verify("host.pub");
    assert.ok(trustedKnownHosts);
    await writeFile(join(ssh.root, "known_hosts"), trustedKnownHosts, { mode: 0o600 });
    ssh.files.capture("known_hosts");
  } else {
    ssh.files.verify("authorized_keys");
    await writeFile(
      join(ssh.root, "authorized_keys"),
      await readFile(join(ssh.root, "client.pub")),
      {
        mode: 0o600,
      },
    );
    ssh.files.capture("authorized_keys");
  }
  phase = "explicit-retry";
  send({ type: "fleet-retry", request: latest.request, retry: denied.retry });
  await until(() =>
    latest?.fleet?.groups.some(
      (group) =>
        group.id === machineId &&
        group.sessions.some((row) => row.name === scratch.sessionNames[0] && row.selection),
    ),
  );
  const ready = latest.fleet.groups.find((group) => group.id === machineId);
  assert.equal(latest.machines.machines.filter((row) => row.id === machineId).length, 1);
  assert.equal(ready.state, "ready");
  assert.equal(ready.diagnostic?.phase, "ready");
  assert.equal(ready.diagnostic?.failure, null);
  facts.repaired = true;
  trace.push({ phase, diagnostic: ready.diagnostic, sameSavedMachine: true });
  const session = ready.sessions.find((row) => row.name === scratch.sessionNames[0]);
  send({ type: "fleet-session", request: 2, selection: session.selection });
  await until(() => latest?.request === 2 && latest.sessionCatalogComplete && latest.preferredPane);
  const pane = latest.preferredPane;
  assert.equal(pane, deniedPane, "Recovered pane must match the denied-input target");
  send({ type: "pane", request: 3, id: pane });
  phase = "input-ready";
  await until(
    () =>
      latest?.request === 3 && latest.selectedPane === pane && latest.snapshot && latest.inputReady,
  );
  const marker = "NR08_SSH_OK_" + randomUUID().replaceAll("-", "").slice(0, 12);
  send({ type: "input", request: 3, id: pane, input: { kind: "text", data: "echo " + marker } });
  send({ type: "input", request: 3, id: pane, input: { kind: "key", data: "Enter" } });
  await until(() =>
    scratch
      .capturePane(scratch.sessionNames[0])
      .split("\n")
      .some((line) => line.trim() === marker),
  );
  facts.input = true;
  assert.ok(
    !scratch.capturePane(scratch.sessionNames[0]).includes(deniedMarker),
    "Denied input must not replay after recovery",
  );
  facts.deniedInputAbsent = true;
  if (publicDiscovery)
    assert.equal(ssh.metrics().requests, 0, "Real CLI must not use synthetic handshake");
  trace.push({ phase, freshInputExecuted: true });
} catch (error) {
  failures.push({
    phase,
    message: error instanceof Error ? error.message.split("; status=")[0] : "Fixture failed",
  });
} finally {
  closing = true;
  try {
    for (const child of [browser, daemon, localDaemon]) if (child) await stopFixtureChild(child);
    if (kernel) await tracker.dispose();
    for (const allocation of allocations.reverse()) await allocation.disposeFiles();
    if (sshRoot) await rm(sshRoot, { recursive: true, force: true });
    await scratch.dispose();
    if (localScratch) await localScratch.dispose();
    facts.cleanup = true;
  } catch {
    failures.push({ phase: "cleanup", message: "Owned cleanup refused; private roots retained" });
  }
  const result = {
    passed: failures.length === 0,
    node: process.version,
    cliSha256: createHash("sha256")
      .update(await readFile(cli))
      .digest("hex"),
    ...facts,
    ...(failureKind === "missing-cli" ? { ownedCliRepair } : {}),
    ...(failureKind === "unreachable" ? { endpointRepair } : {}),
    discoveryDescriptor: publicDiscovery
      ? "actual explicit CLI remote-daemon-info using mirrored verified private record"
      : "synthetic descriptor for actual private daemon",
    remoteCliPreflightQualified: publicDiscovery && facts.input && ssh?.metrics().requests === 0,
    installedPackageQualified: false,
    cliArtifact,
    syntheticHandshakeRequests: ssh?.metrics().requests ?? null,
    lastRemote: latest?.fleet?.groups
      .filter((group) => group.id === machineId)
      .map((group) => ({
        state: group.state,
        conflict: group.conflict,
        diagnostic: group.diagnostic,
        sessionCount: group.sessions.length,
        retry: !!group.retry,
      })),
    trace,
    failures,
    ...(!facts.cleanup
      ? { privateRoots: [scratch.root, localScratch?.root, sshRoot].filter(Boolean) }
      : {}),
  };
  await writeFile(output + ".json", JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await writeFile(output + ".stderr", stderr, { mode: 0o600 });
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}
