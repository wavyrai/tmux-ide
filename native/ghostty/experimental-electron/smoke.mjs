// Isolated real-daemon/native-view acceptance. Does not touch the user's daemon.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(repo, "apps/electron-shell/package.json"));
const { build } = require("esbuild");
const root = mkdtempSync("/tmp/tmi-native-ghostty-smoke-");
const tmux = resolve(repo, "packages/daemon/dist/native/tmux/darwin-arm64/tmux");
const socket = join(root, "tmux.sock");
const addon = process.env.TMUX_IDE_GHOSTTY_ADDON;
assert.ok(addon && existsSync(addon), "Set TMUX_IDE_GHOSTTY_ADDON to compiled addon.");
const owned = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, label) {
  for (let i = 0; i < 300; i++) {
    if (await read()) return;
    await wait(100);
  }
  throw new Error("Timed out: " + label);
}
const env = { ...process.env };
for (const dir of ["home", "state", "daemon", "registry", "settings"])
  mkdirSync(join(root, dir), { mode: 0o700 });
Object.assign(env, {
  HOME: join(root, "home"),
  TMUX_IDE_HOME: join(root, "state"),
  TMUX_IDE_DAEMON_INFO_DIR: join(root, "daemon"),
  TMUX_IDE_REGISTRY_DIR: join(root, "registry"),
  TMUX_IDE_SETTINGS_DIR: join(root, "settings"),
  TMUX_IDE_TMUX_BIN: tmux,
  TMUX_IDE_TMUX_SOCKET_PATH: socket,
});
delete env.TMUX;
delete env.TMUX_PANE;
delete env.TMUX_IDE_TMUX_SOCKET_NAME;
function run(args) {
  return execFileSync(tmux, ["-S", socket, "-f", "/dev/null", ...args], {
    env,
    encoding: "utf8",
  }).trim();
}
function start(command, args, name, extra = {}) {
  const fd = openSync(join(root, name + ".log"), "w");
  const child = spawn(command, args, {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  owned.push(child);
  return child;
}
try {
  const adapter = join(root, "daemon-stream.cjs");
  await build({
    entryPoints: [join(repo, "native/ghostty/experimental-electron/daemon-stream.ts")],
    outfile: adapter,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const pane = run([
    "new-session",
    "-d",
    "-s",
    "native-proof",
    "-x",
    "100",
    "-y",
    "30",
    "-P",
    "-F",
    "#{pane_id}",
    "/bin/cat",
  ]);
  env.TMUX = socket + "," + run(["display-message", "-p", "-t", pane, "#{pid}"]) + ",0";
  run(["set-option", "-p", "-t", pane, "@tmux_ide_pane_id", "pane.native.proof"]);
  run(["send-keys", "-t", pane, "NATIVE_SEED_PROOF", "Enter"]);
  writeFileSync(
    join(root, "registry/workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          name: "native-proof",
          sessionName: "native-proof",
          projectDir: root,
          ideConfigPath: null,
          addedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  start(process.execPath, [join(repo, "bin/cli.js"), "--headless", "--json"], "daemon");
  const info = join(root, "daemon/daemon.json");
  await until(() => existsSync(info), "daemon startup");
  const result = join(root, "native");
  const electron = start(
    require("electron"),
    [join(repo, "native/ghostty/experimental-electron/probe.cjs")],
    "electron",
    {
      TMUX_IDE_GHOSTTY_ADDON: addon,
      TMUX_IDE_GHOSTTY_STREAM_MODULE: adapter,
      TMUX_IDE_GHOSTTY_DAEMON_INFO: info,
      TMUX_IDE_GHOSTTY_WORKSPACE: "native-proof",
      TMUX_IDE_GHOSTTY_PANE: "pane.native.proof",
      TMUX_IDE_GHOSTTY_PROBE_RESULT: result,
    },
  );
  await until(() => {
    if (electron.exitCode !== null && electron.exitCode !== 0)
      throw new Error(readFileSync(join(root, "electron.log"), "utf8"));
    return readFileSync(join(root, "electron.log"), "utf8").includes("native-ready");
  }, "native stream startup");
  run(["send-keys", "-t", pane, "NATIVE_LIVE_PROOF", "Enter"]);
  await until(() => existsSync(result + ".json"), "native result");
  await until(() => electron.exitCode !== null, "Electron disposal");
  assert.equal(electron.exitCode, 0);
  const proof = JSON.parse(readFileSync(result + ".json", "utf8"));
  assert.match(proof.text, /NATIVE_SEED_PROOF/);
  assert.match(proof.text, /NATIVE_LIVE_PROOF/);
  assert.equal(proof.metrics.foregroundPid, 0);
  assert.equal(proof.metrics.columns, 100);
  assert.equal(
    proof.metrics.rows,
    Number(run(["display-message", "-p", "-t", pane, "#{pane_height}"])),
  );
  assert.equal(proof.metrics.inputFailed, false);
  assert.ok(proof.metrics.fedBytes > 0);
  console.log(JSON.stringify({ passed: true, root, metrics: proof.metrics }));
} finally {
  for (const child of owned.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child.once("exit", r)), wait(2000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  try {
    run(["kill-server"]);
  } catch {
    /* private server may already have stopped */
  }
}
