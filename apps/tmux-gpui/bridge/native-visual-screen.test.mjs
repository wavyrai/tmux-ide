import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { visualScreen } from "./native-visual-screen.mjs";
test("specimen keeps Unicode, colored blanks, wrap and cursor explicit at multiple sizes", () => {
  for (const [cols, rows] of [
    [64, 20],
    [80, 24],
    [132, 40],
  ]) {
    const { bytes, expected } = visualScreen(cols, rows);
    assert.ok(bytes.includes("e\u0301 A\u030a"));
    assert.ok(bytes.includes("界語") && bytes.includes("😀 🚀"));
    assert.ok(bytes.includes("WRAP>" + "w".repeat(cols - 5) + "WRAP_END"));
    assert.ok(bytes.includes("\x1b[48;2;192;32;160m        \x1b[0m"));
    assert.ok(bytes.endsWith("\x1b[17;9H\x1b[?25h"));
    assert.deepEqual(expected.cursor, { x: 8, y: 16, visible: true });
    assert.ok(Buffer.byteLength(bytes) < 8192);
    assert.match(expected.visualVerdict, /unassessed/);
  }
});
test("unsupported geometry fails instead of silently clipping the specimen", () => {
  for (const [cols, rows] of [
    [63, 20],
    [80, 19],
    [513, 24],
    [80, 257],
    [NaN, 24],
    [80.5, 24],
  ])
    assert.throws(() => visualScreen(cols, rows), /requires/);
});

test(
  "actual PTY resize redraws the specimen with current stdout geometry",
  { skip: !process.env.TMUX_GPUI_TEST_TMUX, timeout: 20000 },
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath, URL } = await import("node:url");
    const directory = mkdtempSync("/tmp/gpui-visual-resize-");
    const socket = join(directory, "tmux.sock");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("TMUX") && !["NODE_OPTIONS", "NODE_PATH"].includes(key),
      ),
    );
    Object.assign(env, { HOME: directory, XDG_CONFIG_HOME: directory, TERM: "xterm-256color" });
    const run = (...args) =>
      execFileSync(process.env.TMUX_GPUI_TEST_TMUX, ["-S", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    let serverPid;
    try {
      run(
        "new-session",
        "-d",
        "-s",
        "specimen",
        "-x",
        "80",
        "-y",
        "24",
        `${quote(process.execPath)} ${quote(fileURLToPath(new URL("./native-visual-screen.mjs", import.meta.url)))}`,
      );
      serverPid = run("display-message", "-p", "#{pid}");
      assert.match(serverPid, /^\d+$/);
      for (const cols of [80, 92, 80]) {
        run("resize-window", "-t", "specimen:0", "-x", String(cols), "-y", "24");
        const deadline = Date.now() + 4000;
        const expected = "WRAP>" + "w".repeat(cols - 5) + "WRAP_END";
        let observed;
        do {
          const capture = run("capture-pane", "-p", "-J", "-t", "specimen:0.0");
          observed = capture.split("\n").find((line) => line.startsWith("WRAP>"));
          if (observed === expected) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        assert.equal(
          run("display-message", "-p", "-t", "specimen:0.0", "#{pane_width}"),
          String(cols),
        );
        assert.equal(observed, expected, `exact wrap text must reflect current ${cols}-column PTY`);
      }
    } finally {
      try {
        // The fresh private directory owns this explicit socket even if the PID query failed.
        if (existsSync(socket)) run("kill-server");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
