// Real private OpenSSH, synthetic daemon HTTP: no personal config or daemon access.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "node:timers";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import process from "node:process";
import console from "node:console";
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  ownedProcesses,
} from "../../../scripts/lib/owned-ssh-fixture.mjs";
import { shellEscape } from "../../../packages/daemon/src/lib/shell.ts";
import { waitForOwnedExit } from "./native-ssh-exit.mjs";
const execute = promisify(execFile);
const [binary, cliPath, guiBinary] = process.argv.slice(2);
const graphicsProbe = process.env.TMUX_IDE_NATIVE_TEST_GRAPHICS === "owned-pixels";
assert(!graphicsProbe || cliPath);
const distinctLocal = process.env.TMUX_IDE_NATIVE_TEST_DISTINCT_LOCAL === "owned-fleet";
const fleetAgents = process.env.TMUX_IDE_NATIVE_TEST_FLEET_AGENTS === "owned-agents";
const cachedHistory = process.env.TMUX_IDE_NATIVE_TEST_CACHED_HISTORY === "owned-catalog";
const addMachine = process.env.TMUX_IDE_NATIVE_TEST_ADD === "owned-profile";
const liveRevocation = process.env.TMUX_IDE_NATIVE_TEST_REVOKE === "live-profile";
const revokeProfile = liveRevocation || process.env.TMUX_IDE_NATIVE_TEST_REVOKE === "owned-profile";
assert(!revokeProfile || (cliPath && guiBinary));
assert(!addMachine || (cliPath && guiBinary && !revokeProfile));
assert(!fleetAgents || (cachedHistory && distinctLocal && guiBinary));
assert(!cachedHistory || (guiBinary && distinctLocal && !revokeProfile && !addMachine));
assert(
  binary &&
    isAbsolute(binary) &&
    (!cliPath || isAbsolute(cliPath)) &&
    (!guiBinary || (cliPath && isAbsolute(guiBinary))),
  "Usage: node --import tsx native-ssh-smoke.mjs ABS_CLIENT_TEST_BINARY [ABS_CLI [ABS_GUI_TEST_BINARY]]",
);
process.umask(0o077);
const root = mkdtempSync(join(realpathSync(tmpdir()), "nssh-"));
const env = { PATH: "/usr/bin:/bin", HOME: root, ZDOTDIR: root };
const allocations = [];
let witness,
  timer,
  captureFlight = null,
  captureFailed = false,
  phase = "witness";
const receipt = { realOpenSsh: true, syntheticDaemon: !cliPath, passed: false, cleanup: false };
const tracker = ownedProcesses({
  identify: (pid) => witness.identify(pid),
  list: async () => {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="], {
      env,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        assert(match);
        return { pid: Number(match[1]), ppid: Number(match[2]) };
      });
  },
});
let fleet, runningDaemon, localFleet, localDaemon, registryDaemon, before, savedProfileId;
let daemon = {
  pid: process.pid,
  port: 0,
  protocolVersion: 4,
  productVersion: "2.9.12",
  instanceId: randomUUID(),
  startedAt: new Date().toISOString(),
  bindHostname: "127.0.0.1",
  authToken: randomBytes(32).toString("hex"),
};
let identityRequests = 0,
  authenticatedRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/identity" && !request.headers.authorization) {
    identityRequests++;
    const identity = { ...daemon };
    delete identity.authToken;
    response.end(JSON.stringify({ ok: true, ...identity }));
  } else if (
    request.url === "/api/v2/capabilities" &&
    request.headers.authorization === `Bearer ${daemon.authToken}`
  ) {
    authenticatedRequests++;
    response.end(JSON.stringify({ nativeFixture: true }));
  } else {
    response.writeHead(403);
    response.end();
  }
});
try {
  witness = await createMacProcessIdentity({
    parent: root,
    onAllocated: (owner) => allocations.push(owner),
  });
  if (cliPath) {
    phase = "daemon";
    fleet = await createScratchFleet({ sessions: 2, windowsPerSession: 1, slug: "rust-ssh" });
    runningDaemon = await startDaemon(fleet, { cliPath });
    daemon = runningDaemon.record;
    registryDaemon = runningDaemon;
    if (distinctLocal) {
      phase = "local-daemon";
      assert(guiBinary);
      localFleet = await createScratchFleet({
        sessions: 1,
        windowsPerSession: 1,
        slug: "rust-local",
      });
      localDaemon = await startDaemon(localFleet, { cliPath });
      registryDaemon = localDaemon;
      assert.notEqual(localDaemon.record.instanceId, daemon.instanceId);
    }
    before = fleet.captureWindowPanes(fleet.sessionNames[0]);
    if (guiBinary && !addMachine) {
      phase = "save-fixture-profile";
      assert(fleet.daemonInfoDir.startsWith(`${fleet.root}/`));
      savedProfileId = randomUUID();
      const response = await globalThis.fetch(
        `${registryDaemon.baseUrl}/api/resources/saved-machines`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${registryDaemon.record.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            expectedInstanceId: registryDaemon.record.instanceId,
            registry: {
              version: 1,
              machines: [
                {
                  id: savedProfileId,
                  label: "Owned SSH fixture",
                  sshTarget: "target",
                  enabled: true,
                  ...(daemon.environmentId ? { expectedEnvironmentId: daemon.environmentId } : {}),
                },
              ],
            },
          }),
          signal: globalThis.AbortSignal.timeout(5000),
        },
      );
      assert.equal(response.status, 200);
    }
  } else {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    daemon.port = server.address().port;
  }
  timer = setInterval(() => {
    if (!captureFlight)
      captureFlight = tracker
        .capture()
        .catch(() => {
          captureFailed = true;
          receipt.captureDiagnostics = tracker.snapshot().diagnostics;
        })
        .finally(() => {
          captureFlight = null;
        });
  }, 100);
  phase = "sshd";
  const fixture = await createOwnedSshFixture({
    parent: root,
    node: realpathSync(process.execPath),
    targetPort: daemon.port,
    processes: tracker,
    handshake: () => ({ version: 1, daemon }),
    onAllocated: (owner) => allocations.push(owner),
  });
  const wrapper = join(fixture.root, "native-ssh");
  mkdirSync(wrapper, { mode: 0o700 });
  fixture.files.capture("native-ssh");
  const tunnelPid = join(root, "tunnel.pid");
  writeFileSync(tunnelPid, "", { mode: 0o600, flag: "wx" });
  const tunnelProcesses = () => {
    const value = readFileSync(tunnelPid, "utf8").trim();
    assert(value.length <= 8192);
    const pids = value ? value.split(/\s+/u).map(Number) : [];
    assert(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1));
    return pids;
  };
  writeFileSync(
    join(wrapper, "ssh"),
    `#!/bin/sh\ncase " $* " in *" -N "*) printf '%s\n' "$$" >> ${shellEscape(tunnelPid)} ;; esac\nexec /usr/bin/ssh -F ${shellEscape(fixture.config)} -o ControlMaster=no -o ControlPath=none "$@"\n`,
    { mode: 0o700, flag: "wx" },
  );
  fixture.files.capture("native-ssh/ssh");
  phase = "rust";
  const runs = [
    {
      binary,
      filter: cliPath
        ? "tmux_daemon::owner::remote_terminal_tests::owned_openssh_real_daemon_terminal"
        : "tmux_ssh::transport::tests::owned_openssh_discovery_and_capabilities",
    },
  ];
  if (guiBinary)
    runs.push({
      binary: guiBinary,
      filter:
        "tmux_snapshot::browser::native_transport::local::tests::native_ssh_catalog_opens_owned_session_without_helper",
    });
  if (cachedHistory)
    runs.push({
      binary: guiBinary,
      filter:
        "tmux_snapshot::browser::native_transport::local::tests::cached::new_owner_restores_remote_history_from_cached_catalog",
    });
  if (fleetAgents)
    runs.push({
      binary: guiBinary,
      filter:
        "tmux_snapshot::browser::native_transport::local::tests::agent_live::native_home_agent_selection_crosses_machine_with_exact_pane_identity",
    });
  let cachedLive = null;
  for (const [index, run] of runs.entries()) {
    if (fleetAgents && index === 1) {
      const pane = fleet.initialPanes.find((p) => p.sessionName === fleet.sessionNames[1]).paneId;
      for (const [key, value] of [
        ["@agent_display_name", "Fixture remote agent"],
        ["@agent_state", `blocked:${Math.floor(Date.now() / 1000)}`],
      ])
        await execute(
          fleet.environment.TMUX_IDE_TMUX_BIN,
          ["-S", fleet.socketPath, "set-option", "-p", "-t", pane, key, value],
          { env: { ...process.env, ...fleet.environment }, timeout: 5000 },
        );
    }
    phase = `rust-${index}`;
    const child = tracker.retain(
      spawn(run.binary, [run.filter, "--exact", "--ignored", "--nocapture"], {
        env: {
          ...env,
          PATH: `${wrapper}:/usr/bin:/bin`,
          TMUX_IDE_TEST_OWNED_SSH: "private-fixture",
          ...(fleetAgents ? { TMUX_IDE_TEST_FLEET_AGENTS: "owned-agents" } : {}),
          ...(cachedHistory && index >= 1
            ? {
                TMUX_IDE_TEST_CACHED_HISTORY: "owned-catalog",
                TMUX_IDE_TEST_CACHED_LIVE: cachedLive ?? "",
              }
            : {}),
          ...(graphicsProbe && index === 0 ? { TMUX_IDE_TEST_GRAPHICS: "owned-pixels" } : {}),
          ...(index >= 1
            ? {
                TMUX_IDE_TEST_RECONNECT: "owned-tunnel",
                ...(cachedHistory && index === 1
                  ? { TMUX_IDE_TEST_BACKGROUND_RETRY_ACK: join(root, "background-retry-ack") }
                  : {}),
                TMUX_IDE_TEST_LOCAL_RECORD: join(
                  (localFleet ?? fleet).daemonInfoDir,
                  "daemon.json",
                ),
                ...(distinctLocal ? { TMUX_IDE_TEST_CROSS_MACHINE: "owned-fleet" } : {}),
                TMUX_IDE_TEST_PREFERENCES: "owned-local",
                TMUX_IDE_TEST_SAVED_PROFILE: savedProfileId ?? "",
                ...(addMachine ? { TMUX_IDE_TEST_ADD_MACHINE: "owned-profile" } : {}),
                ...(revokeProfile ? { TMUX_IDE_TEST_REVOKE_PROFILE: "owned-profile" } : {}),
              }
            : {}),
          ...(fleet
            ? {
                TMUX_IDE_TEST_ALLOW_MUTATION: "owned-scratch-fleet",
                TMUX_IDE_TEST_INPUT_SESSION: fleet.sessionNames[1],
              }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    let output = "";
    let interruption = null;
    let backgroundInterruption = null;
    let catalogAdded = false;
    let catalogRemoved = false;
    let selectedAdded = false;
    let selectedRemoved = false;
    let graphicsInjected = false;
    let interruptedProcesses = null;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        if (output.length < 65536) output += data;
        if (
          index === 0 &&
          graphicsProbe &&
          !graphicsInjected &&
          output.includes("NATIVE_SSH_GRAPHICS_READY")
        ) {
          graphicsInjected = true;
          try {
            const raw = Buffer.alloc(256 * 1024 * 4, 42);
            const encoded = raw.toString("base64");
            const apc = (control, payload = "") => `\x1b_G${control};${payload}\x1b\\`;
            let sequence = "";
            for (let offset = 0; offset < encoded.length; offset += 4096) {
              const more = offset + 4096 < encoded.length ? 1 : 0;
              sequence += apc(
                offset === 0 ? `a=t,f=32,s=256,v=1024,i=9,q=2,m=${more}` : `m=${more}`,
                encoded.slice(offset, offset + 4096),
              );
            }
            sequence +=
              apc("a=p,U=1,i=9,c=1,r=1,q=2") + "\x1b[38;5;9m\u{10EEEE}\u0305\u0305\x1b[39m\r\n";
            const pixels = join(root, "owned-graphics.bin");
            writeFileSync(pixels, sequence, { mode: 0o600, flag: "wx" });
            fleet.typeInPane(fleet.sessionNames[1], `cat ${shellEscape(pixels)}`);
          } catch {
            // Keep failures inside the owning async flow so its finally block
            // reaps the private SSH processes, daemon and scratch fleet.
            receipt.graphicsInjectionFailed = true;
            child.kill("SIGTERM");
          }
        }
        if (index === 1 && cachedHistory) {
          try {
            if (!selectedAdded && output.includes("NATIVE_SELECTED_CATALOG_ADD_READY")) {
              selectedAdded = true;
              localFleet.createSession("native-selected-push");
            }
            if (!selectedRemoved && output.includes("NATIVE_SELECTED_CATALOG_REMOVE_READY")) {
              selectedRemoved = true;
              localFleet.killSession("native-selected-push");
            }
            if (!catalogAdded && output.includes("NATIVE_CATALOG_ADD_READY")) {
              catalogAdded = true;
              fleet.createSession("native-push-owned");
            }
            if (!catalogRemoved && output.includes("NATIVE_CATALOG_REMOVE_READY")) {
              catalogRemoved = true;
              fleet.killSession("native-push-owned");
            }
          } catch {
            receipt.catalogMutationFailed = true;
            child.kill("SIGTERM");
          }
        }
        if (
          index === 1 &&
          cachedHistory &&
          !backgroundInterruption &&
          output.includes("NATIVE_BACKGROUND_FLEET_INTERRUPT_READY")
        ) {
          backgroundInterruption = (async () => {
            const pid = tunnelProcesses().at(-1);
            assert(Number.isSafeInteger(pid) && pid > 1);
            const identity = await witness.identify(pid);
            assert(identity !== null);
            // capture() coalesces with the periodic scan, which may have
            // started before this newly created tunnel existed. Complete that
            // scan, then require a fresh ancestry proof before signalling.
            await tracker.capture();
            await tracker.capture();
            assert(
              tracker
                .snapshot()
                .ancestry.some((row) => row.pid === pid && row.rootPid === child.pid),
            );
            assert.equal(await witness.identify(pid), identity);
            process.kill(pid, "SIGTERM");
            await waitForOwnedExit((pid) => witness.identify(pid), pid, identity);
            writeFileSync(join(root, "background-retry-ack"), "retired", {
              mode: 0o600,
              flag: "wx",
            });
            return true;
          })().catch((error) => {
            console.error("Owned background interruption failed:", error);
            child.kill("SIGTERM");
            return false;
          });
        }
        if (index === 1 && !interruption && output.includes("NATIVE_SSH_INTERRUPT_READY")) {
          interruption = (async () => {
            const processes = tunnelProcesses();
            const pid = processes.at(-1);
            assert(Number.isSafeInteger(pid) && pid > 1);
            const identity = await witness.identify(pid);
            assert(identity !== null);
            // capture() coalesces with the periodic scan, which may have
            // started before this newly created tunnel existed. Complete that
            // scan, then require a fresh ancestry proof before signalling.
            await tracker.capture();
            await tracker.capture();
            assert(
              tracker
                .snapshot()
                .ancestry.some((row) => row.pid === pid && row.rootPid === child.pid),
            );
            assert.equal(await witness.identify(pid), identity);
            if (revokeProfile) {
              const response = await globalThis.fetch(
                `${registryDaemon.baseUrl}/api/resources/saved-machines`,
                {
                  method: "PATCH",
                  headers: {
                    Authorization: `Bearer ${registryDaemon.record.authToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    expectedInstanceId: registryDaemon.record.instanceId,
                    change: { id: savedProfileId, operation: "disable" },
                  }),
                  signal: globalThis.AbortSignal.timeout(5000),
                },
              );
              assert.equal(response.status, 200);
            }
            if (!liveRevocation) {
              const current = await witness.identify(pid);
              // The watcher can already have retired this exact owned tunnel.
              if (current === identity) process.kill(pid, "SIGTERM");
              else assert.equal(current, null);
            }
            interruptedProcesses = processes;
            return true;
          })().catch(() => false);
        }
      });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
    let code;
    try {
      [code] = await once(child, "exit");
    } finally {
      clearTimeout(timeout);
    }
    writeFileSync(
      join(root, `rust-${index}.log`),
      output
        .replaceAll(daemon.authToken, "<redacted>")
        .replaceAll(registryDaemon?.record.authToken ?? daemon.authToken, "<redacted>"),
      { mode: 0o600 },
    );
    assert.equal(code, 0, "native SSH fixture test failed");
    assert.match(output, /1 passed; 0 failed/u);
    if (index === 0 && graphicsProbe) {
      assert(graphicsInjected && output.includes("NATIVE_SSH_GRAPHICS_VERIFIED"));
      receipt.nativeCompressedGraphics = true;
    }
    if (index === 1) {
      assert(interruption && (await interruption), "owned tunnel interruption did not complete");
      if (revokeProfile) {
        assert(output.includes("NATIVE_SAVED_PROFILE_REVOKED"));
        assert.deepEqual(
          tunnelProcesses(),
          interruptedProcesses,
          "revoked profile opened a replacement SSH process",
        );
        receipt.nativeProfileRevocation = true;
        receipt.nativeHealthyProfileRevocation = liveRevocation;
      } else assert(output.includes("NATIVE_SSH_RECONNECTED"));
      assert(output.includes("NATIVE_SAVED_PROFILE_RETURNED_LOCAL"));
      receipt.nativeReconnect = !revokeProfile;
      if (addMachine) {
        assert(output.includes("NATIVE_MACHINE_ADDED"));
        const response = await globalThis.fetch(
          `${registryDaemon.baseUrl}/api/resources/saved-machines`,
          {
            headers: { Authorization: `Bearer ${registryDaemon.record.authToken}` },
            signal: globalThis.AbortSignal.timeout(5000),
          },
        );
        assert.equal(response.status, 200);
        const saved = await response.json();
        assert.equal(saved.registry.machines.length, 1);
        assert.equal(saved.registry.machines[0].sshTarget, "target");
        receipt.nativeAddMachine = true;
      }
      assert(output.includes("NATIVE_PREFERENCES_VERIFIED"));
      assert(output.includes("NATIVE_NAVIGATION_VERIFIED"));
      receipt.nativeNavigation = true;
      if (distinctLocal) {
        assert(output.includes("NATIVE_CROSS_MACHINE_VERIFIED"));
        receipt.nativeCrossMachineNavigation = true;
        assert(output.includes("NATIVE_SESSION_TABS_VERIFIED"));
        receipt.nativeSessionTabs = true;
      }
      const preferencesResponse = await globalThis.fetch(
        `${registryDaemon.baseUrl}/api/resources/fleet-client-state`,
        {
          headers: { Authorization: `Bearer ${registryDaemon.record.authToken}` },
          signal: globalThis.AbortSignal.timeout(5000),
        },
      );
      assert.equal(preferencesResponse.status, 200);
      const preferences = await preferencesResponse.json();
      assert.equal(preferences.state.favorites.length, 1);
      assert.equal(preferences.state.collapsed.length, 0);
      assert(preferences.state.recent.length > 0, "live attachments must persist visits");
      for (const key of preferences.state.recent) assert(Array.isArray(JSON.parse(key)));
      if (cachedHistory) {
        assert(output.includes("NATIVE_BACKGROUND_FLEET_SELECTION_VERIFIED"));
        receipt.nativeBackgroundFleetSelection = true;
        assert(output.includes("NATIVE_BACKGROUND_FLEET_PREFERENCES_VERIFIED"));
        receipt.nativeBackgroundFleetPreferences = true;
        assert(output.includes("NATIVE_BACKGROUND_SERVER_CREATION_VERIFIED"));
        receipt.nativeBackgroundServerCreation = true;
        assert(output.includes("NATIVE_BACKGROUND_CONNECTION_CONTROLS_VERIFIED"));
        receipt.nativeBackgroundConnectionControls = true;
        assert(output.includes("NATIVE_SELECTED_DISCONNECT_VERIFIED"));
        receipt.nativeSelectedDisconnect = true;
        assert(
          catalogAdded && catalogRemoved && output.includes("NATIVE_CATALOG_UPDATES_VERIFIED"),
        );
        receipt.nativeCatalogUpdates = true;
        assert(
          selectedAdded && selectedRemoved && output.includes("NATIVE_SELECTED_CATALOG_VERIFIED"),
        );
        receipt.nativeSelectedCatalogUpdates = true;
        assert(backgroundInterruption && (await backgroundInterruption));
        assert(output.includes("NATIVE_BACKGROUND_FLEET_RETRY_VERIFIED"));
        receipt.nativeBackgroundFleetRetry = true;
        assert(output.includes("NATIVE_BACKGROUND_FLEET_AUTO_RECOVERY_VERIFIED"));
        receipt.nativeBackgroundAutoRecovery = true;
        phase = "cached-history-preparation";
        writeFileSync(
          join(root, "cached-history-preparation.json"),
          JSON.stringify(preferences.state.catalog, null, 2),
          { mode: 0o600, flag: "wx" },
        );
        const remoteCache = preferences.state.catalog.find(
          (route) => route.routeId === savedProfileId,
        );
        const localCache = preferences.state.catalog.find((route) => route.routeId === "local");
        assert(remoteCache && localCache, "native catalogs must be persisted before restart");
        const remoteSession = remoteCache.sessions.find(
          (session) => session.name === fleet.sessionNames[1],
        );
        const localSession = localCache.sessions.find(
          (session) => session.name === localFleet.sessionNames[0],
        );
        assert(remoteSession?.liveSessionId && localSession?.liveSessionId);
        cachedLive = remoteSession.liveSessionId;
        for (const key of [remoteSession.id, localSession.id]) {
          const response = await globalThis.fetch(
            `${registryDaemon.baseUrl}/api/resources/fleet-client-state`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${registryDaemon.record.authToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                expectedInstanceId: registryDaemon.record.instanceId,
                change: { type: "visit", key },
              }),
              signal: globalThis.AbortSignal.timeout(5000),
            },
          );
          assert.equal(response.status, 200);
        }
      }
      receipt.nativeVisits = true;
      receipt.nativePreferences = true;
      receipt.nativeSavedProfileConnection = true;
      receipt.nativeReturnToLocal = true;
    }
    if (fleetAgents && index === 3) {
      assert(output.includes("NATIVE_FLEET_AGENT_SELECTED"));
      receipt.nativeFleetAgentSelection = true;
      assert(output.includes("NATIVE_REMOTE_PICKERS_SELECTED"));
      receipt.nativeRemotePickerSelection = true;
      assert(output.includes("NATIVE_REMOTE_WORKSPACE_AGENT_SELECTED"));
      receipt.nativeRemoteWorkspaceAgentSelection = true;
      assert(output.includes("NATIVE_REMOTE_TAB_ACTIVITY_VERIFIED"));
      receipt.nativeRemoteTabActivity = true;
    }
    if (index === 2) {
      assert(output.includes("NATIVE_CACHED_HISTORY_VERIFIED"));
      receipt.nativeCachedHistory = true;
    }
  }
  if (fleet) {
    assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
    receipt.realDaemonTerminalReady = true;
    receipt.sourcePaneUnchanged = true;
    receipt.nativeGuiJourney = Boolean(guiBinary) && !revokeProfile;
    receipt.physicalInputTested = false;
  } else assert(identityRequests >= 1 && authenticatedRequests === 1);
  receipt.passed = true;
} catch {
  receipt.failedPhase = phase;
} finally {
  clearInterval(timer);
  await captureFlight;
  let clean = !captureFailed;
  receipt.cleanupSteps = {
    capture: !captureFailed,
    processes: false,
    files: true,
    daemon: true,
    fleet: true,
  };
  try {
    await tracker.dispose();
    receipt.cleanupSteps.processes = true;
  } catch {
    receipt.processDiagnostics = tracker.snapshot().diagnostics;
    clean = false;
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  for (const owner of allocations.reverse()) {
    try {
      await owner.disposeFiles();
    } catch {
      receipt.cleanupSteps.files = false;
      clean = false;
    }
  }
  for (const ownedDaemon of [localDaemon, runningDaemon]) {
    try {
      await ownedDaemon?.stop();
    } catch {
      receipt.cleanupSteps.daemon = false;
      clean = false;
    }
  }
  for (const ownedFleet of [localFleet, fleet]) {
    try {
      await ownedFleet?.dispose();
    } catch {
      receipt.cleanupSteps.fleet = false;
      clean = false;
    }
  }
  receipt.cleanup = clean;
  receipt.identityRequests = cliPath ? null : identityRequests;
  receipt.authenticatedRequests = cliPath ? null : authenticatedRequests;
  writeFileSync(join(root, "qualification.json"), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...receipt, evidence: root }));
  if (!receipt.passed || !receipt.cleanup) process.exitCode = 1;
}
