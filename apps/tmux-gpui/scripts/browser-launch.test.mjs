import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, mkdir, cp, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = promisify(execFile);
const payload = process.env.TMUX_IDE_BROWSER_LAUNCH_TEST_PAYLOAD;

test(
  "bundled entrypoint works from an unrelated cwd with spaces and reuses its verified engine",
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
      await copyFile(process.execPath, join(resources, "node"));
      const launcher = join(resources, "browser/terminal-browser");
      const options = {
        cwd: root,
        env: { ...process.env, HOME: home, NODE_OPTIONS: "--invalid-inherited-flag" },
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
