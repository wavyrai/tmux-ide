import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import stringWidth from "string-width";

import { decodeFocusFramebufferCapture } from "./lib/product-focus.mjs";
import { runBoundedFocusTmux } from "./lib/product-focus-tmux.mjs";

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

test("capture --ansi --json returns one exact rectangular 160x44 tmux frame", () => {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const socket = join(tmpdir(), `tmux-ide-cap-${suffix}.sock`);
  const session = `cap-${suffix}`;
  const runtimeDir = mkdtempSync(join(tmpdir(), "tmux-ide-capture-runtime-"));
  const document = "wide界\ncombining e\u0301\ntrailing   ";
  try {
    run("tmux", [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "160",
      "-y",
      "44",
      "/bin/sh",
      "-c",
      `printf '\\033[2J\\033[H%s' '${document}'; exec sleep 30`,
    ]);
    run("tmux", ["-S", socket, "set-option", "-t", session, "status", "off"]);
    run("sleep", ["0.1"]);
    const stdout = run(
      process.execPath,
      ["scripts/tui-testdrive.mjs", "capture", "--ansi", "--json"],
      {
        env: {
          ...process.env,
          TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: socket,
          TMUX_IDE_TESTDRIVE_HOST_SESSION: session,
          TMUX_IDE_TESTDRIVE_RUNTIME_DIR: runtimeDir,
        },
      },
    );
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.cols, 160);
    assert.equal(envelope.rows, 44);
    assert.equal(envelope.ansi.split("\n").length, 44);
    assert.equal(
      envelope.ansi.split("\n").every((line) => stringWidth(line) <= 160),
      true,
    );
    assert.equal(
      envelope.ansi.split("\n").some((line) => line === ""),
      true,
    );
    assert.equal(
      envelope.ansi.split("\n").some((line) => /^trailing {3,}$/u.test(line)),
      true,
    );
    const decoded = decodeFocusFramebufferCapture(envelope);
    const lines = decoded.plain.split("\n");
    assert.equal(lines.length, 44);
    assert.equal(
      lines.every((line) => stringWidth(line) === 160),
      true,
    );
    assert.match(lines.join("\n"), /wide界/u);
    assert.match(lines.join("\n"), /combining é/u);
    assert.match(lines.join("\n"), /trailing {3}/u);
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-server"], { timeout: 2_000 });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("capture bounds a hung host identity query and leaves no tmux child", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-capture-hang-"));
  const fakeBin = join(root, "bin");
  const pidPath = join(root, "tmux.pid");
  try {
    run("mkdir", ["-p", fakeBin]);
    const fakeTmux = join(fakeBin, "tmux");
    writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s' "$$" > "${pidPath}"\nexec sleep 30\n`);
    chmodSync(fakeTmux, 0o700);
    const startedAt = performance.now();
    const result = spawnSync(
      process.execPath,
      ["scripts/tui-testdrive.mjs", "capture", "--ansi", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 4_000,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: join(root, "host.sock"),
          TMUX_IDE_TESTDRIVE_HOST_SESSION: "hung-host",
          TMUX_IDE_TESTDRIVE_RUNTIME_DIR: join(root, "runtime"),
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.ok(performance.now() - startedAt < 3_000);
    const pid = Number(readFileSync(pidPath, "utf8"));
    run("sleep", ["0.05"]);
    assert.throws(() => process.kill(pid, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focus target tmux reads share a bounded abort and reap a hung child", async () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-focus-target-hang-"));
  const fakeTmux = join(root, "tmux");
  try {
    writeFileSync(fakeTmux, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(fakeTmux, 0o700);
    const controller = new AbortController();
    const startedAt = performance.now();
    let spawnedPid = null;
    await assert.rejects(
      runBoundedFocusTmux({
        socketPath: join(root, "target.sock"),
        args: ["list-panes"],
        deadline: performance.now() + 500,
        signal: controller.signal,
        binary: fakeTmux,
        onSpawn: (child) => {
          assert.equal(Number.isSafeInteger(child.pid), true);
          spawnedPid = child.pid;
        },
      }),
    );
    controller.abort();
    assert.ok(performance.now() - startedAt < 1_500);
    assert.equal(Number.isSafeInteger(spawnedPid), true);
    run("sleep", ["0.05"]);
    assert.throws(() => process.kill(spawnedPid, 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
