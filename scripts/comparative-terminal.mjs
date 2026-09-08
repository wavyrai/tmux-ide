#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
  nowMs,
  delay,
  shellQuote,
  isolatedEnv,
  createScreen,
  validateOptions,
  artifact,
  retireOwnedProcess,
  retirePrivateTmux,
} from "./comparative-terminal-support.mjs";
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
  const env = isolatedEnv(process.env, root);
  for (const path of [env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR, join(env.XDG_CONFIG_HOME, "herdr")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const report = {
    target,
    inputMode: options.inputMode ?? "line",
    root,
    session,
    status: "failed",
    samples: [],
    observations: [],
    owned: [],
    cleanup: [],
    outerGeometry: null,
    contentGeometry: null,
    outputBytes: 0,
    loadBefore: loadavg(),
  };
  const owned = [];
  let client, screen, tmuxPid, last, failure;
  let clientExited = false;
  let tmuxAttempted = false;
  let cols = options.cols + (target === "tmux" ? 0 : 28);
  let rows = options.rows + (target === "tmux" ? 1 : 5);
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
        const identity = await retirePrivateTmux(tmux, tmuxPid, session);
        report.cleanup.push({ ...identity, socket, action: "verified-private-tmux-kill-server" });
      } catch (error) {
        report.cleanup.push({ error: String(error) });
        report.status = "failed";
        report.cleanupFailed = true;
      }
    }
    await screen?.drain();
    screen?.dispose();
  }
  const signal = () => {
    failure = new Error("Interrupted");
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    const producerCommand = [process.execPath, producer, receipt, options.inputMode ?? "line"]
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
        "#{pid}",
        "-d",
        "-s",
        session,
        "-x",
        String(cols),
        "-y",
        String(rows),
        producerCommand,
      );
      tmuxPid = Number(launchedPid.trim());
      if (!Number.isSafeInteger(tmuxPid) || tmuxPid <= 0) throw new Error("No private tmux PID");
      report.owned.push({ pid: tmuxPid, socket });
      binary = options.binaries.tmux;
      args = ["-S", socket, "attach-session", "-t", session];
      if (target === "tmux-ide") {
        env.TMUX_IDE_HOME = root;
        env.TMUX_IDE_DAEMON_INFO_DIR = root;
        env.TMUX_IDE_TUI_BIN = options.binaries.tui;
        env.TMUX_IDE_NATIVE_SCROLL_PROTOTYPE = "0";
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
      (marker, atMs) => {
        if (marker) {
          last = marker;
          report.observations.push({ ...marker, atMs });
        }
      },
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
    report.startupMs = nowMs() - start;
    report.clientLaunchToProducerReadyMs = nowMs() - launchAt;
    await delay(300);
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
    report.outerGeometry = { cols, rows };
    report.contentGeometry = { cols: last.cols, rows: last.rows };
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
    report.status = "passed";
  } catch (error) {
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
    if (name === "tui") {
      entry.versionUnavailable = "No version probe: renderer entry may start a client";
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

  mkdirSync(output, { recursive: true });
  const report = {
    schemaVersion: REPORT_VERSION,
    scenario: options.inputMode === "key" ? "startup-and-key-echo" : "startup-and-line-echo",
    artifacts,
    nodeArtifact: artifact(process.execPath),
    producerArtifact: artifact(producer),
    options,
    host: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      node: process.version,
    },
    oracle: "stock xterm-headless6 parse completion; not physical refresh",
    limitations: [
      "Startup includes adapter provisioning and is not equivalent cold attach",
      "Herdr onboarding disabled; shell fixed to /bin/sh",
      "Sequential acknowledged echoes with two warmups; no throughput ranking",
      "Marker correctness does not qualify whole-frame coherence or physical scrolling smoothness",
      "Resource and remote scenarios are pending",
    ],
    runs: [],
  };
  for (let round = 0; round < options.rounds; round++) {
    const order = round % 2 ? [...options.targets].reverse() : options.targets;
    for (const target of order) {
      report.runs.push(await runTarget(target, options, join(output, `round-${round}-${target}`)));
      writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
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
