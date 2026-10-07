#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, cpus, platform, release, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  REPORT_VERSION,
  comparativeTargetOrder,
  nowMs,
  delay,
  shellQuote,
  isolatedEnv,
  createScreen,
  validateOptions,
  tuiRendererConfiguration,
  artifact,
  assertTuiArtifactAdmission,
  retireOwnedProcess,
  retirePrivateTmux,
} from "./comparative-terminal-support.mjs";
import {
  typingScenario,
  typingGeometryReady,
  parseTypingPaneCreation,
  assertTypingFrame,
  floodIdentity,
  typingAttempts,
  observeTypingAttempt,
  finishTypingAttempts,
} from "./comparative-terminal-scenario.mjs";
import { sampleProcessTree } from "./lib/comparative-terminal-resources.mjs";
import { renderComparativeTerminalReport } from "./lib/comparative-terminal-report.mjs";
const execute = promisify(execFile);
const require = createRequire(new URL("../packages/daemon/package.json", import.meta.url));
const pty = require("node-pty");
const producer = fileURLToPath(new URL("./comparative-terminal-producer.mjs", import.meta.url));
const command = (binary, args, env, cwd) =>
  execute(binary, args, { env, cwd, timeout: 5000, maxBuffer: 1024 * 1024 }).then(
    (result) => result.stdout,
  );
async function until(check, description, timeout = 30000) {
  const deadline = nowMs() + timeout;
  while (nowMs() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

export async function runTarget(target, options, directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "tmi-cmp-"));
  const session = `compare-${randomUUID().slice(0, 8)}`;
  const socket = join(root, "tmux.sock");
  const receipt = join(directory, "producer.jsonl");
  const scenario = typingScenario(options);
  let attempts = [],
    lastFrame;
  if (scenario) writeFileSync(join(directory, "scenario.json"), JSON.stringify(scenario, null, 2));
  const env = isolatedEnv(process.env, root);
  for (const path of [env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR, join(env.XDG_CONFIG_HOME, "herdr")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const report = {
    target,
    scenario,
    coherenceRejected: 0,
    inputMode: options.inputMode ?? "line",
    requestedTuiRenderer:
      target === "tmux-ide" ? tuiRendererConfiguration(options.tuiRenderer) : null,
    root,
    session,
    status: "failed",
    samples: [],
    resizeSamples: [],
    resources: [],
    observations: [],
    owned: [],
    cleanup: [],
    outerGeometry: null,
    contentGeometry: null,
    outputBytes: 0,
    loadBefore: loadavg(),
  };
  const owned = [];
  let client,
    screen,
    tmuxPid,
    last,
    failure,
    producerPid,
    producerBirth,
    tmuxBirth,
    nativePaneTarget;
  let clientExited = false;
  let tmuxAttempted = false;
  let cols = scenario
    ? scenario.outerGeometries[target].cols
    : options.cols + (target === "tmux" ? 0 : 28);
  let rows = scenario
    ? scenario.outerGeometries[target].rows
    : options.rows + (target === "tmux" ? 1 : 5);
  const start = nowMs();
  const tmux = (...args) =>
    command(options.binaries.tmux, ["-S", socket, "-f", "/dev/null", ...args], env, root);
  function own(binary, args) {
    const log = openSync(join(directory, `process-${owned.length}.log`), "w", 0o600);
    const child = spawn(binary, args, { env, cwd: root, stdio: ["ignore", log, log] });
    closeSync(log);
    child.on("error", (error) => {
      failure = error;
    });
    owned.push(child);
    report.owned.push({ pid: child.pid, binary, args });
    return child;
  }
  function healthy() {
    if (failure) throw failure;
    if (owned.some((child) => child.exitCode !== null || child.signalCode !== null))
      throw new Error("Owned server/daemon exited; replacement is forbidden");
    if (clientExited) throw new Error("Owned PTY client exited");
  }
  async function cleanup() {
    async function retire(pid, exited, signal) {
      try {
        const outcome = await retireOwnedProcess({ exited, signal }, async () => {
          try {
            await until(exited, "owned process exit", 2000);
            return true;
          } catch {
            return false;
          }
        });
        report.cleanup.push({ pid, outcome });
      } catch (error) {
        report.cleanup.push({ pid, error: String(error) });
        report.status = "failed";
        report.cleanupFailed = true;
      }
    }
    if (client)
      await retire(
        client.pid,
        () => clientExited,
        (signal) => client.kill(signal),
      );
    for (const child of owned)
      await retire(
        child.pid,
        () => child.exitCode !== null || child.signalCode !== null,
        (signal) => child.kill(signal),
      );
    if (tmuxAttempted) {
      try {
        if (
          scenario &&
          tmuxBirth &&
          (await command("/bin/ps", ["-p", String(tmuxPid), "-o", "lstart="], env, root)).trim() !==
            tmuxBirth
        )
          throw Error("Private server birth changed; cleanup refused");
        const identity = await retirePrivateTmux(tmux, tmuxPid, session);
        report.cleanup.push({ ...identity, socket, action: "verified-private-tmux-kill-server" });
        if (scenario) {
          await until(
            () => {
              try {
                process.kill(identity.pid, 0);
                return false;
              } catch (error) {
                if (error.code === "ESRCH") return true;
                throw error;
              }
            },
            "private server absence",
            3000,
          );
          report.cleanup.push({ pid: identity.pid, absent: true });
          // tmux may leave an inert socket file; test server absence via private socket too.
          try {
            await tmux("has-session");
            throw Error("Private server still responds after cleanup");
          } catch (error) {
            if (error.code !== 1) throw error;
          }
          report.cleanup.push({
            socket,
            serverResponds: false,
            socketFileRemains: existsSync(socket),
          });
        }
      } catch (error) {
        report.cleanup.push({ error: String(error) });
        report.status = "failed";
        report.cleanupFailed = true;
      }
    }
    if (scenario && producerPid) {
      try {
        await until(
          () => {
            try {
              process.kill(producerPid, 0);
              return false;
            } catch (error) {
              if (error.code === "ESRCH") return true;
              throw error;
            }
          },
          "owned producer absence",
          3000,
        );
        report.cleanup.push({ pid: producerPid, birth: producerBirth, absent: true });
      } catch (error) {
        report.cleanup.push({ pid: producerPid, error: String(error) });
        report.status = "failed";
        report.cleanupFailed = true;
      }
    }
    try {
      if (scenario && screen) {
        let timer;
        try {
          await Promise.race([
            screen.drain(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error("Parser cleanup deadline")), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      } else await screen?.drain();
    } finally {
      screen?.dispose();
    }
  }
  const signal = () => {
    failure = new Error("Interrupted");
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    const producerCommand =
      (scenario ? "exec " : "") +
      [
        process.execPath,
        producer,
        receipt,
        options.inputMode ?? "line",
        ...(scenario ? [scenario.kind] : []),
      ]
        .map(shellQuote)
        .join(" ");
    let binary, args;
    if (target === "herdr") {
      env.HERDR_SESSION = session;
      env.HERDR_DISABLE_SOUND = "1";
      writeFileSync(
        join(env.XDG_CONFIG_HOME, "herdr", "config.toml"),
        'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n',
      );
      own(options.binaries.herdr, ["--session", session, "server"]);
      await until(async () => {
        healthy();
        try {
          await command(options.binaries.herdr, ["pane", "list"], env, root);
          return true;
        } catch {
          return false;
        }
      }, "owned Herdr server API readiness");

      binary = options.binaries.herdr;
      args = ["--session", session, "client"];
    } else {
      env.TMUX_IDE_TMUX_SOCKET_PATH = socket;
      env.TMUX_IDE_TMUX_BIN = options.binaries.tmux;
      env.PATH = `${dirname(options.binaries.tmux)}:${env.PATH}`;
      tmuxAttempted = true;
      const launchedPid = await tmux(
        "new-session",
        "-P",
        "-F",
        scenario ? "#{pid}|#{pane_pid}|#{pane_id}" : "#{pid}",
        "-d",
        "-s",
        session,
        "-x",
        String(cols),
        "-y",
        String(rows),
        producerCommand,
      );
      const creation = launchedPid.trim().split("|");
      tmuxPid = Number(creation[0]);
      if (scenario) {
        const owned = parseTypingPaneCreation(launchedPid);
        if (owned.serverPid !== tmuxPid) throw Error("Creation server identity mismatch");
        producerPid = owned.producerPid;
        nativePaneTarget = owned.paneTarget;
        if (!Number.isSafeInteger(producerPid) || producerPid <= 0)
          throw Error("Missing creation-owned pane PID");
        producerBirth = (
          await command("/bin/ps", ["-p", String(producerPid), "-o", "lstart="], env, root)
        ).trim();
        if (!producerBirth) throw Error("Missing creation-owned pane birth");
        report.producerIdentity = {
          pid: producerPid,
          birth: producerBirth,
          paneTarget: nativePaneTarget,
        };
      }
      if (!Number.isSafeInteger(tmuxPid) || tmuxPid <= 0) throw new Error("No private tmux PID");
      if (scenario)
        tmuxBirth = (
          await command("/bin/ps", ["-p", String(tmuxPid), "-o", "lstart="], env, root)
        ).trim();
      report.owned.push({ pid: tmuxPid, socket, birth: tmuxBirth });
      binary = options.binaries.tmux;
      args = ["-S", socket, "attach-session", "-t", session];
      if (target === "tmux-ide") {
        env.TMUX_IDE_HOME = root;
        env.TMUX_IDE_DAEMON_INFO_DIR = root;
        env.TMUX_IDE_TUI_BIN = options.binaries.tui;
        Object.assign(env, tuiRendererConfiguration(options.tuiRenderer).environment);
        const daemon = own(process.execPath, [options.binaries.cli, "--headless", "--json"]);
        await until(async () => {
          healthy();
          try {
            const info = JSON.parse(readFileSync(join(root, "daemon.json"), "utf8"));
            return (
              info.pid === daemon.pid &&
              (
                await fetch(`http://127.0.0.1:${info.port}/healthz`, {
                  signal: AbortSignal.timeout(1000),
                })
              ).ok
            );
          } catch {
            return false;
          }
        }, "exact owned daemon readiness");
        // Own the actual renderer PID. The CLI can spawn a compiled TUI child;
        // observing launcher exit alone does not prove that client was retired.
        binary = options.binaries.tui;
        args = ["app", `--target=${session}`];
      }
    }
    report.provisionedMs = nowMs() - start;
    const launchAt = nowMs();
    screen = createScreen(
      cols,
      rows,
      (reply) => client?.write(reply),
      (marker, atMs, frame) => {
        lastFrame = frame;
        if (marker) {
          last = marker;
          if (scenario && marker.cols === options.cols && marker.rows === options.rows) {
            try {
              const flood = floodIdentity(frame, scenario.contentRects[target]);
              if (scenario.kind === "quiet-typing" && flood !== 0)
                throw Error("Unexpected quiet output");
              assertTypingFrame(
                frame,
                scenario.contentRects[target],
                options.cols,
                options.rows,
                marker.sequence,
                flood,
              );
              report.observations.push({ ...marker, flood, atMs, coherent: true });
              observeTypingAttempt(attempts, marker.sequence, atMs);
            } catch {
              report.coherenceRejected++;
            }
          } else if (!scenario) report.observations.push({ ...marker, atMs });
        }
      },
      Boolean(scenario),
    );
    client = pty.spawn(binary, args, { name: "xterm-256color", cols, rows, cwd: root, env });
    report.owned.push({ pid: client.pid, binary, args });
    client.onExit(() => {
      clientExited = true;
    });
    client.onData((data) => {
      report.outputBytes += Buffer.byteLength(data);
      if (report.outputBytes > 16 * 1024 * 1024) {
        failure = new Error("Output capture budget exceeded");
        return;
      }
      appendFileSync(join(directory, "wire.ansi"), data);
      void screen.write(data).catch((error) => {
        failure = error;
      });
    });
    if (target === "herdr") {
      let paneId;
      await until(async () => {
        healthy();
        try {
          const panes = JSON.parse(
            await command(options.binaries.herdr, ["pane", "list"], env, root),
          );
          paneId = panes.result?.panes?.[0]?.pane_id;
          return Boolean(paneId);
        } catch {
          return false;
        }
      }, "Herdr pane ready");
      await command(options.binaries.herdr, ["pane", "run", paneId, producerCommand], env, root);
    }
    await until(() => {
      healthy();
      return last?.sequence === 0;
    }, "visible producer readiness");
    if (scenario) {
      const receivedProducerPid = Number(readFileSync(`${receipt}.pid`, "utf8"));
      if (receivedProducerPid !== producerPid)
        throw Error("Producer receipt PID differs from creation-owned pane");
      if (!Number.isSafeInteger(producerPid) || producerPid <= 0)
        throw Error("Invalid producer identity");
      const readyBirth = (
        await command("/bin/ps", ["-p", String(producerPid), "-o", "lstart="], env, root)
      ).trim();
      if (readyBirth !== producerBirth) throw Error("Producer birth changed before readiness");
      if (!producerBirth) throw Error("Missing producer birth");
      report.producerIdentity = {
        pid: producerPid,
        birth: producerBirth,
        paneTarget: nativePaneTarget,
      };
    }
    if (scenario)
      report.startupScope = "marker readiness; full-cell scene qualified separately before input";
    report.startupMs = nowMs() - start;
    report.clientLaunchToProducerReadyMs = nowMs() - launchAt;
    await delay(300);
    if (scenario) {
      report.outerGeometry = { cols, rows };
      await until(
        async () => {
          healthy();
          const native = (
            await tmux(
              "display-message",
              "-p",
              "-t",
              nativePaneTarget,
              "#{pane_width}|#{pane_height}",
            )
          ).trim();
          report.geometryAdmission = { native, marker: last, outer: { cols, rows } };
          return typingGeometryReady(native, last, lastFrame, scenario.contentRects[target]);
        },
        "fixed native and coherent content geometry",
        5000,
      );
    } else
      for (
        let attempt = 0;
        attempt < 4 && (last.cols !== options.cols || last.rows !== options.rows);
        attempt++
      ) {
        cols += options.cols - last.cols;
        rows += options.rows - last.rows;
        last = null;
        screen.resize(cols, rows);
        client.resize(cols, rows);
        await until(
          () => {
            healthy();
            return last !== null;
          },
          "matched content geometry",
          5000,
        );
        await delay(300);
      }
    if (last.cols !== options.cols || last.rows !== options.rows)
      throw new Error("Could not match content geometry");
    const sampleResources = async (phase) => {
      if (!options.resources) return;
      const producerPid = Number(readFileSync(`${receipt}.pid`, "utf8"));
      if (!Number.isSafeInteger(producerPid) || producerPid <= 0)
        throw new Error("Invalid producer PID");
      const sample = await sampleProcessTree(
        report.owned.map((item) => item.pid),
        [producerPid],
      );
      report.resources.push({ phase, ...sample });
      if (sample.missingRootPids.length) throw new Error("Owned resource roots disappeared");
    };
    await sampleResources("before-input");
    report.outerGeometry = { cols, rows };
    report.contentGeometry = { cols: last.cols, rows: last.rows };
    if (scenario) {
      const rect = scenario.contentRects[target];
      // Fixed declared crop, not a search for a region that happens to match.
      assertTypingFrame(lastFrame, rect, options.cols, options.rows, 0, 0);
      const nativeGeometry = (
        await tmux("display-message", "-p", "-t", nativePaneTarget, "#{pane_width}|#{pane_height}")
      ).trim();
      if (nativeGeometry !== `${options.cols}|${options.rows}`)
        throw Error("Native content geometry mismatch");
      const nativeCheckpoint = async (name, sequence, flood) => {
        const ansi = await tmux(
          "capture-pane",
          "-p",
          "-e",
          "-N",
          "-S",
          "0",
          "-t",
          nativePaneTarget,
        );
        const cursor = (
          await tmux(
            "display-message",
            "-p",
            "-t",
            nativePaneTarget,
            "#{cursor_x}|#{cursor_y}|#{cursor_flag}",
          )
        )
          .trim()
          .split("|")
          .map(Number);
        if (
          cursor.length !== 3 ||
          cursor.some((v) => !Number.isSafeInteger(v)) ||
          ![0, 1].includes(cursor[2])
        )
          throw Error("Invalid native cursor");
        writeFileSync(join(directory, `native-${name}.ansi`), ansi);
        let captured;
        const parser = createScreen(
          options.cols,
          options.rows,
          () => {},
          (_marker, _at, value) => {
            captured = value;
          },
          true,
        );
        try {
          // Native captures are stable baseline/final checkpoints, outside the timed input path.
          await parser.write(
            "\x1b[?7l\x1b[H" +
              ansi.replace(/\n$/, "").replaceAll("\n", "\r\n") +
              `\x1b[${cursor[1] + 1};${cursor[0] + 1}H\x1b[?25${cursor[2] === 1 ? "h" : "l"}`,
          );
          assertTypingFrame(captured, { x: 0, y: 0 }, options.cols, options.rows, sequence, flood);
          (report.nativeCheckpoints ??= []).push({
            name,
            sequence,
            flood,
            cursor,
            scope: "native ANSI capture and cursor through stock parser against literal cells",
          });
        } finally {
          parser.dispose();
        }
      };
      await nativeCheckpoint("baseline", 0, 0);
      const scheduledStart = nowMs() + 100;
      attempts = typingAttempts(scheduledStart);
      report.samples = attempts;
      client.write("CBSTART\r");
      for (const attempt of attempts) {
        await delay(Math.max(0, attempt.offeredAtMs - nowMs()));
        healthy();
        attempt.inputAtMs = nowMs();
        attempt.scheduleDelayMs = attempt.inputAtMs - attempt.offeredAtMs;
        attempt.status = "pending";
        client.write(`CBINPUT:${String(attempt.sequence).padStart(6, "0")}\r`);
      }
      // Drain a fixed deadline, independent of intermediate acknowledgements.
      const deadline = attempts.at(-1).inputAtMs + scenario.completionDeadlineMs;
      while (nowMs() < deadline && attempts.some((item) => item.status === "pending")) {
        healthy();
        await delay(10);
      }
      report.inputDenominator = finishTypingAttempts(attempts);
      // Flood completes its declared finite offered schedule before final oracle.
      if (scenario.kind === "flood-typing")
        await until(
          () => {
            healthy();
            const lines = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
            return lines.some(
              (item) => item.kind === "flood" && item.flood === scenario.floodTicks,
            );
          },
          "finite flood completion",
          6000,
        );
      await screen.drain();
      const received = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
      report.producer = received;
      const inputs = received.filter((item) => item.sequence !== undefined);
      if (inputs.length !== 102 || inputs.some((item, index) => item.sequence !== index + 1))
        throw Error("Producer input mismatch");
      const tokens = received.filter((item) => item.kind === "input-token");
      if (
        tokens.length !== 102 ||
        tokens.some(
          (item, index) =>
            item.hex !==
            Buffer.from(`CBINPUT:${String(index + 1).padStart(6, "0")}\r`).toString("hex"),
        )
      )
        throw Error("Producer exact input bytes/order mismatch");
      const floods = received.filter((item) => item.kind === "flood");
      if (
        scenario.kind === "flood-typing" &&
        (floods.length !== 152 || floods.some((item, index) => item.flood !== index + 1))
      )
        throw Error("Flood schedule mismatch");
      report.offeredLoad = {
        floodTicks: floods.length,
        bytesPerTick: scenario.floodBytes,
        backpressuredWrites: floods.filter((item) => !item.writable).length,
        maxProducerScheduleDelayMs: Math.max(0, ...floods.map((item) => item.scheduleDelayMs)),
        maxInputScheduleDelayMs: Math.max(...attempts.map((item) => item.scheduleDelayMs)),
      };
      await until(
        () => {
          healthy();
          try {
            assertTypingFrame(
              lastFrame,
              rect,
              options.cols,
              options.rows,
              102,
              scenario.kind === "flood-typing" ? 152 : 0,
            );
            return true;
          } catch {
            return false;
          }
        },
        "final full scene",
        5000,
      );
      report.finalFrame = lastFrame;
      await nativeCheckpoint("final", 102, scenario.kind === "flood-typing" ? 152 : 0);
      if (report.inputDenominator.failed)
        throw Error("Missing coherent input witnesses; all attempts retained");
      // Missing an entire offered interval is an explicit workload mismatch, not a faster result.
      report.offeredLoad.qualified =
        report.offeredLoad.maxProducerScheduleDelayMs < scenario.floodIntervalMs &&
        report.offeredLoad.maxInputScheduleDelayMs < scenario.inputIntervalMs &&
        report.offeredLoad.backpressuredWrites === 0;
      if (!report.offeredLoad.qualified)
        throw Error("Offered interval missed or output backpressured; matched load not qualified");
    } else {
      for (let sequence = 1; sequence <= options.samples + 2; sequence++) {
        healthy();
        const atMs = nowMs();
        client.write(
          options.inputMode === "key" ? "x" : `CBINPUT:${String(sequence).padStart(6, "0")}\r`,
        );
        await until(
          () => {
            healthy();
            return last?.sequence === sequence;
          },
          `echo ${sequence}`,
          5000,
        );
        const shown = report.observations.find(
          (item) => item.sequence === sequence && item.atMs >= atMs,
        );
        if (!shown || shown.cols !== options.cols || shown.rows !== options.rows)
          throw new Error("Incorrect echo or geometry");
        report.samples.push({
          sequence,
          warmup: sequence <= 2,
          inputAtMs: atMs,
          visibleAtMs: shown.atMs,
          latencyMs: shown.atMs - atMs,
        });
      }
      const received = readFileSync(receipt, "utf8").trim().split("\n").map(JSON.parse);
      if (
        received.length !== options.samples + 2 ||
        received.some((item, index) => item.sequence !== index + 1)
      )
        throw new Error("Producer input mismatch");
      report.producer = received;
    }
    await sampleResources("after-input");
    for (let index = 0; index < (options.resizeSamples ?? 0); index++) {
      healthy();
      const width = options.cols + (index % 2 === 0 ? 4 : 0);
      const height = options.rows + (index % 2 === 0 ? 2 : 0);
      const outerCols = report.outerGeometry.cols + width - options.cols;
      const outerRows = report.outerGeometry.rows + height - options.rows;
      last = null;
      const atMs = nowMs();
      screen.resize(outerCols, outerRows);
      client.resize(outerCols, outerRows);
      await until(
        () => {
          healthy();
          return (
            last?.cols === width && last?.rows === height && last?.sequence === options.samples + 2
          );
        },
        `resize ${index}`,
        5000,
      );
      const shown = report.observations.find(
        (item) =>
          item.atMs >= atMs &&
          item.cols === width &&
          item.rows === height &&
          item.sequence === options.samples + 2,
      );
      if (!shown) throw new Error("Resize marker missing");
      report.resizeSamples.push({
        index,
        cols: width,
        rows: height,
        inputAtMs: atMs,
        visibleAtMs: shown.atMs,
        latencyMs: shown.atMs - atMs,
      });
    }
    await sampleResources("after-resize");
    report.status = "passed";
  } catch (error) {
    if (scenario) {
      report.failedFrame = lastFrame;
      if (!attempts.length) attempts = typingAttempts(0);
      report.samples = attempts;
      report.inputDenominator = finishTypingAttempts(attempts);
    }
    report.error = String(error.stack ?? error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      report.status = "failed";
      report.cleanupFailed = true;
      report.cleanup.push({ error: String(error) });
    }
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    report.loadAfter = loadavg();
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
}

export async function main(options, output) {
  options = { ...options, inputMode: options.inputMode === undefined ? "line" : options.inputMode };
  const artifacts = validateOptions(options);
  for (const [name, entry] of Object.entries(artifacts)) {
    entry.sourceProvenance =
      options.provenance?.[name] ??
      "unverified: binary hash identifies artifact; checkout equivalence unknown";
    if (name === "tui" && options.requiredTuiNativeRenderer) {
      const provenance = JSON.parse(
        await command(
          entry.resolved,
          ["__release-provenance"],
          process.env,
          dirname(entry.resolved),
        ),
      );
      entry.verifiedReleaseProvenance = assertTuiArtifactAdmission(
        provenance,
        options.provenance?.tui,
        entry,
      );
      continue;
    }
    if (name === "tui") {
      entry.versionUnavailable =
        "No automatic version probe: older renderer entries may start a client; supply provenance explicitly";
      continue;
    }
    const binary = name === "cli" ? process.execPath : entry.resolved;
    const args =
      name === "cli" ? [entry.resolved, "--version"] : [name === "tmux" ? "-V" : "--version"];
    try {
      entry.versionOutput = (
        await command(binary, args, process.env, dirname(entry.resolved))
      ).trim();
    } catch (error) {
      entry.versionUnavailable = String(error.message);
    }
  }

  if (existsSync(join(output, "report.json")))
    throw new Error("Output already contains a report; choose a fresh directory");
  mkdirSync(output, { recursive: true });
  const report = {
    schemaVersion: REPORT_VERSION,
    scenarioDescriptor: typingScenario(options),
    scenario:
      options.scenario ??
      (options.inputMode === "key" ? "startup-and-key-echo" : "startup-and-line-echo"),
    artifacts,
    nodeArtifact: artifact(process.execPath),
    producerArtifact: artifact(producer),
    sourceArtifacts: options.scenario
      ? Object.fromEntries(
          [
            ["scenario", new URL("./comparative-terminal-scenario.mjs", import.meta.url)],
            ["support", new URL("./comparative-terminal-support.mjs", import.meta.url)],
            ["runner", import.meta.url],
            ["report", new URL("./lib/comparative-terminal-report.mjs", import.meta.url)],
            ["lock", new URL("../pnpm-lock.yaml", import.meta.url)],
          ].map(([name, url]) => [name, artifact(fileURLToPath(url))]),
        )
      : undefined,
    parserArtifact: options.scenario
      ? artifact(require.resolve("@xterm/headless-stock"))
      : undefined,
    options,
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      node: process.version,
    },
    oracle: "stock xterm-headless6 parse completion; not physical refresh",
    limitations: options.scenario
      ? [
          "Input-to-PTY-consumed coherent full-cell output, not physical paint or16.67ms framebuffer budget",
          "One local pane only; no SSH,15-pane or native parity qualification",
          "Fixed offered schedules retained with actual delay/backpressure; coalesced/missing witnesses fail denominator",
          "Outer chrome geometry differs; content geometry and declared crop must qualify",
          "Resource samples sum process RSS and are not physical footprint",
        ]
      : [
          "Startup includes adapter provisioning and is not equivalent cold attach",
          "Herdr onboarding disabled; shell fixed to /bin/sh",
          "Sequential acknowledged echoes with two warmups; no throughput ranking",
          "Marker correctness does not qualify whole-frame coherence or physical scrolling smoothness",
          "Resource snapshots report summed RSS (shared pages may be counted more than once); not physical footprint or a leak soak",
          "Resize checks marker geometry, not complete-frame correctness",
          "Scrolling, sustained output, multi-client and remote qualification remain pending",
        ],
    runs: [],
  };
  for (let round = 0; round < options.rounds; round++) {
    const order = comparativeTargetOrder(options.targets, round);
    for (const target of order) {
      report.runs.push(await runTarget(target, options, join(output, `round-${round}-${target}`)));
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
      writeFileSync(join(output, "report.md"), renderComparativeTerminalReport(report));
    }
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error(
      "Usage: node scripts/comparative-terminal.mjs /absolute/options.json /absolute/output-directory",
    );
    process.exitCode = 2;
  } else
    main(JSON.parse(readFileSync(process.argv[2], "utf8")), resolve(process.argv[3]))
      .then((report) => {
        console.log(
          JSON.stringify({
            report: join(resolve(process.argv[3]), "report.json"),
            statuses: report.runs.map(({ target, status }) => ({ target, status })),
          }),
        );
        if (report.runs.some((run) => run.status !== "passed")) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
}
