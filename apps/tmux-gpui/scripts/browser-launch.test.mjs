import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  realpath,
  mkdir,
  cp,
  copyFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { TERMINAL_BROWSER_LAUNCHER } from "./browser-payload.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const run = promisify(execFile);
const payload = process.env.TMUX_IDE_BROWSER_LAUNCH_TEST_PAYLOAD;

test(
  "a Node-less app runs the browser on its engine, from an unrelated cwd with spaces, and reuses its verified engine",
  {
    skip: !payload || process.platform !== "darwin",
    timeout: 60000,
  },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser launch test ")));
    try {
      const resources = join(root, "Test App.app/Contents/Resources");
      const home = join(root, "isolated home");
      await mkdir(resources, { recursive: true });
      await mkdir(home);
      await cp(payload, join(resources, "browser"), { recursive: true });
      // The default app bundles no Node. The payload gets this checkout's launcher and
      // scripts, as a rebuilt payload would (the assembler refuses an older launcher).
      const launcher = join(resources, "browser/terminal-browser");
      await writeFile(launcher, TERMINAL_BROWSER_LAUNCHER, { mode: 0o755 });
      for (const name of [
        "browser-launch.mjs",
        "browser-runtime-load.mjs",
        "browser-runtime-extract.mjs",
      ])
        await copyFile(new URL(`./${name}`, import.meta.url), join(resources, "browser", name));
      assert.deepEqual(await readdir(resources), ["browser"]);
      const temporary = join(root, "tmp");
      await mkdir(temporary);
      const options = {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          TMPDIR: temporary,
          PATH: "/usr/bin:/bin",
          NODE_OPTIONS: "--invalid-inherited-flag",
        },
        timeout: 30000,
      };
      const first = await run(launcher, ["--version"], options);
      assert.match(first.stdout, /^terminal-browser tmux-ide-development\n$/);
      const second = await run(
        join(resources, "browser/bin/terminal-browser"),
        ["--help"],
        options,
      );
      assert.match(second.stdout, /terminal-browser/);
      const cache = join(home, "Library/Caches/tmux-ide-browser-engine");
      assert.equal((await readdir(cache)).length, 1);
      // The first launch's private engine copy is gone once the launcher exits.
      assert.deepEqual(await readdir(temporary), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// The launcher runs an engine only after codesign accepts it for the browser's
// identity. An ad hoc signed fake engine stands in for a tampered cache or archive.
const MARKER = "UNVERIFIED-ENGINE-RAN";
async function fakeEngine(parent, body = `echo ${MARKER}`) {
  const app = join(parent, "terminal-browser.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/terminal-browser"), `#!/bin/sh\n${body}\n`, {
    mode: 0o755,
  });
  await run("/usr/bin/codesign", ["-s", "-", app]);
  return app;
}
async function launcherLayout(root, digest, archive) {
  const browser = join(root, "Test App.app/Contents/Resources/browser");
  await mkdir(browser, { recursive: true });
  await writeFile(join(browser, "terminal-browser"), TERMINAL_BROWSER_LAUNCHER, { mode: 0o755 });
  await writeFile(join(browser, "runtime.json"), JSON.stringify({ sha256: digest }));
  await writeFile(join(browser, "browser-runtime.tar.gz"), archive ?? "not an archive");
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  await mkdir(home);
  await mkdir(temporary);
  return { launcher: join(browser, "terminal-browser"), home, temporary };
}
async function refused(layout) {
  const result = await run(layout.launcher, ["--version"], {
    env: { HOME: layout.home, TMPDIR: layout.temporary, PATH: "/usr/bin:/bin" },
    timeout: 30000,
  }).then(
    (done) => ({ code: 0, ...done }),
    (error) => error,
  );
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.stdout, new RegExp(MARKER));
  assert.deepEqual(await readdir(layout.temporary), []);
  return result.stderr;
}
const digestOf = async (path) =>
  (await run("/usr/bin/shasum", ["-a", "256", path])).stdout.split(" ")[0];

test(
  "an unverified engine in the cache is never run",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser launch cache ")));
    try {
      const digest = "a".repeat(64);
      const layout = await launcherLayout(root, digest);
      await fakeEngine(join(layout.home, "Library/Caches/tmux-ide-browser-engine", digest));
      assert.match(await refused(layout), /does not match its metadata/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "an unverified engine in a matching archive is never run",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser launch archive ")));
    try {
      const source = join(root, "source");
      await fakeEngine(source);
      const archive = join(root, "runtime.tar.gz");
      await run("/usr/bin/tar", ["-czf", archive, "-C", source, "terminal-browser.app"]);
      const layout = await launcherLayout(root, await digestOf(archive));
      await cp(archive, join(dirname(layout.launcher), "browser-runtime.tar.gz"));
      assert.match(await refused(layout), /browser runtime signature is not valid/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "a runtime digest that is not 64 hex digits is refused before any path is built",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    for (const digest of ["../" + "a".repeat(61), "abc"]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "browser launch digest ")));
      try {
        const layout = await launcherLayout(root, digest);
        assert.match(await refused(layout), /invalid runtime metadata/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "a hangup during the first launch leaves no private engine copy",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "browser launch hangup ")));
    try {
      // Many files keep the unpack running, so a cleanup that races tar can lose.
      const source = join(root, "source");
      const app = await fakeEngine(source);
      const filler = join(app, "Contents/Resources/filler");
      await mkdir(filler, { recursive: true });
      const block = Buffer.alloc(64 * 1024, 7);
      for (let i = 0; i < 3000; i++) await writeFile(join(filler, `f${i}`), block);
      const archive = join(root, "runtime.tar.gz");
      await run("/usr/bin/tar", ["-czf", archive, "-C", source, "terminal-browser.app"]);
      const layout = await launcherLayout(root, await digestOf(archive));
      await cp(archive, join(dirname(layout.launcher), "browser-runtime.tar.gz"));
      const child = spawn(layout.launcher, ["--version"], {
        env: { HOME: layout.home, TMPDIR: layout.temporary, PATH: "/usr/bin:/bin" },
        stdio: "ignore",
      });
      // Hang up the launcher alone while it waits on its tar child, as a closed
      // terminal can. tar keeps running, so wait for it too before looking.
      const tarOf = async () =>
        (
          await run("/usr/bin/pgrep", ["-P", String(child.pid), "-x", "tar"]).catch(() => ({
            stdout: "",
          }))
        ).stdout.trim();
      let tar = "";
      for (let i = 0; i < 400 && !(tar = await tarOf()); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(tar, "the unpack was never observed");
      // The private copy lives in a fresh mktemp directory only this user can enter.
      const [staging, ...others] = await readdir(layout.temporary);
      assert.deepEqual(others, []);
      assert.match(staging, /^tmux-ide-browser\.[A-Za-z0-9]{6}$/);
      assert.notEqual(staging, "tmux-ide-browser.XXXXXX");
      assert.equal((await stat(join(layout.temporary, staging))).mode & 0o777, 0o700);
      child.kill("SIGHUP");
      await new Promise((resolve) => child.on("exit", resolve));
      for (let i = 0; i < 1000; i++) {
        const alive = await run("/bin/kill", ["-0", tar]).then(
          () => true,
          () => false,
        );
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.deepEqual(await readdir(layout.temporary), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
