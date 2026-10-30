import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, mkdir, cp, copyFile, readdir, rm, writeFile } from "node:fs/promises";
import { TERMINAL_BROWSER_LAUNCHER } from "./browser-payload.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
