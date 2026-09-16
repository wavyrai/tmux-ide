/* global process, console, Buffer, setTimeout, fetch, AbortSignal */
/** Actual installed CLI + standalone TUI probe; never uses source dependencies or Bun. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const root = "/opt/installed/node_modules/tmux-ide";
const cli = `${root}/bin/cli.js`;
const tmux = `${root}/packages/daemon/dist/native/tmux/${process.platform}-${process.arch}/tmux`;
const state = `/state/packed-${randomUUID()}`;
mkdirSync(state, { mode: 0o700 });
const socket = `${state}/s`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("TMUX") &&
      !key.startsWith("GIT_") &&
      key !== "NODE_OPTIONS" &&
      key !== "NODE_PATH",
  ),
);
Object.assign(env, {
  TMUX_IDE_RUNTIME_MODE: "test",
  TMUX_IDE_HOME: state,
  TMUX_IDE_TMUX_SOCKET_PATH: socket,
  TMUX_IDE_CLEANUP_TOKEN: randomUUID(),
  TMUX_IDE_TUI_BIN: "/opt/fixture/tmux-ide-tui",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
});
const call = (args) =>
  execFileSync(tmux, ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, description, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(100);
  }
  throw Error(`Timed out: ${description}`);
}
assert.equal(process.getuid(), 1000);
assert(!existsSync("/usr/local/bin/bun"));
assert(!existsSync("/opt/source-snapshot"));
const pty = createRequire(`${root}/package.json`)("node-pty");
let owner,
  app,
  output = "",
  daemonOutput = "",
  serverPid,
  panePid,
  appExited = false;
const receipt = {
  version: 1,
  ok: false,
  node: process.version,
  abi: process.versions.modules,
  arch: process.arch,
  acquisition: "explicit-qualified-standalone-artifact",
  sourceDependencies: false,
};
try {
  const doctor = JSON.parse(
    execFileSync(process.execPath, [cli, "doctor", "--json"], {
      env,
      cwd: "/workspace",
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  assert.equal(doctor.ok, true, "configless installed doctor");
  receipt.doctorOk = true;
  call(["-f", "/dev/null", "new-session", "-d", "-s", "shared", "-x", "120", "-y", "36", "sh"]);
  serverPid = Number(call(["display-message", "-p", "#{pid}"]));
  panePid = Number(call(["display-message", "-p", "-t", "shared:0.0", "#{pane_pid}"]));
  owner = spawn(process.execPath, [cli, "--headless", "--json"], {
    env,
    cwd: "/workspace",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [owner.stdout, owner.stderr])
    stream.on("data", (data) => {
      daemonOutput = (daemonOutput + data.toString()).slice(-65536);
    });
  await wait(() => existsSync(`${state}/daemon.json`), "canonical daemon record");
  const info = JSON.parse(readFileSync(`${state}/daemon.json`, "utf8"));
  await wait(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${info.port}/health`, {
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        })
      ).ok;
    } catch {
      return false;
    }
  }, "daemon health");
  app = pty.spawn(process.execPath, [cli, "app", "shared"], {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd: "/workspace",
    env,
  });
  app.onData((data) => {
    output = (output + data).slice(-2 * 1024 * 1024);
  });
  app.onExit(() => {
    appExited = true;
  });
  await wait(() => {
    if (appExited) throw Error("Installed app exited early");
    return output.includes("shared");
  }, "installed app session frame");
  await pause(700);
  app.write("\x1b[<0;50;7M\x1b[<0;50;7m");
  await pause(200);
  app.write("printf 'd09_packed_\\157k\\n'\r");
  await wait(
    // eslint-disable-next-line no-control-regex
    () => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").includes("d09_packed_ok"),
    "actual installed TUI input echo",
  );
  assert.equal(Number(call(["display-message", "-p", "-t", "shared:0.0", "#{pane_pid}"])), panePid);
  Object.assign(receipt, {
    runtimePassed: true,
    daemonPid: owner.pid,
    tmuxPid: serverPid,
    panePid,
    inputEcho: true,
    frameBytes: Buffer.byteLength(output),
  });
} catch (error) {
  receipt.error = error.message;
} finally {
  const cleanup = {
    appExited: !app,
    daemonExited: !owner,
    tmuxGone: !serverPid,
    paneGone: !panePid,
    errors: [],
  };
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  };
  const attempt = async (name, action) => {
    try {
      await action();
    } catch (error) {
      cleanup.errors.push({ step: name, error: error.message });
    }
  };
  await attempt("app", async () => {
    if (app) {
      app.write("\x11");
      await pause(300);
      if (!appExited) app.kill();
      await wait(() => appExited, "app cleanup", 5000);
      await wait(() => gone(app.pid), "app process gone", 5000);
    }
    cleanup.appExited = true;
  });
  await attempt("daemon", async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGTERM");
      await wait(
        () => owner.exitCode !== null || owner.signalCode !== null,
        "daemon cleanup",
        10000,
      );
    }
    if (owner) await wait(() => gone(owner.pid), "daemon process gone", 5000);
    cleanup.daemonExited = true;
  });
  await attempt("tmux", async () => {
    if (serverPid && !gone(serverPid)) {
      call(["if-shell", "-F", `#{==:#{pid},${serverPid}}`, "kill-server"]);
      await wait(() => gone(serverPid), "tmux process gone", 5000);
    }
    cleanup.tmuxGone = true;
  });
  await attempt("pane", async () => {
    if (panePid) await wait(() => gone(panePid), "pane process gone", 5000);
    cleanup.paneGone = true;
  });
  receipt.cleanup = cleanup;
  receipt.ok =
    receipt.runtimePassed === true &&
    cleanup.errors.length === 0 &&
    cleanup.appExited &&
    cleanup.daemonExited &&
    cleanup.tmuxGone &&
    cleanup.paneGone;
  writeFileSync("/evidence/packed-frame.txt", output, { mode: 0o600 });
  writeFileSync("/evidence/packed-owner.log", daemonOutput, { mode: 0o600 });
  writeFileSync("/evidence/packed-qualification.json", JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify(receipt));
if (!receipt.ok) process.exitCode = 1;
