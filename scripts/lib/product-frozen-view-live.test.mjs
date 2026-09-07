import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import {
  startDaemon,
  waitForReadinessLadder,
} from "../../apps/desktop-renderer/e2e/fixtures/daemon.ts";
import { createIsolatedTargetedTuiCwd } from "../product-test-rig-journeys.mjs";
import { decodeFocusFramebufferCapture } from "./product-focus.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

for (const entry of ["selection", "wheel", "wheel-emacs"])
  for (const border of ["off", "top", "bottom"])
    test(
      `two real TUI clients retain frozen reading through ${entry} and resize with ${border} borders`,
      {
        skip: process.env.TMUX_IDE_FROZEN_VIEW_LIVE !== "1",
        timeout: 120_000,
      },
      async (t) => {
        const root = mkdtempSync("/tmp/tmi-frozen-view-");
        const hostSocket = join(root, "host.sock");
        const stage = join(root, "stage");
        const configPath = join(root, "app-config.json");
        writeFileSync(configPath, JSON.stringify({ theme: { mode: "dark" } }), { mode: 0o600 });
        writeFileSync(stage, "HOLD", { mode: 0o600 });
        const report = { passed: false, frames: [], cleanup: [] };
        const clients = new Map();
        const prepared = [];
        let fleet;
        let daemon;
        let hostPid;
        let targetPid;
        let failure;
        const command = (client, ...args) => {
          const environment = {
            ...process.env,
            TERM: "xterm-256color",
            TMUX_IDE_CONFIG: configPath,
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
            TMUX_IDE_TESTDRIVE_RUNTIME_DIR: join(root, client),
            TMUX_IDE_TESTDRIVE_HOST_SESSION: `_frozen-${client}`,
            TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: hostSocket,
            TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
            TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
            TMUX_IDE_TESTDRIVE_CANONICAL_HOME: fleet.daemonInfoDir,
          };
          delete environment.NODE_TEST_CONTEXT;
          return execFileSync(
            process.execPath,
            [join(repo, "scripts/tui-testdrive.mjs"), ...args],
            {
              cwd: repo,
              encoding: "utf8",
              env: environment,
              timeout: 30_000,
              maxBuffer: 4 * 1024 * 1024,
            },
          );
        };
        const native = (...args) =>
          execFileSync("tmux", ["-S", fleet.socketPath, ...args], {
            encoding: "utf8",
            timeout: 2_000,
          }).trimEnd();
        async function frame(client, label, expected, held, settled = () => true) {
          const deadline = Date.now() + 10_000;
          let envelope;
          let plain;
          while (true) {
            envelope = JSON.parse(command(client, "capture", "--ansi", "--json"));
            plain = decodeFocusFramebufferCapture(envelope).plain;
            if (
              plain.includes(expected) &&
              settled(plain) &&
              plain.trimEnd().split("\n").at(-1).includes("F5") &&
              (held === undefined ||
                (plain.includes("Esc live") ||
                  plain.includes("Esc: live") ||
                  plain.includes("copy vi")) === held)
            )
              break;
            if (Date.now() >= deadline) {
              writeFileSync(join(root, `${label}-${client}-failure.txt`), plain);
              throw new Error(
                `${label}/${client} did not settle ${expected}, held=${held}, and footer`,
              );
            }
            await delay(50);
          }
          assert.equal(envelope.hostIdentity.processId, clients.get(client).processId);
          assert.ok(plain.trimEnd().split("\n").at(-1).includes("F5"), "footer remains visible");
          writeFileSync(join(root, `${label}-${client}.json`), JSON.stringify(envelope), {
            mode: 0o600,
          });
          report.frames.push({ client, label, expected, held });
          return plain;
        }
        try {
          execFileSync("bun", [join(repo, "scripts/build-tui.mjs")], {
            cwd: repo,
            timeout: 120_000,
          });
          const history =
            entry !== "selection"
              ? "process.stdout.write(Array.from({length:80},(_,i)=>'HOLD_ANCHOR old history '+i+' 界é\\r\\n').join(''));"
              : "";
          const clear =
            entry !== "selection"
              ? "if(stage==='LIVE')process.stdout.write('\\x1b[H\\x1b[2J\\x1b[3J');"
              : "";
          const program = `const fs=require('node:fs');${history}let prior='';const draw=()=>{const stage=fs.readFileSync(${JSON.stringify(stage)},'utf8');if(stage===prior)return;prior=stage;${clear}process.stdout.write('\\x1b[H'+stage+'_ANCHOR original reading line 界é\\r\\nSECOND_ROW stable content\\r\\nREADY');};process.on('SIGWINCH',()=>{prior='';draw();});draw();setInterval(draw,20);`;
          const scratch = await createScratchFleet({
            sessions: 1,
            windowsPerSession: 1,
            adoptSessions: true,
            slug: "frozen",
            initialPaneCommand: { executable: process.execPath, args: ["-e", program] },
          });
          fleet = {
            ...scratch,
            environment: { ...scratch.environment, TMUX_IDE_TMUX_SOCKET_PATH: scratch.socketPath },
          };
          const session = fleet.sessionNames[0];
          const copyMode = entry === "wheel" ? "vi" : "emacs";
          native("set-option", "-w", "-t", session, "mode-keys", copyMode);
          native("set-option", "-t", session, "status", "off");
          native("resize-window", "-t", session, "-x", "80", "-y", "16");
          targetPid = Number(native("display-message", "-p", "-t", session, "#{pid}"));
          daemon = await startDaemon(fleet);
          await daemon.promote(session);
          native("set-option", "-w", "-t", session, "pane-border-status", border);
          await waitForReadinessLadder(daemon);
          for (const [client, cols, rows] of [
            ["reader", 100, 24],
            ["live", 120, 30],
          ]) {
            createIsolatedTargetedTuiCwd(join(root, client));
            prepared.push(client);
            clients.set(
              client,
              JSON.parse(
                command(
                  client,
                  "start",
                  "--target",
                  session,
                  "--cols",
                  String(cols),
                  "--rows",
                  String(rows),
                  "--json",
                ),
              ),
            );
            hostPid ??= Number(
              execFileSync("tmux", ["-S", hostSocket, "display-message", "-p", "#{pid}"], {
                encoding: "utf8",
                timeout: 2_000,
              }).trim(),
            );
            await frame(client, "initial", "HOLD_ANCHOR", false);
          }
          assert.equal(
            execFileSync("tmux", ["-S", hostSocket, "show-environment", "-g", "TMUX_IDE_CONFIG"], {
              encoding: "utf8",
            }).trim(),
            `TMUX_IDE_CONFIG=${configPath}`,
            "theme saving is isolated from the user config",
          );
          const historySize = Number(
            native("display-message", "-p", "-t", session, "#{history_size}"),
          );
          if (entry === "selection") assert.equal(historySize, 0);
          else assert.ok(historySize > 0);
          command("reader", "key", "S-F10");
          command("reader", "key", "Enter");
          await frame("reader", "keyboard-entry", `copy ${copyMode}`, true);
          command("reader", "key", "Home", "Up", "Home", "Right");
          command("reader", "key", copyMode === "emacs" ? "C-Space" : "Space");
          command("reader", "key", "Right");
          command("reader", "key", "F1");
          await frame("reader", "keyboard-home", "No agents reported", false);
          command("reader", "key", "Escape");
          command("reader", "key", "F2");
          await frame("reader", "keyboard-return", `copy ${copyMode}`, true);
          const copied = JSON.parse(
            command(
              "reader",
              "input",
              JSON.stringify({
                version: 1,
                kind: "copy-capture",
                copyKey: copyMode === "emacs" ? "ctrl-w" : "enter",
              }),
            ),
          );
          const expectedCopy = copyMode === "emacs" ? "E" : "EC";
          assert.equal(copied.clipboard.bytes, Buffer.byteLength(expectedCopy));
          assert.equal(
            copied.clipboard.sha256,
            createHash("sha256").update(expectedCopy).digest("hex"),
          );
          await frame("reader", "keyboard-live", "HOLD_ANCHOR", false);
          const initial = await frame("reader", "selection-start", "HOLD_ANCHOR", false);
          const lines = initial.split("\n");
          const y = lines.findIndex((line) => line.includes("HOLD_ANCHOR"));
          const x = lines[y].indexOf("HOLD_ANCHOR");
          if (entry === "selection")
            command("reader", "mouse", "drag", String(x), String(y), String(x + 10), String(y));
          else
            command(
              "reader",
              "input",
              JSON.stringify({ version: 1, kind: "application-mouse", action: "wheel-up", x, y }),
            );
          await frame("reader", "selected", "HOLD_ANCHOR", true);
          if (entry !== "selection") {
            for (let step = 0; step < 4; step++)
              command(
                "reader",
                "input",
                JSON.stringify({ version: 1, kind: "application-mouse", action: "wheel-up", x, y }),
              );
            const beforeEntry = await frame("reader", "scrolled-copy-before", "HOLD_ANCHOR", true);
            command("reader", "key", "S-F10");
            command("reader", "key", "Enter");
            const afterEntry = await frame(
              "reader",
              "scrolled-copy-entered",
              `copy ${copyMode}`,
              true,
            );
            const body = (value) =>
              value
                .split("\n")
                .slice(y, -2)
                .map((line) => line.slice(x));
            assert.deepEqual(
              body(afterEntry),
              body(beforeEntry),
              "copy entry preserves the retained viewport",
            );
            const [cursorX, cursorY, visible] = execFileSync(
              "tmux",
              [
                "-S",
                hostSocket,
                "display-message",
                "-p",
                "-t",
                "=_frozen-reader:0.0",
                "#{cursor_x}:#{cursor_y}:#{cursor_flag}",
              ],
              { encoding: "utf8" },
            )
              .trim()
              .split(":")
              .map(Number);
            assert.equal(visible, 1, "copy cursor is visible in the real host terminal");
            assert.ok(
              cursorX >= x && cursorX < 100 && cursorY >= y && cursorY < 22,
              "copy cursor lies inside the pane content",
            );
            command(
              "reader",
              "key",
              "Home",
              "Right",
              copyMode === "vi" ? "Space" : "C-Space",
              "Right",
            );
            const historyCopy = JSON.parse(
              command(
                "reader",
                "input",
                JSON.stringify({
                  version: 1,
                  kind: "copy-capture",
                  copyKey: copyMode === "vi" ? "enter" : "ctrl-w",
                }),
              ),
            );
            assert.equal(historyCopy.clipboard.bytes, copyMode === "vi" ? 2 : 1);
            assert.equal(
              historyCopy.clipboard.sha256,
              createHash("sha256")
                .update(copyMode === "vi" ? "OL" : "O")
                .digest("hex"),
            );
            await frame("reader", "scrolled-copy-exited", "HOLD_ANCHOR", false);
            command(
              "reader",
              "input",
              JSON.stringify({ version: 1, kind: "application-mouse", action: "wheel-up", x, y }),
            );
            await frame("reader", "scrolled-copy-restored", "HOLD_ANCHOR", true);
          }
          writeFileSync(stage, "LIVE", { mode: 0o600 });
          await frame("live", "output", "LIVE_ANCHOR", false);
          if (entry !== "selection") {
            assert.equal(native("display-message", "-p", "-t", session, "#{history_size}"), "0");
            assert.ok(
              !native("capture-pane", "-p", "-S", "-", "-t", session).includes("HOLD_ANCHOR"),
            );
          }
          const frozen = await frame("reader", "output", "HOLD_ANCHOR", true);
          assert.ok(!frozen.includes("LIVE_ANCHOR"));
          command("reader", "key", "F1");
          const home = await frame("reader", "home", "No agents reported", false);
          assert.ok(!home.includes("HOLD_ANCHOR") && !home.includes("LIVE_ANCHOR"));
          command("reader", "key", "Escape");
          await frame("reader", "home-escape", "No agents reported", false);
          for (let cycle = 0; cycle < 3; cycle++) {
            const before = await frame("reader", `theme-${cycle}-before`, "Theme:", false);
            const rows = before.split("\n");
            const themeY = rows.findIndex((line) => /Theme: (system|dark|light)/.test(line));
            assert.ok(themeY >= 0, "Home exposes the theme control");
            const mode = rows[themeY].match(/Theme: (system|dark|light)/)[1];
            const modes = ["system", "dark", "light"];
            const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length];
            command(
              "reader",
              "input",
              JSON.stringify({
                version: 1,
                kind: "application-mouse",
                action: "click",
                x: rows[themeY].indexOf("Theme:") + 2,
                y: themeY,
              }),
            );
            await frame("reader", `theme-${cycle}-picker`, "Preview now", false);
            command("reader", "key", "Down");
            await frame("reader", `theme-${cycle}-preview`, `Theme: ${nextMode}`, false);
            command("reader", "key", "Enter");
            await frame("reader", `theme-${cycle}-changed`, `Theme: ${nextMode}`, false);
            assert.equal(JSON.parse(readFileSync(configPath, "utf8")).theme.mode, nextMode);
            command("reader", "key", "F2");
            await frame("reader", `theme-${cycle}-return`, "HOLD_ANCHOR", true);
            command("reader", "key", "F1");
          }
          command("reader", "key", "F2");
          await frame("reader", "home-return", "HOLD_ANCHOR", true);
          await frame("live", "peer-after-home", "LIVE_ANCHOR", false);
          for (const [cols, rows, hostCols, hostRows] of [
            [40, 12, 80, 18],
            [95, 20, 120, 30],
            [80, 16, 100, 24],
          ]) {
            native("resize-window", "-t", session, "-x", String(cols), "-y", String(rows));
            const geometry = () =>
              native(
                "display-message",
                "-p",
                "-t",
                session,
                "#{window_width}x#{window_height} #{pane_width}x#{pane_height} #{pane-border-status}",
              );
            const beforeHostResize = geometry();
            assert.equal(
              beforeHostResize,
              `${cols}x${rows} ${cols}x${rows - (border === "off" ? 0 : 1)} ${border}`,
            );
            assert.equal(beforeHostResize.split(" ")[0], `${cols}x${rows}`);
            command("reader", "resize", String(hostCols), String(hostRows));
            await frame("reader", `${cols}x${rows}`, "HOLD_ANCHOR", true);
            await frame("live", `${cols}x${rows}`, "LIVE_ANCHOR", false);
            assert.equal(
              geometry(),
              beforeHostResize,
              "host resize must preserve native size ownership",
            );
            report.frames.at(-1).nativeGeometry = beforeHostResize;
          }
          const beforeNarrow = await frame("reader", "before-one-column", "HOLD_ANCHOR", true);
          const beforeRows = beforeNarrow.split("\n");
          const anchorY = beforeRows.findIndex((line) => line.includes("HOLD_ANCHOR"));
          const anchorX = beforeRows[anchorY].indexOf("HOLD_ANCHOR");
          native("resize-window", "-t", session, "-x", "1", "-y", "16");
          const narrow = await frame(
            "reader",
            "one-column",
            "Esc",
            true,
            (plain) => !plain.includes("HOLD_ANCHOR"),
          );
          assert.ok(
            !narrow.includes("HOLD_ANCHOR"),
            "frozen text reflows instead of retaining its old width",
          );
          const narrowRows = narrow.split("\n");
          assert.equal(
            [0, 1, 2, 3].map((offset) => narrowRows[anchorY + offset]?.[anchorX] ?? "").join(""),
            "HOLD",
            "the same reading anchor is painted vertically",
          );
          assert.equal(native("display-message", "-p", "-t", session, "#{window_width}"), "1");
          native("resize-window", "-t", session, "-x", "80", "-y", "16");
          const restoredWide = await frame("reader", "one-column-restored", "HOLD_ANCHOR", true);
          assert.ok(
            restoredWide.includes("界é"),
            "wide and combining text survives the one-column view",
          );
          await frame("live", "peer-after-one-column", "LIVE_ANCHOR", false);
          const returnKey = entry !== "selection" && border === "off" ? "End" : "Escape";
          report.returnKey = returnKey;
          command("reader", "key", returnKey);
          await frame("reader", "return-live", "LIVE_ANCHOR", false);
          await frame("live", "peer-still-live", "LIVE_ANCHOR", false);
          command("reader", "key", "F1");
          await frame("reader", "live-home", "No agents reported", false);
          writeFileSync(stage, "NEXT", { mode: 0o600 });
          await frame("live", "output-while-home", "NEXT_ANCHOR", false);
          command("reader", "key", "F2");
          await frame("reader", "live-home-return", "NEXT_ANCHOR", false);
          const controls = native("list-clients", "-F", "#{client_control_mode}")
            .split("\n")
            .filter((value) => value === "1");
          assert.equal(controls.length, 1, "both TUI clients share one daemon control connection");
          report.passed = true;
        } catch (error) {
          failure = error;
          report.failure = error.message;
          if (daemon)
            writeFileSync(join(root, "daemon-output.log"), daemon.output(), { mode: 0o600 });
        } finally {
          const errors = [];
          for (const client of prepared) {
            try {
              command(client, "stop");
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await daemon?.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            await fleet?.dispose();
          } catch (error) {
            errors.push(error);
          }
          for (const [role, pid] of [
            ...[...clients].map(([client, value]) => [client, value.processId]),
            ["daemon", daemon?.record.pid],
            ["host-tmux", hostPid],
            ["target-tmux", targetPid],
          ]) {
            if (!pid) continue;
            const deadline = Date.now() + 2_000;
            while (alive(pid) && Date.now() < deadline) await delay(25);
            const absent = !alive(pid);
            report.cleanup.push({ role, pid, absent });
            if (!absent) errors.push(new Error(`${role} survived cleanup`));
          }
          if (errors.length) {
            report.passed = false;
            failure = new AggregateError(
              [...(failure ? [failure] : []), ...errors],
              "frozen-view cleanup failed",
            );
          }
          writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2), {
            mode: 0o600,
          });
          t.diagnostic(`Frozen-view evidence: ${root}`);
        }
        if (failure) throw failure;
      },
    );
