import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import {
  startDaemon,
  waitForReadinessLadder,
} from "../../apps/desktop-renderer/e2e/fixtures/daemon.ts";
import { createIsolatedTargetedTuiCwd } from "../product-test-rig-journeys.mjs";
import { decodeFocusFramebufferCapture } from "./product-focus.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

test(
  "eight retained TUI processes recover across daemon and tmux authority replacement",
  {
    skip: process.env.TMUX_IDE_TUI_RECOVERY_LIVE !== "1",
    timeout: 180_000,
  },
  async (t) => {
    const termination = process.env.TMUX_IDE_TUI_RECOVERY_TERMINATION ?? "graceful";
    const namedSocket = process.env.TMUX_IDE_TUI_RECOVERY_SOCKET === "named";
    const coldStart = process.env.TMUX_IDE_TUI_RECOVERY_COLD === "1";
    assert.ok(!coldStart || namedSocket, "cold startup requires an owned named namespace");
    const cycles = Number(process.env.TMUX_IDE_TUI_RECOVERY_CYCLES ?? "1");
    assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 5);
    assert.ok(
      cycles === 1 || ["socket", "tmux-auto", "settings"].includes(termination),
      "repeated cycles require automatic tmux recovery",
    );
    assert.ok(
      ["graceful", "kill", "tmux", "tmux-auto", "socket", "settings"].includes(termination),
      "unknown recovery termination mode",
    );
    const root = mkdtempSync("/tmp/tmi-tui-recovery-");
    const report = {
      passed: false,
      termination,
      namedSocket,
      coldStart,
      cycles,
      frames: [],
      generations: [],
      cleanup: [],
    };
    const clients = new Map();
    const prepared = [];
    let fleet;
    let daemon;
    let hostPid;
    const productServerPids = [];
    let failure;
    const hostSocket = join(root, "host.sock");
    const command = (client, ...args) => {
      const environment = {
        ...process.env,
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TMUX_IDE_TESTDRIVE_RUNTIME_DIR: join(root, client),
        TMUX_IDE_TESTDRIVE_HOST_SESSION: `_recovery-${client}`,
        TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: hostSocket,
        TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
        TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
        TMUX_IDE_TESTDRIVE_CANONICAL_HOME: fleet.daemonInfoDir,
      };
      delete environment.NODE_TEST_CONTEXT;
      return execFileSync(process.execPath, [join(repo, "scripts/tui-testdrive.mjs"), ...args], {
        cwd: repo,
        encoding: "utf8",
        env: environment,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    };
    const native = (...args) =>
      execFileSync("tmux", ["-S", fleet.socketPath, ...args], {
        encoding: "utf8",
        timeout: 2_000,
      }).trimEnd();
    async function coherent(stage, marker, acknowledged) {
      const deadline = Date.now() + 30_000;
      for (const [client, identity] of clients) {
        let envelope;
        let lines;
        while (true) {
          const status = JSON.parse(command(client, "status", "--json"));
          assert.equal(status.processId, identity.processId);
          assert.equal(status.hostIdentity.paneId, identity.hostIdentity.paneId);
          assert.equal(status.hostIdentity.sessionId, identity.hostIdentity.sessionId);
          if (
            status.readiness?.activeGeneration === daemon.record.instanceId &&
            status.readiness?.generationStatus === "live"
          ) {
            assert.equal(status.daemon.pid, daemon.record.pid);
            envelope = JSON.parse(command(client, "capture", "--ansi", "--json"));
            assert.equal(envelope.hostIdentity.processId, identity.processId);
            lines = decodeFocusFramebufferCapture(envelope).plain.split("\n");
            if (
              lines.at(-2).includes(`${marker}-A`) &&
              lines.at(-2).includes(`${marker}-B`) &&
              (acknowledged === undefined ||
                lines.at(-2).includes(`${marker}-A ACK:${acknowledged} `))
            )
              break;
          }
          if (Date.now() >= deadline) {
            writeFileSync(
              join(root, `${stage}-${client}-failure.json`),
              JSON.stringify({ status, envelope }),
              { mode: 0o600 },
            );
            throw new Error(`${stage}/${client} did not recover coherent content`);
          }
          await delay(50);
        }
        assert.ok(lines.at(-1).includes("F5"));
        writeFileSync(join(root, `${stage}-${client}.json`), JSON.stringify(envelope), {
          mode: 0o600,
        });
        report.frames.push({
          stage,
          client,
          processId: identity.processId,
          generation: daemon.record.instanceId,
        });
      }
    }
    try {
      execFileSync("bun", [join(repo, "scripts/build-tui.mjs")], { cwd: repo, timeout: 120_000 });
      const scratch = await createScratchFleet({
        sessions: 1,
        windowsPerSession: 1,
        adoptSessions: true,
        slug: "recovery",
        namedSocket,
      });
      fleet = {
        ...scratch,
        environment: {
          ...scratch.environment,
          ...(namedSocket ? {} : { TMUX_IDE_TMUX_SOCKET_PATH: scratch.socketPath }),
        },
      };
      const session = fleet.sessionNames[0];
      if (coldStart) {
        const bootstrapPid = Number(native("display-message", "-p", "#{pid}"));
        native("kill-server");
        const deadline = Date.now() + 5_000;
        while (alive(bootstrapPid) && Date.now() < deadline) await delay(25);
        assert.ok(!alive(bootstrapPid));
        daemon = await startDaemon(fleet);
        assert.throws(() => native("-N", "list-sessions"), /no server|error connecting/);
        report.coldBootstrap = { bootstrapPid, absent: true, daemonPid: daemon.record.pid };
        fleet.createSession(session);
      }
      productServerPids.push(Number(native("display-message", "-p", "-t", session, "#{pid}")));
      const stageFile = join(root, "stage");
      const inputFile = join(root, "input.jsonl");
      writeFileSync(inputFile, "", { mode: 0o600 });
      writeFileSync(stageFile, "BEFORE", { mode: 0o600 });
      const fixture = join(root, "fixture.mjs");
      writeFileSync(
        fixture,
        `import {appendFileSync,readFileSync} from 'node:fs';
const label=process.argv[2];let previous='',received='';
const draw=()=>{const value=readFileSync(${JSON.stringify(stageFile)},'utf8');if(value===previous)return;previous=value;process.stdout.write('\\x1b[2J\\x1b[H'+label+'\\x1b['+process.stdout.rows+';1H'+value+'-'+label+' ACK:'+(received.split(';').length-1));};
process.stdin.setRawMode(true);process.stdin.on('data',data=>{received+=data.toString();appendFileSync(${JSON.stringify(inputFile)},JSON.stringify({label,data:data.toString()})+'\\n');previous='';draw();});
process.stdout.write('\\x1b[?1049h');process.on('SIGWINCH',()=>{previous='';draw();});draw();setInterval(draw,20);`,
        { mode: 0o600 },
      );
      const installPanes = () => {
        native("resize-window", "-t", session, "-x", "120", "-y", "36");
        native("split-window", "-d", "-h", "-t", session);
        const ids = native("list-panes", "-t", session, "-F", "#{pane_id}").split("\n");
        for (const [index, pane] of ids.entries())
          native(
            "respawn-pane",
            "-k",
            "-t",
            pane,
            `${quote(process.execPath)} ${quote(fixture)} ${index === 0 ? "A" : "B"}`,
          );
        return ids;
      };
      let panes = installPanes();
      daemon ??= await startDaemon(fleet);
      report.generations.push({ pid: daemon.record.pid, generation: daemon.record.instanceId });
      await daemon.promote(session);
      await waitForReadinessLadder(daemon);
      const geometry = () =>
        native(
          "list-panes",
          "-t",
          session,
          "-F",
          "#{pane_width} #{pane_height} #{pane_left} #{pane_top}",
        );
      const initialGeometry = geometry();
      for (let index = 0; index < 8; index++) {
        const client = `client-${index}`;
        createIsolatedTargetedTuiCwd(join(root, client));
        prepared.push(client);
        clients.set(
          client,
          JSON.parse(
            command(
              client,
              "start",
              "--target",
              session,
              "--cols",
              index % 2 ? "110" : "90",
              "--rows",
              index % 2 ? "32" : "24",
              "--json",
            ),
          ),
        );
        hostPid ??= Number(
          execFileSync("tmux", ["-S", hostSocket, "display-message", "-p", "#{pid}"], {
            encoding: "utf8",
            timeout: 2_000,
          }).trim(),
        );
        assert.ok(Number.isSafeInteger(hostPid) && hostPid > 0);
      }
      await coherent("before", "BEFORE");
      assert.equal(geometry(), initialGeometry);
      let expectedInput = "";
      for (let cycle = 0; cycle < cycles; cycle++) {
        const cycleTermination =
          termination === "settings" && cycle > 0 ? "tmux-auto" : termination;
        const afterMarker = cycles === 1 ? "AFTER" : `AFTER-${cycle}`;
        const old = daemon;
        const expectedAcknowledgements =
          cycleTermination === "tmux-auto" || cycleTermination === "tmux" ? 8 : 8 * (cycle + 1);
        if (cycleTermination === "settings") {
          const settingsPort = daemon.record.port;
          const previousGeneration = daemon.record.instanceId;
          const response = await fetch(`${daemon.baseUrl}/api/v2/action/app.setRemoteAccess`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${daemon.record.authToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ enabled: false }),
            signal: AbortSignal.timeout(2000),
          });
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.ok, true);
          writeFileSync(stageFile, afterMarker, { mode: 0o600 });
          await daemon.refreshGeneration();
          assert.notEqual(daemon.record.instanceId, previousGeneration);
          assert.equal(daemon.record.pid, report.generations[0].pid);
          assert.equal(daemon.record.port, settingsPort);
          report.generations.push({ pid: daemon.record.pid, generation: daemon.record.instanceId });
        } else if (cycleTermination === "socket") {
          const previousGeneration = daemon.record.instanceId;
          const previousPaneIds = native(
            "list-panes",
            "-t",
            session,
            "-F",
            "#{@tmux_ide_pane_id}",
          ).split("\n");
          const initialSocket = statSync(fleet.socketPath, { bigint: true });
          process.kill(productServerPids[0], "SIGUSR1");
          const deadline = Date.now() + 5_000;
          let changed = false;
          while (!changed && Date.now() < deadline) {
            try {
              const current = statSync(fleet.socketPath, { bigint: true });
              changed =
                current.ino !== initialSocket.ino ||
                current.mtimeNs !== initialSocket.mtimeNs ||
                current.birthtimeNs !== initialSocket.birthtimeNs;
            } catch {
              /* tmux may be between unlink and bind. */
            }
            if (!changed) await delay(25);
          }
          assert.ok(changed, "owned tmux socket was not recreated");
          assert.equal(Number(native("display-message", "-p", "#{pid}")), productServerPids[0]);
          writeFileSync(stageFile, afterMarker, { mode: 0o600 });
          await daemon.refreshGeneration();
          assert.notEqual(daemon.record.instanceId, previousGeneration);
          assert.equal(daemon.record.pid, report.generations[0].pid);
          report.generations.push({ pid: daemon.record.pid, generation: daemon.record.instanceId });
          report.socketRecreation = { previousPaneIds, serverPid: productServerPids[0] };
        } else if (cycleTermination === "tmux" || cycleTermination === "tmux-auto") {
          const previousPaneIds = native(
            "list-panes",
            "-t",
            session,
            "-F",
            "#{@tmux_ide_pane_id}",
          ).split("\n");
          const previousServerPid = productServerPids.at(-1);
          const previousRuntimeIds = [...panes];
          const inputBeforeReplacement = readFileSync(inputFile, "utf8");
          native("kill-server");
          const deadline = Date.now() + 5_000;
          while (alive(previousServerPid) && Date.now() < deadline) await delay(25);
          assert.ok(!alive(previousServerPid), "old product tmux server survived replacement");
          // Consume the old runtime IDs in a private holder, proving that clients
          // follow the recreated session rather than cached %pane targets.
          native("-f", "/dev/null", "new-session", "-d", "-s", "_recovery-holder");
          const highestPreviousPane = Math.max(
            ...previousRuntimeIds.map((id) => Number(id.slice(1))),
          );
          for (let index = 1; index <= highestPreviousPane; index++) {
            native("new-window", "-d", "-t", "_recovery-holder");
          }
          fleet.createSession(session);
          productServerPids.push(Number(native("display-message", "-p", "-t", session, "#{pid}")));
          writeFileSync(stageFile, afterMarker, { mode: 0o600 });
          panes = installPanes();
          // The old daemon is inode-fenced: it must not silently adopt a new
          // server at the same path. A fresh daemon generation pins that server.
          const unavailable = await fetch(`${old.baseUrl}/api/resources/fleet-catalog`, {
            headers: { Authorization: `Bearer ${old.record.authToken}` },
            signal: AbortSignal.timeout(2_000),
          });
          assert.equal(unavailable.status, 503);
          assert.deepEqual(await unavailable.json(), {
            error: "Tmux fleet discovery is unavailable",
            code: "tmux-unavailable",
          });
          report.retiredCatalogStatus = unavailable.status;
          command("client-0", "text", "STALE;");
          await delay(200);
          assert.equal(readFileSync(inputFile, "utf8"), inputBeforeReplacement);
          for (const pane of previousRuntimeIds)
            assert.doesNotMatch(native("capture-pane", "-p", "-t", pane), /STALE/);
          const previousGeneration = old.record.instanceId;
          if (cycleTermination === "tmux-auto") {
            await daemon.refreshGeneration();
            assert.equal(daemon.record.pid, report.generations[0].pid);
          } else {
            await old.stop();
            assert.ok(!alive(old.record.pid));
            daemon = await startDaemon(fleet);
          }
          assert.notEqual(daemon.record.instanceId, previousGeneration);
          report.generations.push({ pid: daemon.record.pid, generation: daemon.record.instanceId });
          if (cycleTermination !== "tmux-auto") await daemon.promote(session);
          report.tmuxReplacement = {
            previousPaneIds,
            previousRuntimeIds,
            nextRuntimeIds: [...panes],
            serverPids: [...productServerPids],
          };
          assert.ok(panes.every((id) => !previousRuntimeIds.includes(id)));
          report.tmuxReplacements ??= [];
          report.tmuxReplacements.push(report.tmuxReplacement);
        } else {
          if (cycleTermination === "kill") {
            // The PID comes from this test's own startDaemon child receipt.
            process.kill(old.record.pid, "SIGKILL");
            const deadline = Date.now() + 5_000;
            while (alive(old.record.pid) && Date.now() < deadline) await delay(25);
            assert.ok(!alive(old.record.pid), "owned daemon did not retire after SIGKILL");
          }
          await old.stop();
          assert.ok(!alive(old.record.pid));
          writeFileSync(stageFile, afterMarker, { mode: 0o600 });
          daemon = await startDaemon(fleet);
          assert.notEqual(daemon.record.instanceId, old.record.instanceId);
          report.generations.push({ pid: daemon.record.pid, generation: daemon.record.instanceId });
          await daemon.promote(session);
        }
        await waitForReadinessLadder(daemon);
        await coherent(`${cycle}-after`, afterMarker);
        if (report.socketRecreation) {
          const nextPaneIds = native(
            "list-panes",
            "-t",
            session,
            "-F",
            "#{@tmux_ide_pane_id}",
          ).split("\n");
          assert.deepEqual(nextPaneIds, report.socketRecreation.previousPaneIds);
          assert.equal(
            Number(native("display-message", "-p", "#{pid}")),
            report.socketRecreation.serverPid,
          );
          report.socketRecreation.nextPaneIds = nextPaneIds;
        }
        if (report.tmuxReplacement) {
          const nextPaneIds = native(
            "list-panes",
            "-t",
            session,
            "-F",
            "#{@tmux_ide_pane_id}",
          ).split("\n");
          assert.ok(
            nextPaneIds.every((id) => id && !report.tmuxReplacement.previousPaneIds.includes(id)),
          );
          report.tmuxReplacement.nextPaneIds = nextPaneIds;
        }
        for (const pane of panes)
          assert.match(native("capture-pane", "-p", "-t", pane), new RegExp(`${afterMarker}-[AB]`));
        assert.equal(geometry(), initialGeometry);
        for (const [index, client] of [...clients.keys()].entries()) {
          command(
            client,
            "input",
            JSON.stringify({
              version: 1,
              kind: "application-mouse",
              action: "click",
              x: 25,
              y: 2,
              button: "left",
            }),
          );
          const marker = `${cycle ? `C${cycle}` : ""}R${index};`;
          command(client, "text", marker);
          expectedInput += marker;
          const deadline = Date.now() + 5_000;
          while (true) {
            const records = readFileSync(inputFile, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            assert.ok(
              records.every((entry) => entry.label === "A"),
              "recovered input reached the wrong pane",
            );
            const received = records.map((entry) => entry.data).join("");
            if (received === expectedInput) break;
            assert.ok(
              expectedInput.startsWith(received),
              "recovered input was duplicated or reordered",
            );
            if (Date.now() >= deadline) {
              const capture = JSON.parse(command(client, "capture", "--ansi", "--json"));
              writeFileSync(join(root, `${client}-input-failure.json`), JSON.stringify(capture), {
                mode: 0o600,
              });
              writeFileSync(
                join(root, `${client}-input-failure.txt`),
                decodeFocusFramebufferCapture(capture).plain,
                { mode: 0o600 },
              );
              throw new Error(`${client} input did not recover`);
            }
            await delay(25);
          }
        }
        await coherent(`${cycle}-after-input`, afterMarker, expectedAcknowledgements);
        const finalInputs = readFileSync(inputFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(finalInputs.every((entry) => entry.label === "A"));
        assert.equal(finalInputs.map((entry) => entry.data).join(""), expectedInput);
        assert.match(
          native("capture-pane", "-p", "-t", panes[0]),
          new RegExp(`${afterMarker}-A ACK:${expectedAcknowledgements}`),
        );
        report.input = { clients: clients.size, targetPane: panes[0], received: expectedInput };
        assert.equal(geometry(), initialGeometry);
        const controls = native("list-clients", "-F", "#{client_pid} #{client_control_mode}")
          .split("\n")
          .filter((line) => line.endsWith(" 1"));
        assert.equal(controls.length, 1, "retired daemon generations left extra control clients");
        report.controlClients ??= [];
        report.controlClients.push({
          cycle,
          generation: daemon.record.instanceId,
          clients: controls,
        });
      }
      assert.equal(new Set(report.generations.map((g) => g.generation)).size, cycles + 1);
      report.passed = true;
    } catch (error) {
      failure = error;
      report.failure = error.message;
      if (daemon) {
        writeFileSync(join(root, "daemon-output.log"), daemon.output(), { mode: 0o600 });
        try {
          const response = await fetch(`${daemon.baseUrl}/api/resources/fleet-catalog`, {
            headers: { Authorization: `Bearer ${daemon.record.authToken}` },
            signal: AbortSignal.timeout(2_000),
          });
          report.catalogFailure = { status: response.status, body: await response.text() };
          report.nativeSessions = native(
            "list-panes",
            "-a",
            "-F",
            "#{session_name} #{pid} #{pane_id} #{@tmux_ide_adopted}",
          );
        } catch (diagnosticError) {
          report.diagnosticFailure = diagnosticError.message;
        }
      }
    } finally {
      const errors = [];
      for (const client of prepared) {
        try {
          command(client, "stop");
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await daemon?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await fleet?.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (hostPid) {
        const deadline = Date.now() + 2_000;
        while (alive(hostPid) && Date.now() < deadline) await delay(25);
        if (!alive(hostPid)) rmSync(hostSocket, { force: true });
      }
      for (const entry of [
        ...report.generations.map((g) => ({ role: g.generation, pid: g.pid })),
        ...[...clients].map(([role, c]) => ({ role, pid: c.processId })),
        ...(hostPid ? [{ role: "host-tmux", pid: hostPid }] : []),
        ...productServerPids.map((pid) => ({ role: "product-tmux", pid })),
      ]) {
        const absent = !alive(entry.pid);
        report.cleanup.push({ ...entry, absent });
        if (!absent) errors.push(new Error(`${entry.role} survived cleanup`));
      }
      if (existsSync(hostSocket) || (fleet && existsSync(fleet.socketPath)))
        errors.push(new Error("private tmux socket survived cleanup"));
      if (errors.length) {
        report.passed = false;
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...errors],
          "recovery cleanup failed",
        );
      }
      writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
      t.diagnostic(`TUI recovery evidence: ${root}`);
    }
    if (failure) throw failure;
  },
);
