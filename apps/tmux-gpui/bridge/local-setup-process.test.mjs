// Real source browser with an owned fake managed CLI. Never starts a daemon or tmux.
import { test } from "node:test";
import process from "node:process";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  copyFile,
  rm,
  readdir,
  realpath,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopFixtureChild } from "./fixture-child.mjs";

test("source browser setup requires explicit action, fences duplicates and cancellation, and exposes retry after failure", async () => {
  const root = await realpath(await mkdtemp("/tmp/gpui-setup-process-"));
  const managed = join(root, ".local/share/tmux-ide");
  const release = join(managed, "releases/install-test123");
  const pkg = join(release, "npm/lib/node_modules/tmux-ide");
  const records = join(root, "records"),
    registry = join(root, "registry");
  const log = join(root, "calls.jsonl"),
    mode = join(root, "mode");
  let child,
    fatal,
    latest,
    buffer = "",
    diagnostics = 0,
    closing = false;
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  async function until(predicate) {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (fatal) throw fatal;
      assert.ok(Date.now() < deadline, "setup fixture deadline");
      await delay(20);
    }
  }
  try {
    for (const dir of [
      join(pkg, "bin"),
      join(release, "node/bin"),
      records,
      registry,
      join(root, "tmp"),
    ])
      await mkdir(dir, { recursive: true });
    await copyFile(process.execPath, join(release, "node/bin/node"), constants.COPYFILE_FICLONE);
    await writeFile(join(managed, "installer-v1"), "1\n");
    await writeFile(join(release, ".installer-release-v1"), "1\n");
    await symlink(release, join(managed, "current"));
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "tmux-ide", version: "2.9.7", bin: { "tmux-ide": "bin/cli.js" } }),
    );
    await writeFile(log, "");
    await writeFile(mode, "wait");
    await writeFile(
      join(pkg, "bin/cli.js"),
      `const fs=require('node:fs');
const args=process.argv.slice(2); fs.appendFileSync(process.env.SETUP_FIXTURE_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='--version') console.log('tmux-ide v2.9.7');
else if(fs.readFileSync(process.env.SETUP_FIXTURE_MODE,'utf8')==='fail') process.exitCode=1;
else setInterval(()=>{},1000);
`,
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith("TMUX") &&
          ![
            "NODE_OPTIONS",
            "NODE_PATH",
            "HOME",
            "TMPDIR",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_CACHE_HOME",
          ].includes(key),
      ),
    );
    Object.assign(env, {
      HOME: root,
      TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      TMUX_IDE_HOME: join(root, "state"),
      TMUX_IDE_CONFIG: join(root, "config.json"),
      TMUX_IDE_SETTINGS_DIR: join(root, "settings"),
      TMUX_IDE_DAEMON_INFO_DIR: records,
      TMUX_IDE_REGISTRY_DIR: registry,
      TMUX_IDE_TMUX_SOCKET_PATH: join(root, "unused.sock"),
      SETUP_FIXTURE_LOG: log,
      SETUP_FIXTURE_MODE: mode,
    });
    child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("apps/tmux-gpui/bridge/browser.ts"),
        "--local",
      ],
      { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.on("error", () => {
      fatal = new Error("fixture spawn");
    });
    child.on("exit", () => {
      if (!closing) fatal = new Error("early browser exit");
    });
    for (const stream of [child.stdin, child.stdout, child.stderr])
      stream.on("error", () => {
        fatal = new Error("fixture stream");
      });
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk.length;
      if (diagnostics > 65536) fatal = new Error("diagnostic bound");
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try {
        buffer += chunk;
        assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024);
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          latest = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      } catch {
        fatal = new Error("invalid publication");
      }
    });
    send({ type: "presence", active: true, revision: 1 });
    await until(() => latest?.localSetup?.phase === "available");
    assert.deepEqual(await calls(), [], "discovery must not execute CLI");
    send({ type: "local-setup", request: 99 });
    await delay(100);
    assert.deepEqual(await calls(), [], "stale request must not execute CLI");
    send({ type: "local-setup", request: 0 });
    await until(
      async () => latest?.localSetup?.phase === "running" && (await calls()).length === 2,
    );
    send({ type: "local-setup", request: 0 });
    send({ type: "local-setup", request: 0 });
    await delay(100);
    assert.equal((await calls()).length, 2, "one version probe and one update only");
    send({ type: "presence", active: false, revision: 2 });
    await until(() => latest?.presenceRevision === 2 && latest.localSetup === null);
    await writeFile(mode, "fail");
    send({ type: "presence", active: true, revision: 3 });
    await until(() => latest?.localSetup?.phase === "available");
    assert.equal((await calls()).length, 2, "foreground restoration must not auto-start");
    send({ type: "local-setup", request: 0 });
    await until(() => latest?.localSetup?.phase === "failed");
    assert.deepEqual(await calls(), [
      ["--version"],
      ["update", "--daemon", "--json"],
      ["--version"],
      ["update", "--daemon", "--json"],
    ]);
    assert.equal(latest.request, 0);
    assert.equal(latest.inputReady, false);
    assert.equal(latest.snapshot, null);
    assert.deepEqual(await readdir(records), []);
    assert.deepEqual(await readdir(registry), []);
  } finally {
    closing = true;
    await stopFixtureChild(child);
    await rm(root, { recursive: true, force: true });
  }
});
