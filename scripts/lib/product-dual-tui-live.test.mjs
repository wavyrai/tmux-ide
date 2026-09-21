import test from "node:test";
import { createHash } from "node:crypto";
import stringWidth from "string-width";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { decodeFocusFramebufferCapture } from "./product-focus.mjs";
import { createIsolatedTargetedTuiCwd } from "../product-test-rig-journeys.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const alive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};

test(
  "real TUIs retain independent history and complete chrome through resize, zoom and client opening",
  {
    skip: process.env.TMUX_IDE_DUAL_TUI_LIVE !== "1",
    timeout: 240_000,
  },
  async (t) => {
    const clientCount = Number(process.env.TMUX_IDE_LIVE_TUI_CLIENTS ?? 2);
    assert.ok([2, 4, 8].includes(clientCount), "live TUI client count must be 2, 4 or 8");
    const concurrentOpen = process.env.TMUX_IDE_LIVE_TUI_OPENING === "concurrent";
    const root = mkdtempSync("/tmp/tmi-dual-tui-");
    const rig = join(root, "rig");
    const artifacts = join(root, "frames");
    mkdirSync(artifacts, { mode: 0o700 });
    const terminalEnvironment = {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
      LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    };
    // Child applications are real terminal processes, not Node test workers.
    delete terminalEnvironment.NODE_TEST_CONTEXT;
    const environment = {
      ...terminalEnvironment,
      TMUX_IDE_PRODUCT_RIG_DIR: rig,
      TMUX_IDE_PRODUCT_JOURNEY: "keyboard-pointer-resize",
    };
    const rigCommand = (command) =>
      execFileSync(
        process.execPath,
        [join(repo, "scripts/product-test-rig.mjs"), command, "--json"],
        {
          cwd: repo,
          env: environment,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    const readState = () => JSON.parse(readFileSync(join(rig, "state.json"), "utf8"));
    const frames = [];
    const report = {
      passed: false,
      clientCount,
      concurrentOpen,
      frames,
      openings: [],
      cleanup: [],
    };
    let state;
    let secondPrepared = false;
    const extraPrepared = new Set();
    const retiredClients = [];
    let failure;
    const clients = new Map();
    function tuiOptions(client) {
      const runtimeDir = client === "first" ? state.tui.runtimeDir : join(rig, `${client}-tui`);
      return {
        cwd: repo,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...terminalEnvironment,
          TMUX_IDE_TESTDRIVE_RUNTIME_DIR: runtimeDir,
          TMUX_IDE_TESTDRIVE_HOST_SESSION:
            client === "first" ? state.tui.hostSession : `${state.tui.hostSession}-${client}`,
          TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: state.runtimeNamespace.hostTmuxSocketPath,
          TMUX_IDE_TMUX_SOCKET_PATH: state.runtimeNamespace.tmuxSocketPath,
          TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
          TMUX_IDE_TESTDRIVE_CANONICAL_HOME: state.runtimeNamespace.daemonInfoDir,
        },
      };
    }
    function tui(client, ...args) {
      return execFileSync(
        process.execPath,
        [join(repo, "scripts/tui-testdrive.mjs"), ...args],
        tuiOptions(client),
      );
    }
    const native = (...args) =>
      execFileSync("tmux", ["-S", state.runtimeNamespace.tmuxSocketPath, ...args], {
        encoding: "utf8",
        timeout: 2_000,
      }).trimEnd();
    const geometry = () =>
      native(
        "list-panes",
        "-t",
        state.session,
        "-F",
        "#{pane_id} #{pane_width} #{pane_height} #{window_width} #{window_height} #{pane_left} #{pane_top}",
      );
    function identities() {
      const current = readState();
      assert.equal(current.ownerPid, state.ownerPid);
      assert.equal(current.daemon.instanceId, state.daemon.instanceId);
      assert.equal(current.daemon.pid, state.daemon.pid);
      assert.ok(alive(state.ownerPid) && alive(state.daemon.pid));
      for (const [client, expected] of clients) {
        const status = JSON.parse(tui(client, "status", "--json"));
        assert.equal(status.processId, expected.processId);
        assert.equal(status.hostIdentity.paneId, expected.hostIdentity.paneId);
        assert.equal(status.hostIdentity.sessionId, expected.hostIdentity.sessionId);
        assert.equal(status.readiness.activeGeneration, state.daemon.instanceId);
        assert.equal(status.readiness.generationStatus, "live");
        assert.equal(status.daemon.instanceId, state.daemon.instanceId);
        assert.equal(status.daemon.pid, state.daemon.pid);
        assert.ok(alive(status.processId));
      }
    }
    async function frame(stage, client, expected) {
      identities();
      const deadline = Date.now() + 5_000;
      let lines;
      let envelope;
      do {
        envelope = JSON.parse(tui(client, "capture", "--ansi", "--json"));
        const identity = clients.get(client);
        assert.equal(envelope.hostIdentity.processId, identity.processId);
        assert.equal(envelope.hostIdentity.paneId, identity.hostIdentity.paneId);
        assert.equal(envelope.hostIdentity.sessionId, identity.hostIdentity.sessionId);
        try {
          lines = decodeFocusFramebufferCapture(envelope).plain.split("\n");
        } catch (error) {
          writeFileSync(
            join(artifacts, `${stage}-${client}-invalid.json`),
            JSON.stringify(envelope),
          );
          writeFileSync(join(artifacts, `${stage}-${client}-plain.txt`), tui(client, "capture"));
          throw error;
        }
        if (expected(lines)) break;
        await delay(50);
      } while (Date.now() < deadline);
      writeFileSync(join(artifacts, `${stage}-${client}.json`), JSON.stringify(envelope) + "\n", {
        mode: 0o600,
      });
      if (!expected(lines))
        writeFileSync(join(artifacts, `${stage}-${client}-plain.txt`), tui(client, "capture"), {
          mode: 0o600,
        });
      if (!expected(lines)) {
        const paneIds = native("list-panes", "-t", state.session, "-F", "#{pane_id}").split("\n");
        writeFileSync(
          join(artifacts, `${stage}-${client}-native.json`),
          JSON.stringify({
            geometry: geometry(),
            panes: paneIds.map((pane) => ({
              pane,
              capture: native("capture-pane", "-p", "-t", pane),
            })),
          }),
        );
      }
      assert.ok(expected(lines), `${stage}/${client} frame mismatch; artifacts: ${artifacts}`);
      identities();
      frames.push({
        stage,
        client,
        processId: clients.get(client).processId,
        generation: state.daemon.instanceId,
        cols: envelope.cols,
        rows: envelope.rows,
        busyTick: Number(lines.join("\n").match(/C-BOTTOM (\d+)/)?.[1] ?? 0),
      });
      return lines;
    }
    try {
      rigCommand("start");
      state = readState();
      assert.equal(state.status, "ready");
      assert.equal(
        state.journeyEvidence.keyboardPointerResize.expected.daemonGeneration,
        state.daemon.instanceId,
      );
      clients.set("first", JSON.parse(tui("first", "status", "--json")));
      createIsolatedTargetedTuiCwd(join(rig, "second-tui"));
      secondPrepared = true;
      clients.set(
        "second",
        JSON.parse(
          tui(
            "second",
            "start",
            "--target",
            state.session,
            "--cols",
            "110",
            "--rows",
            "32",
            "--json",
          ),
        ),
      );
      assert.notEqual(clients.get("first").processId, clients.get("second").processId);
      // Exercise type-ahead before terminal setup: echoed F2 previously made
      // the OSC 66 probe erase Unicode chrome. Observe readiness before checks.
      tui("second", "key", "F2");
      const readyDeadline = Date.now() + 10_000;
      while (JSON.parse(tui("second", "status", "--json")).readiness?.generationStatus !== "live") {
        assert.ok(Date.now() < readyDeadline, "second TUI did not become coherent");
        await delay(50);
      }
      const fixture = join(root, "history.mjs");
      writeFileSync(
        fixture,
        `process.stdout.write(Array.from({length:120},(_,i)=>'\\x1b[32mHISTORY_'+String(i).padStart(3,'0')+'\\x1b[0m row content').join('\\r\\n')+'\\r\\nBOTTOM_READY');process.stdin.setRawMode(true);process.stdin.resume();`,
        { mode: 0o600 },
      );
      native(
        "respawn-pane",
        "-k",
        "-t",
        `${state.session}:one.0`,
        `${quote(process.execPath)} ${quote(fixture)}`,
      );
      const dimensions = geometry();
      const baseline = (count, line) => (rows) =>
        rows.length === count &&
        rows[3].includes(line) &&
        rows.at(-2).includes("BOTTOM_READY") &&
        rows.at(-1).includes("F5");
      await frame("baseline", "first", baseline(44, "HISTORY_081"));
      await frame("baseline", "second", baseline(32, "HISTORY_093"));
      const wheel = (action) =>
        tui(
          "second",
          "input",
          JSON.stringify({
            version: 1,
            kind: "application-mouse",
            action,
            x: 40,
            y: 5,
          }),
        );
      wheel("wheel-up");
      await frame(
        "wheel-up",
        "second",
        (rows) =>
          rows[2].includes("Scrollback") &&
          rows[3].includes("HISTORY_088") &&
          rows.at(-2).includes("HISTORY_115"),
      );
      await frame("wheel-up", "first", baseline(44, "HISTORY_081"));
      assert.equal(geometry(), dimensions, "wheel scrolling mutated native geometry");
      wheel("wheel-down");
      await frame("wheel-down", "second", baseline(32, "HISTORY_093"));
      await frame("wheel-down", "first", baseline(44, "HISTORY_081"));
      tui("second", "key", "S-PPage");
      await frame(
        "second-reading",
        "second",
        (rows) =>
          rows[2].includes("Scrollback") &&
          rows[3].includes("HISTORY_066") &&
          rows.at(-2).includes("HISTORY_093"),
      );
      await frame("second-reading", "first", baseline(44, "HISTORY_081"));
      tui("first", "key", "S-PPage");
      await frame(
        "both-reading",
        "first",
        (rows) => rows[2].includes("Scrollback") && rows[3].includes("HISTORY_042"),
      );
      await frame("both-reading", "second", (rows) => rows[3].includes("HISTORY_066"));
      tui("second", "resize", "90", "24");
      await frame(
        "small-resize",
        "second",
        (rows) =>
          rows.length === 24 &&
          rows[3].includes("HISTORY_066") &&
          rows.at(-2).includes("HISTORY_085") &&
          rows.at(-1).includes("F5"),
      );
      await frame(
        "small-resize",
        "first",
        (rows) => rows.length === 44 && rows[3].includes("HISTORY_042"),
      );
      assert.equal(geometry(), dimensions, "client-local scroll/resize mutated native geometry");
      tui("second", "key", "Escape");
      await frame("second-live", "second", baseline(24, "HISTORY_101"));
      await frame("second-live", "first", (rows) => rows[3].includes("HISTORY_042"));
      tui("first", "key", "Escape");
      native("resize-pane", "-Z", "-t", `${state.session}:one.0`);
      assert.equal(
        native("display-message", "-p", "-t", state.session, "#{window_zoomed_flag}"),
        "1",
      );
      for (const client of clients.keys())
        await frame(
          "zoomed",
          client,
          (rows) => rows[2].includes("Zoomed · Restore") && rows.at(-2).includes("BOTTOM_READY"),
        );
      native("resize-pane", "-Z", "-t", `${state.session}:one.0`);
      assert.equal(
        native("display-message", "-p", "-t", state.session, "#{window_zoomed_flag}"),
        "0",
      );
      for (const client of clients.keys())
        await frame(
          "restored",
          client,
          (rows) => !rows[2].includes("Zoomed") && rows.at(-2).includes("BOTTOM_READY"),
        );
      assert.equal(geometry(), dimensions, "zoom restore changed native geometry");
      // Retain an actual wrapped Unicode history position while its peer
      // consumes ongoing output. Derive the anchor from the accepted frame,
      // since physical row counts depend on native width and Unicode cells.
      const unicodeFixture = join(root, "unicode-history.mjs");
      const unicodeStop = join(root, "unicode-history.stop");
      writeFileSync(
        unicodeFixture,
        `import {existsSync} from 'node:fs';
const line = (kind, tick) => (kind+'_'+String(tick).padStart(5,'0')+' 界e\u0301 ').repeat(10);
process.stdout.write(Array.from({length:120}, (_,i)=>line('WRAP',i)).join('\\r\\n')+'\\r\\n');
process.stdin.setRawMode(true); process.stdin.resume();
let tick=0;
const timer=setInterval(()=>{
  if(existsSync(${JSON.stringify(unicodeStop)})) { clearInterval(timer); process.stdout.write('UNICODE_DONE '+tick); return; }
  process.stdout.write(line('LIVE',++tick)+'\\r\\n');
},40);`,
        { mode: 0o600 },
      );
      native(
        "respawn-pane",
        "-k",
        "-t",
        `${state.session}:one.0`,
        `${quote(process.execPath)} ${quote(unicodeFixture)}`,
      );
      const unicodeTick = (rows) =>
        Math.max(
          0,
          ...[...rows.join("\n").matchAll(/LIVE_(\d{5})/g)].map((match) => Number(match[1])),
        );
      const unicodeChrome = (rows) =>
        rows.at(-1).includes("F5") &&
        rows.slice(3, -1).join("\n").includes("界e\u0301") &&
        !rows.slice(3, -1).join("\n").includes("\ufffd");
      let firstTick = 0;
      const firstUnicode = await frame(
        "unicode-live-start",
        "first",
        (rows) => unicodeTick(rows) > 0 && unicodeChrome(rows),
      );
      firstTick = unicodeTick(firstUnicode);
      await frame(
        "unicode-live-start",
        "second",
        (rows) => unicodeTick(rows) > 0 && unicodeChrome(rows),
      );
      tui("second", "key", "S-PPage");
      tui("second", "key", "S-PPage");
      tui("second", "key", "S-PPage");
      const readFrame = await frame(
        "unicode-reading-entry",
        "second",
        (rows) =>
          rows[2].includes("Scrollback") &&
          /(?:WRAP|LIVE)_\d{5}/.test(rows.slice(3, -1).join("\n")) &&
          unicodeChrome(rows),
      );
      const anchor = readFrame
        .slice(3, -1)
        .join("\n")
        .match(/(?:WRAP|LIVE)_\d{5}/)[0];
      const anchored = (rows) => {
        const firstMarker = rows
          .slice(3, -1)
          .join("\n")
          .match(/(?:WRAP|LIVE)_\d{5}/)?.[0];
        return firstMarker === anchor && rows[2].includes("Scrollback") && unicodeChrome(rows);
      };
      const verifyUnicodePeer = async (stage) => {
        await frame(stage, "second", anchored);
        const next = await frame(
          stage,
          "first",
          (rows) =>
            unicodeTick(rows) > firstTick && !rows[2].includes("Scrollback") && unicodeChrome(rows),
        );
        firstTick = unicodeTick(next);
      };
      await verifyUnicodePeer("unicode-reading-live-peer");
      tui("second", "resize", "72", "24");
      await verifyUnicodePeer("unicode-reading-client-narrow");
      assert.equal(geometry(), dimensions, "Unicode reader resize mutated native geometry");
      native("resize-pane", "-Z", "-t", `${state.session}:one.0`);
      assert.equal(
        native("display-message", "-p", "-t", state.session, "#{window_zoomed_flag}"),
        "1",
      );
      await verifyUnicodePeer("unicode-reading-native-zoom");
      native("resize-pane", "-Z", "-t", `${state.session}:one.0`);
      assert.equal(
        native("display-message", "-p", "-t", state.session, "#{window_zoomed_flag}"),
        "0",
      );
      await verifyUnicodePeer("unicode-reading-native-restore");
      tui("second", "resize", "90", "24");
      await verifyUnicodePeer("unicode-reading-client-wide");
      assert.equal(geometry(), dimensions, "Unicode zoom restore changed native geometry");
      const selectionFrame = await frame("unicode-selection-ready", "second", anchored);
      const selectionRow = selectionFrame.findIndex(
        (line, row) => row >= 3 && /(?:WRAP|LIVE)_\d{5} 界e\u0301/u.test(line),
      );
      assert.ok(selectionRow >= 3, "visible complete Unicode selection token");
      const selected = /(?:WRAP|LIVE)_\d{5} 界e\u0301/u.exec(selectionFrame[selectionRow]);
      const selectionX = stringWidth(selectionFrame[selectionRow].slice(0, selected.index));
      const selectionWidth = stringWidth(selected[0]);
      const selectionLeft = stringWidth(selectionFrame[3].match(/^ */)[0]);
      const siblingHeader = selectionFrame[2].indexOf("○ node");
      assert.ok(siblingHeader > selectionLeft, "observed sibling pane header boundary");
      const selectionRight = stringWidth(selectionFrame[2].slice(0, siblingHeader)) - 1;
      let copy;
      try {
        copy = JSON.parse(
          tui(
            "second",
            "input",
            JSON.stringify({
              version: 1,
              kind: "selection-drag",
              timeoutMs: 5000,
              from: { x: selectionX, y: selectionRow },
              to: { x: selectionX + selectionWidth - 1, y: selectionRow },
              contentRect: {
                x: selectionLeft,
                y: 3,
                width: selectionRight - selectionLeft,
                height: selectionFrame.length - 4,
              },
            }),
          ),
        );
      } catch (error) {
        writeFileSync(join(artifacts, "unicode-selection-failure.txt"), tui("second", "capture"));
        throw error;
      }
      assert.deepEqual(
        copy.clipboard,
        {
          bytes: Buffer.byteLength(selected[0]),
          sha256: createHash("sha256").update(selected[0]).digest("hex"),
        },
        "Unicode selection must preserve exact UTF-8 bytes",
      );
      assert.equal(geometry(), dimensions, "copying Unicode must not mutate native layout");
      report.unicodeSelection = {
        expected: selected[0],
        clipboard: copy.clipboard,
        observation: copy.clipboardObservation,
        style: copy.selectionStyle,
      };
      writeFileSync(unicodeStop, "stop", { mode: 0o600 });
      const unicodeFinal = (rows) =>
        rows.join("\n").includes("UNICODE_DONE") && unicodeChrome(rows);
      await frame("unicode-output-stopped", "first", unicodeFinal);
      await frame("unicode-output-stopped-reader", "second", anchored);
      tui("second", "key", "Escape");
      await frame(
        "unicode-back-to-live",
        "second",
        (rows) => unicodeFinal(rows) && !rows[2].includes("Scrollback"),
      );
      report.unicodeReading = {
        anchor,
        intervalMs: 40,
        lastPeerTick: firstTick,
        secondWidths: [90, 72, 90],
      };
      const mouseInput = join(root, "application-mouse.bin");
      const mouseFixture = join(root, "mouse.mjs");
      writeFileSync(mouseInput, "", { mode: 0o600 });
      writeFileSync(
        mouseFixture,
        `import {appendFileSync} from 'node:fs';
process.stdin.setRawMode(true);
process.stdin.on('data', data => appendFileSync(${JSON.stringify(mouseInput)}, data));
process.stdout.write('\\x1b[?1000h\\x1b[?1006h'+Array.from({length:120},(_,i)=>'HISTORY_'+String(i).padStart(3,'0')+' row content').join('\\r\\n')+'\\r\\nMOUSE_READY');`,
        { mode: 0o600 },
      );
      native(
        "respawn-pane",
        "-k",
        "-t",
        `${state.session}:one.0`,
        `${quote(process.execPath)} ${quote(mouseFixture)}`,
      );
      const mouseBaseline = (rows) =>
        rows[3].includes("HISTORY_101") && rows.at(-2).includes("MOUSE_READY");
      const mouseReady = await frame("mouse-ready", "second", mouseBaseline);
      const contentLeft = mouseReady[3].indexOf("HISTORY_101");
      assert.ok(
        contentLeft >= 0 && contentLeft < 40,
        "mouse target lies inside observed pane content",
      );
      const nativeRows = native("capture-pane", "-p", "-t", `${state.session}:one.0`).split("\n");
      const nativeOriginY = nativeRows.findIndex((line) => line.startsWith("HISTORY_101"));
      assert.ok(nativeOriginY >= 0, "live cropped row has a native coordinate");
      const expectedMouse = `\x1b[<64;${40 - contentLeft + 1};${nativeOriginY + 5 - 3 + 1}M`;
      const waitForMouseBytes = async (expected) => {
        const deadline = Date.now() + 5_000;
        while (
          readFileSync(mouseInput).length < Buffer.byteLength(expected) &&
          Date.now() < deadline
        )
          await delay(25);
        assert.equal(readFileSync(mouseInput, "utf8"), expected);
      };
      wheel("wheel-up");
      await waitForMouseBytes(expectedMouse);
      await frame(
        "ordinary-wheel-application",
        "second",
        (rows) => mouseBaseline(rows) && !rows[2].includes("Scrollback"),
      );
      tui(
        "second",
        "input",
        JSON.stringify({
          version: 1,
          kind: "application-mouse",
          action: "wheel-up",
          x: 40,
          y: 5,
          modifiers: ["alt"],
        }),
      );
      // Derive terminal coordinates from the actual accepted frame/native row,
      // including sidebar, header and cropped native viewport. Ordinary wheel
      // reaches the mouse-enabled application automatically; compatibility Alt
      // is consumed so the second event has the same application encoding.
      await waitForMouseBytes(expectedMouse.repeat(2));
      await frame("mouse-forwarded", "second", mouseBaseline);
      tui(
        "second",
        "input",
        JSON.stringify({
          version: 1,
          kind: "application-mouse",
          action: "wheel-up",
          x: 40,
          y: 5,
          modifiers: ["shift"],
        }),
      );
      await frame(
        "shift-wheel-local",
        "second",
        (rows) => rows[2].includes("Scrollback") && rows[3].includes("HISTORY_096"),
      );
      await frame(
        "shift-wheel-local",
        "first",
        (rows) => rows[3].includes("HISTORY_081") && rows.at(-2).includes("MOUSE_READY"),
      );
      wheel("wheel-down");
      await frame("reading-wheel-local", "second", mouseBaseline);
      assert.equal(
        readFileSync(mouseInput, "utf8"),
        expectedMouse.repeat(2),
        "local reading leaked wheel input to application",
      );
      assert.equal(geometry(), dimensions, "application mouse routing changed native geometry");
      const nestedFixture = join(root, "nested.mjs");
      writeFileSync(
        nestedFixture,
        `const label=process.argv[2];
const draw=()=>process.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[2J\\x1b[H'+label+'-TOP'+'\\x1b['+process.stdout.rows+';1H'+label+'-BOTTOM');
process.stdout.write('\\x1b[?1049h');process.on('SIGWINCH',draw);draw();setInterval(()=>{},10000);`,
        { mode: 0o600 },
      );
      const sibling = native("display-message", "-p", "-t", `${state.session}:one.1`, "#{pane_id}");
      native(
        "split-window",
        "-d",
        "-v",
        "-t",
        sibling,
        `${quote(process.execPath)} ${quote(nestedFixture)} C`,
      );
      const nestedPanes = native("list-panes", "-t", state.session, "-F", "#{pane_id}").split("\n");
      assert.equal(nestedPanes.length, 3);
      for (const [index, pane] of nestedPanes.entries()) {
        const label = String.fromCharCode(65 + index);
        native(
          "respawn-pane",
          "-k",
          "-t",
          pane,
          `${quote(process.execPath)} ${quote(nestedFixture)} ${label}`,
        );
        native("select-pane", "-t", pane, "-T", `nest-${label}`);
        native("set-option", "-p", "-t", pane, "@ide_name", `nest-${label}`);
        native("set-option", "-p", "-t", pane, "@tmux_ide_name_source", "manual");
      }
      const topologyDeadline = Date.now() + 10_000;
      for (const client of clients.keys()) {
        while (true) {
          const status = JSON.parse(tui(client, "status", "--json"));
          if (
            status.readiness.generationStatus === "live" &&
            status.readiness.activeGeneration === state.daemon.instanceId
          )
            break;
          assert.ok(
            Date.now() < topologyDeadline,
            "nested topology did not rebind to the existing daemon",
          );
          await delay(50);
        }
      }
      for (const border of ["top", "bottom", "off"]) {
        native("set-option", "-w", "-t", state.session, "pane-border-status", border);
        const nestedDimensions = geometry();
        for (const client of clients.keys()) {
          await frame(
            `nested-${border}`,
            client,
            (rows) =>
              ["A", "B", "C"].every(
                (label) =>
                  rows.join("\n").includes(`${label}-BOTTOM`) &&
                  rows.join("\n").includes(`nest-${label}`),
              ) &&
              rows.at(-2).includes("A-BOTTOM") &&
              rows.at(-2).includes("C-BOTTOM") &&
              rows.at(-1).includes("F5"),
          );
        }
        assert.equal(geometry(), nestedDimensions, "nested client painting mutated tmux geometry");
        native("resize-pane", "-Z", "-t", nestedPanes[2]);
        for (const client of clients.keys())
          await frame(
            `nested-${border}-zoom`,
            client,
            (rows) =>
              rows[2].includes("Zoomed") &&
              rows.at(-2).includes("C-BOTTOM") &&
              !rows.join("\n").includes("A-BOTTOM"),
          );
        native("resize-pane", "-Z", "-t", nestedPanes[2]);
        for (const client of clients.keys())
          await frame(
            `nested-${border}-restore`,
            client,
            (rows) =>
              !rows[2].includes("Zoomed") &&
              rows.at(-2).includes("A-BOTTOM") &&
              rows.at(-2).includes("C-BOTTOM") &&
              rows.join("\n").includes("B-BOTTOM"),
          );
        assert.equal(geometry(), nestedDimensions, "nested zoom restore changed native geometry");
        for (const [cols, height] of [
          [70, 18],
          [110, 32],
          [90, 24],
        ]) {
          tui("second", "resize", String(cols), String(height));
          for (const client of clients.keys())
            await frame(
              `nested-${border}-resize-${cols}x${height}`,
              client,
              (rows) =>
                rows.length === (client === "second" ? height : 44) &&
                ["A", "B", "C"].every(
                  (label) =>
                    rows.join("\n").includes(`${label}-BOTTOM`) &&
                    rows.join("\n").includes(`nest-${label}`),
                ) &&
                rows.at(-2).includes("A-BOTTOM") &&
                rows.at(-2).includes("C-BOTTOM") &&
                rows.at(-1).includes("F5"),
            );
          assert.equal(
            geometry(),
            nestedDimensions,
            "resizing a nested client changed shared native geometry",
          );
        }
      }
      const compactDimensions = geometry();
      // Below eight rows the shell intentionally omits its footer. Five host
      // rows leave only three canvas rows, fewer than two stacked pane headers
      // and their minimum content rows require.
      tui("second", "resize", "90", "5");
      const visited = new Set();
      for (let step = 0; step < 3; step++) {
        await frame(`compact-${step}`, "second", (rows) => {
          const match = rows[2]?.match(/Compact ([123])\/3/);
          if (!match) return false;
          const label = String.fromCharCode(64 + Number(match[1]));
          if (!rows.at(-1).includes(`${label}-BOTTOM`) || !rows[2].includes("Ctrl+O: next"))
            return false;
          visited.add(label);
          return rows.length === 5;
        });
        tui("second", "key", "C-o");
      }
      assert.equal(visited.size, 3, "compact navigation did not reach every native pane");
      assert.equal(geometry(), compactDimensions, "compact navigation changed native geometry");
      tui("second", "resize", "90", "24");
      for (const client of clients.keys())
        await frame(
          "compact-restored",
          client,
          (rows) =>
            !rows.join("\n").includes("Compact") &&
            rows.at(-2).includes("A-BOTTOM") &&
            rows.at(-2).includes("C-BOTTOM") &&
            rows.join("\n").includes("B-BOTTOM"),
        );
      assert.equal(geometry(), compactDimensions, "compact restoration changed native geometry");
      tui("second", "resize", "32", "24");
      await frame(
        "narrow-32",
        "second",
        (rows) =>
          rows.at(-2).includes("A-BOTTOM") &&
          rows.at(-2).includes("C-BOTTOM") &&
          rows.join("\n").includes("B-BOTTOM"),
      );
      await frame(
        "narrow-peer",
        "first",
        (rows) => rows.at(-2).includes("A-BOTTOM") && rows.at(-2).includes("C-BOTTOM"),
      );
      tui("second", "key", "F5");
      await frame("narrow-palette", "second", (rows) => {
        const content = rows.join("\n");
        return content.includes("Command palette") && content.includes("Search commands");
      });
      tui("second", "key", "Escape");
      await frame(
        "narrow-palette-dismissed",
        "second",
        (rows) =>
          !rows.join("\n").includes("Command palette") &&
          rows.at(-2).includes("A-BOTTOM") &&
          rows.at(-2).includes("C-BOTTOM"),
      );
      assert.equal(geometry(), compactDimensions, "narrow viewport changed native geometry");
      tui("second", "resize", "90", "24");
      await frame(
        "narrow-restored",
        "second",
        (rows) => rows.at(-2).includes("A-BOTTOM") && rows.at(-2).includes("C-BOTTOM"),
      );
      const busyStop = join(root, "busy-stop");
      if (clientCount > 2) {
        const busyFixture = join(root, "busy.mjs");
        writeFileSync(
          busyFixture,
          `import {existsSync} from 'node:fs';
let tick=0;
const draw=(done=false)=>process.stdout.write('\\x1b[H'+'C-TOP '+tick+'\\x1b['+process.stdout.rows+';1H\\x1b[2K'+(done?'C-DONE ':'C-BOTTOM ')+String(tick).padStart(6,'0'));
process.stdout.write('\\x1b[?1049h\\x1b[2J');
process.on('SIGWINCH',()=>draw());
const timer=setInterval(()=>{tick++;if(existsSync(${JSON.stringify(busyStop)})){clearInterval(timer);draw(true);}else draw();},20);
setInterval(()=>{},10000);`,
          { mode: 0o600 },
        );
        native(
          "respawn-pane",
          "-k",
          "-t",
          nestedPanes[2],
          `${quote(process.execPath)} ${quote(busyFixture)}`,
        );
      }
      const nestedReady = (rows) =>
        ["A", "B", "C"].every((label) => rows.join("\n").includes(`nest-${label}`)) &&
        rows.at(-2).includes("A-BOTTOM") &&
        rows.at(-2).includes("C-BOTTOM") &&
        (clientCount === 2 || /C-BOTTOM 0*\d*[1-9]\d*/.test(rows.at(-2))) &&
        rows.join("\n").includes("B-BOTTOM") &&
        rows.at(-1).includes("F5");
      async function openClient(client, index, stage, deferCapture = false) {
        const cols = index % 2 === 0 ? 90 : 110;
        const rows = index % 2 === 0 ? 24 : 32;
        const started = performance.now();
        clients.set(
          client,
          JSON.parse(
            (
              await execFileAsync(
                process.execPath,
                [
                  join(repo, "scripts/tui-testdrive.mjs"),
                  "start",
                  "--target",
                  state.session,
                  "--cols",
                  String(cols),
                  "--rows",
                  String(rows),
                  "--json",
                ],
                tuiOptions(client),
              )
            ).stdout,
          ),
        );
        const deadline = Date.now() + 10_000;
        while (JSON.parse(tui(client, "status", "--json")).readiness?.generationStatus !== "live") {
          assert.ok(Date.now() < deadline, `${client} did not open on the existing daemon`);
          await delay(50);
        }
        if (!deferCapture)
          await frame(stage, client, (lines) => lines.length === rows && nestedReady(lines));
        report.openings.push({
          client,
          stage,
          cols,
          rows,
          elapsedMs: performance.now() - started,
          measurement: deferCapture
            ? "launch-through-live-status"
            : "launch-through-verified-frame",
          processId: clients.get(client).processId,
          generation: state.daemon.instanceId,
        });
        assert.equal(
          geometry(),
          compactDimensions,
          "opening a passive TUI changed native geometry",
        );
      }
      const pendingOpens = [];
      for (let index = 3; index <= clientCount; index++) {
        const client = `client-${index}`;
        createIsolatedTargetedTuiCwd(join(rig, `${client}-tui`));
        extraPrepared.add(client);
        if (concurrentOpen) pendingOpens.push(openClient(client, index, `open-${index}`, true));
        else await openClient(client, index, `open-${index}`);
        if (!concurrentOpen && (index === 4 || index === 8))
          for (const retained of clients.keys())
            await frame(`fleet-${index}`, retained, nestedReady);
      }
      if (concurrentOpen && pendingOpens.length) {
        const results = await Promise.allSettled(pendingOpens);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "concurrent TUI opening failed",
          );
        for (const retained of clients.keys())
          await frame("concurrent-opened", retained, nestedReady);
      }
      if (clientCount > 2) {
        const client = `client-${clientCount}`;
        const old = clients.get(client);
        tui(client, "stop");
        clients.delete(client);
        retiredClients.push([`${client}-before-reopen`, old.processId]);
        assert.ok(!alive(old.processId), "closed TUI process survived stop");
        for (const retained of clients.keys()) await frame("peer-closed", retained, nestedReady);
        await openClient(client, clientCount, "reopen");
        assert.notEqual(clients.get(client).processId, old.processId);
        for (const retained of clients.keys()) await frame("peer-reopened", retained, nestedReady);
        for (const retained of clients.keys()) {
          const samples = frames.filter((entry) => entry.client === retained && entry.busyTick > 0);
          assert.ok(samples.length >= 2, `${retained} lacks multiple live-output observations`);
          assert.ok(
            samples.at(-1).busyTick > samples[0].busyTick,
            `${retained} retained stale busy output`,
          );
        }
        writeFileSync(busyStop, "stop", { mode: 0o600 });
        const stopDeadline = Date.now() + 5_000;
        let finalMarker;
        while (
          !(finalMarker = native("capture-pane", "-p", "-t", nestedPanes[2]).match(
            /C-DONE \d+/,
          )?.[0])
        ) {
          assert.ok(
            Date.now() < stopDeadline,
            "busy fixture did not publish its native final marker",
          );
          await delay(25);
        }
        for (const retained of clients.keys())
          await frame(
            "busy-converged",
            retained,
            (rows) =>
              rows.at(-2).includes(finalMarker) &&
              rows.at(-2).includes("A-BOTTOM") &&
              rows.join("\n").includes("B-BOTTOM") &&
              rows.at(-1).includes("F5"),
          );
        report.busy = { finalMarker, intervalMs: 20, clientsConverged: clients.size };
        assert.equal(geometry(), compactDimensions, "busy fanout changed native geometry");
      }
      report.passed = true;
    } catch (error) {
      failure = error;
      report.failure = error.message;
    } finally {
      const cleanupErrors = [];
      for (const client of extraPrepared) {
        try {
          tui(client, "stop");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (secondPrepared) {
        try {
          tui("second", "stop");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rigCommand("stop");
      } catch (error) {
        cleanupErrors.push(error);
      }
      state ??= existsSync(join(rig, "state.json")) ? readState() : null;
      for (const [role, pid] of [
        ["owner", state?.ownerPid],
        ["daemon", state?.daemon?.pid],
        ...[...clients].map(([role, value]) => [role, value.processId]),
        ...retiredClients,
      ]) {
        const absent = !alive(pid);
        report.cleanup.push({ role, pid, absent });
        if (!absent) cleanupErrors.push(new Error(`${role} process ${pid} survived cleanup`));
      }
      for (const key of ["tmuxSocketPath", "hostTmuxSocketPath"]) {
        const path = state?.runtimeNamespace?.[key];
        if (path && existsSync(path)) cleanupErrors.push(new Error(`${key} survived cleanup`));
      }
      if (cleanupErrors.length) {
        report.passed = false;
        failure = new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          "dual-TUI regression cleanup failed",
        );
      }
      writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
      });
      t.diagnostic(`dual-TUI evidence: ${root}`);
    }
    if (failure) throw failure;
  },
);
