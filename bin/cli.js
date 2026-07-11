#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/daemon/src/lib/yaml-io.ts
var yaml_io_exports = {};
__export(yaml_io_exports, {
  getSessionName: () => getSessionName,
  readConfig: () => readConfig,
  writeConfig: () => writeConfig
});
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import yaml from "js-yaml";
function readConfig(dir) {
  const configPath = resolve(dir, "ide.yml");
  const raw = readFileSync(configPath, "utf-8");
  const config2 = yaml.load(raw);
  return { config: config2, configPath };
}
function writeConfig(dir, config2) {
  const configPath = resolve(dir, "ide.yml");
  const out = yaml.dump(config2, { lineWidth: -1, noRefs: true, quotingType: '"' });
  writeFileSync(configPath, out);
  return configPath;
}
function getSessionName(dir) {
  try {
    const { config: config2 } = readConfig(dir);
    return { name: config2.name ?? basename(dir), source: config2.name ? "config" : "fallback" };
  } catch {
    return { name: basename(dir), source: "fallback" };
  }
}
var init_yaml_io = __esm({
  "packages/daemon/src/lib/yaml-io.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/sizes.ts
function computeSizes(items) {
  let claimed = 0;
  let unclaimed = 0;
  for (const item of items) {
    if (item.size) {
      claimed += parseFloat(item.size);
    } else {
      unclaimed++;
    }
  }
  const remaining = Math.max(0, 100 - claimed);
  const defaultSize = unclaimed > 0 ? remaining / unclaimed : 0;
  return items.map((item) => item.size ? parseFloat(item.size) : defaultSize);
}
function toSplitPercents(sizes) {
  const percents = [];
  for (let i = 1; i < sizes.length; i++) {
    const remaining = sizes.slice(i - 1).reduce((a, b) => a + b, 0);
    const topShare = sizes[i - 1];
    percents.push(Math.round((remaining - topShare) / remaining * 100));
  }
  return percents;
}
var init_sizes = __esm({
  "packages/daemon/src/lib/sizes.ts"() {
    "use strict";
  }
});

// packages/tmux-bridge/src/errors.ts
var TmuxError;
var init_errors = __esm({
  "packages/tmux-bridge/src/errors.ts"() {
    "use strict";
    TmuxError = class extends Error {
      code;
      exitCode;
      constructor(message, code, options = {}) {
        super(message, { cause: options.cause });
        this.name = "TmuxError";
        this.code = code;
        this.exitCode = options.exitCode ?? 1;
      }
      toJSON() {
        const out = {
          error: this.message,
          code: this.code
        };
        if (this.cause) out.cause = this.cause.message;
        return out;
      }
    };
  }
});

// packages/tmux-bridge/src/runner.ts
import { execFileSync, spawn } from "node:child_process";
function _setExecutor(fn) {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}
function _setSpawner(fn) {
  const prev = _spawner;
  _spawner = fn;
  return () => {
    _spawner = prev;
  };
}
function _getSpawner() {
  return _spawner;
}
function runTmux(args, options = {}) {
  if (DEBUG || globalThis.__tmuxIdeVerbose) {
    console.error(`  [tmux] ${args.join(" ")}`);
  }
  const execOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  };
  try {
    return _executor("tmux", args, execOptions);
  } catch (error) {
    throw classifyTmuxError(error);
  }
}
function classifyTmuxError(error) {
  const detail = getErrorDetail(error).toLowerCase();
  if (SESSION_NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux session was not found", "SESSION_NOT_FOUND", {
      cause: error
    });
  }
  if (TMUX_UNAVAILABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux is unavailable or its socket is inaccessible", "TMUX_UNAVAILABLE", {
      cause: error
    });
  }
  return new TmuxError("tmux command failed", "TMUX_ERROR", {
    cause: error
  });
}
function getErrorDetail(error) {
  const stderr = error?.stderr;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8");
  return error?.message ?? "";
}
var DEBUG, SESSION_NOT_FOUND_PATTERNS, TMUX_UNAVAILABLE_PATTERNS, _executor, _spawner;
var init_runner = __esm({
  "packages/tmux-bridge/src/runner.ts"() {
    "use strict";
    init_errors();
    DEBUG = process.env.TMUX_IDE_DEBUG === "1";
    SESSION_NOT_FOUND_PATTERNS = ["can't find session", "can't find window", "unknown target"];
    TMUX_UNAVAILABLE_PATTERNS = [
      "failed to connect to server",
      "no server running",
      "error connecting to",
      "connection refused"
    ];
    _executor = execFileSync;
    _spawner = spawn;
  }
});

// packages/tmux-bridge/src/sessions.ts
function getSessionState(session) {
  try {
    runTmux(["has-session", "-t", session]);
    return { running: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { running: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { running: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}
function attachSession(session) {
  runTmux(["attach", "-t", session], { stdio: "inherit" });
}
function hasSession(session) {
  try {
    runTmux(["has-session", "-t", session]);
    return true;
  } catch (error) {
    if (error instanceof TmuxError && (error.code === "SESSION_NOT_FOUND" || error.code === "TMUX_UNAVAILABLE")) {
      return false;
    }
    throw error;
  }
}
function getSessionCwd(session) {
  try {
    const raw = runTmux(["display-message", "-p", "-t", session, "#{pane_current_path}"], {
      encoding: "utf-8"
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
function killSession(session) {
  try {
    runTmux(["kill-session", "-t", session]);
    return { stopped: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { stopped: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { stopped: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}
function createDetachedSession(session, cwd, { cols, lines } = {}) {
  return runTmux(
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-c",
      cwd,
      "-x",
      String(cols ?? 200),
      "-y",
      String(lines ?? 50)
    ],
    { encoding: "utf-8" }
  ).trim();
}
function setSessionEnvironment(session, key, value) {
  runTmux(["set-environment", "-t", session, key, String(value)]);
}
function getSessionVariable(session, name) {
  try {
    const raw = runTmux(["show-option", "-qvt", session, name], {
      encoding: "utf-8"
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}
function setSessionVariable(session, name, value) {
  runTmux(["set-option", "-t", session, name, value]);
}
function runSessionCommand(args) {
  runTmux(args, { stdio: "inherit" });
}
var init_sessions = __esm({
  "packages/tmux-bridge/src/sessions.ts"() {
    "use strict";
    init_errors();
    init_runner();
  }
});

// packages/tmux-bridge/src/panes.ts
function listPanes(session) {
  const raw = runTmux(
    [
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_index}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}"
    ],
    { encoding: "utf-8" }
  ).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, width, height, active2] = line.split("|");
    return {
      index: Number.parseInt(index, 10),
      title,
      width: Number.parseInt(width, 10),
      height: Number.parseInt(height, 10),
      active: active2 === "1"
    };
  });
}
function splitPane(targetPane, direction, cwd, percent) {
  return runTmux(
    [
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      targetPane,
      direction === "vertical" ? "-v" : "-h",
      "-c",
      cwd,
      "-p",
      String(percent)
    ],
    { encoding: "utf-8" }
  ).trim();
}
function sendLiteral(targetPane, text) {
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
}
function sendKeys(targetPane, text, options = {}) {
  const { enter = true } = options;
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  if (enter) {
    runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
  }
}
function capturePane(targetPane, options = {}) {
  const args = ["capture-pane", "-t", targetPane, "-p", "-J"];
  if (typeof options.scrollback === "number") {
    args.push("-S", `-${options.scrollback}`);
  } else if (typeof options.lines === "number") {
    args.push("-S", `-${options.lines}`);
  }
  return runTmux(args, { encoding: "utf-8" }).replace(/\n+$/, "");
}
function captureRecent(targetPane, lines = 50) {
  return capturePane(targetPane, { lines });
}
function getPaneCurrentCommand(targetPane) {
  return runTmux(["display-message", "-p", "-t", targetPane, "#{pane_current_command}"], {
    encoding: "utf-8"
  }).trim();
}
function selectPane(targetPane) {
  runTmux(["select-pane", "-t", targetPane], { stdio: "inherit" });
}
function setPaneTitle(targetPane, title) {
  runTmux(["select-pane", "-t", targetPane, "-T", title], { stdio: "inherit" });
}
function setPaneOption(targetPane, option, value) {
  runTmux(["set-option", "-pqt", targetPane, option, value]);
}
var init_panes = __esm({
  "packages/tmux-bridge/src/panes.ts"() {
    "use strict";
    init_runner();
  }
});

// packages/tmux-bridge/src/monitor.ts
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function startSessionMonitor(session, monitorScript, port) {
  try {
    const existingPid = runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
      encoding: "utf-8"
    }).trim();
    if (existingPid) {
      const pid = parseInt(existingPid, 10);
      if (isProcessAlive(pid)) {
        stopSessionMonitor(session);
        let attempts = 0;
        while (isProcessAlive(pid) && attempts < 10) {
          const { Atomics: Atomics2, SharedArrayBuffer: SharedArrayBuffer2 } = globalThis;
          Atomics2.wait(new Int32Array(new SharedArrayBuffer2(4)), 0, 0, 100);
          attempts++;
        }
      }
    }
  } catch {
  }
  const child = _getSpawner()("tsx", [monitorScript, session, String(port ?? 0)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd()
  });
  child.unref();
  runTmux(["set-option", "-t", session, "@monitor_pid", String(child.pid)]);
}
function stopSessionMonitor(session) {
  try {
    const pid = runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
      encoding: "utf-8"
    }).trim();
    if (pid) {
      const numPid = parseInt(pid, 10);
      try {
        process.kill(-numPid, "SIGTERM");
      } catch {
        try {
          process.kill(numPid, "SIGTERM");
        } catch {
        }
      }
    }
  } catch {
  }
}
var init_monitor = __esm({
  "packages/tmux-bridge/src/monitor.ts"() {
    "use strict";
    init_runner();
  }
});

// packages/tmux-bridge/src/targeting.ts
function resolveTarget(panes, target, session) {
  switch (target.kind) {
    case "byId": {
      if (target.id.startsWith("%")) {
        return {
          target: target.id,
          pane: panes[0] ?? {
            index: -1,
            title: void 0,
            width: 0,
            height: 0,
            active: false
          }
        };
      }
      const numeric = Number.parseInt(target.id, 10);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid pane id: ${target.id}`);
      }
      const found = panes.find((p) => p.index === numeric);
      if (!found) {
        throw new Error(`Pane not found by id: ${target.id}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byIndex": {
      const found = panes.find((p) => p.index === target.index);
      if (!found) {
        throw new Error(`Pane not found by index: ${target.index}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byTitle": {
      const matches = panes.filter((p) => p.title === target.title);
      if (matches.length === 0) {
        throw new Error(`Pane not found by title: ${target.title}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous pane title "${target.title}" matches ${matches.length} panes`);
      }
      return {
        target: paneTarget(session, matches[0].index),
        pane: matches[0]
      };
    }
    case "byRole":
      throw new Error(
        `byRole targets must be resolved at the daemon layer before reaching the bridge (got role="${target.role}")`
      );
  }
}
function paneTarget(session, index) {
  return session ? `${session}.${index}` : String(index);
}
var init_targeting = __esm({
  "packages/tmux-bridge/src/targeting.ts"() {
    "use strict";
  }
});

// packages/tmux-bridge/src/index.ts
var src_exports = {};
__export(src_exports, {
  TmuxError: () => TmuxError,
  _getSpawner: () => _getSpawner,
  _setExecutor: () => _setExecutor,
  _setSpawner: () => _setSpawner,
  attachSession: () => attachSession,
  capturePane: () => capturePane,
  captureRecent: () => captureRecent,
  createDetachedSession: () => createDetachedSession,
  getPaneCurrentCommand: () => getPaneCurrentCommand,
  getSessionCwd: () => getSessionCwd,
  getSessionState: () => getSessionState,
  getSessionVariable: () => getSessionVariable,
  hasSession: () => hasSession,
  isProcessAlive: () => isProcessAlive,
  killSession: () => killSession,
  listPanes: () => listPanes,
  resolveTarget: () => resolveTarget,
  runSessionCommand: () => runSessionCommand,
  runTmux: () => runTmux,
  selectPane: () => selectPane,
  sendKeys: () => sendKeys,
  sendLiteral: () => sendLiteral,
  setPaneOption: () => setPaneOption,
  setPaneTitle: () => setPaneTitle,
  setSessionEnvironment: () => setSessionEnvironment,
  setSessionVariable: () => setSessionVariable,
  splitPane: () => splitPane,
  startSessionMonitor: () => startSessionMonitor,
  stopSessionMonitor: () => stopSessionMonitor
});
var init_src = __esm({
  "packages/tmux-bridge/src/index.ts"() {
    "use strict";
    init_errors();
    init_runner();
    init_sessions();
    init_panes();
    init_monitor();
    init_targeting();
  }
});

// packages/daemon/src/lib/errors.ts
var IdeError, DaemonStartupError, DaemonShutdownError;
var init_errors2 = __esm({
  "packages/daemon/src/lib/errors.ts"() {
    "use strict";
    init_src();
    IdeError = class extends Error {
      code;
      exitCode;
      constructor(message, { code, exitCode = 1, cause } = {}) {
        super(message, { cause });
        this.name = "IdeError";
        this.code = code;
        this.exitCode = exitCode;
      }
      toJSON() {
        const obj = {
          error: this.message,
          code: this.code
        };
        if (this.cause) obj.cause = this.cause.message;
        return obj;
      }
    };
    DaemonStartupError = class extends IdeError {
      reason;
      constructor(message, reason, { cause } = {}) {
        super(message, { code: `DAEMON_${reason.toUpperCase()}`, exitCode: 1, cause });
        this.name = "DaemonStartupError";
        this.reason = reason;
      }
    };
    DaemonShutdownError = class extends IdeError {
      constructor(message, { cause } = {}) {
        super(message, { code: "DAEMON_SHUTDOWN_FAILED", exitCode: 1, cause });
        this.name = "DaemonShutdownError";
      }
    };
  }
});

// packages/daemon/src/lib/output.ts
function printLayout(config2) {
  const INNER = 40;
  const rows = config2.rows ?? [];
  if (rows.length === 0) return;
  for (let r = 0; r < rows.length; r++) {
    const panes = rows[r].panes ?? [];
    const count = panes.length || 1;
    const widths = [];
    let remaining = INNER;
    for (let i = 0; i < count; i++) {
      const w = i < count - 1 ? Math.floor(INNER / count) : remaining;
      widths.push(w);
      remaining -= w;
    }
    if (r === 0) {
      let top = "  \u250C";
      for (let i = 0; i < count; i++) {
        top += "\u2500".repeat(widths[i]);
        top += i < count - 1 ? "\u252C" : "\u2510";
      }
      console.log(top);
    } else {
      console.log("  \u251C" + "\u2500".repeat(INNER + count - 1) + "\u2524");
    }
    const sizeLabel = rows[r].size ?? "";
    let line = "  \u2502";
    for (let i = 0; i < count; i++) {
      const title = panes[i]?.title ?? "";
      const w = widths[i];
      const pad = Math.max(0, w - title.length);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      line += " ".repeat(left) + title + " ".repeat(right) + "\u2502";
    }
    if (sizeLabel) line += "  " + sizeLabel;
    console.log(line);
    if (r === rows.length - 1) {
      let bot = "  \u2514";
      for (let i = 0; i < count; i++) {
        bot += "\u2500".repeat(widths[i]);
        bot += i < count - 1 ? "\u2534" : "\u2518";
      }
      console.log(bot);
    }
  }
}
function outputError(message, code, { exitCode = 1 } = {}) {
  throw new IdeError(message, { code, exitCode });
}
function printCommandError(error, { json: json2 = false } = {}) {
  if (json2) {
    console.error(JSON.stringify(error.toJSON(), null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(error.exitCode ?? 1);
}
var init_output = __esm({
  "packages/daemon/src/lib/output.ts"() {
    "use strict";
    init_errors2();
  }
});

// packages/daemon/src/lib/shell.ts
function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
var init_shell = __esm({
  "packages/daemon/src/lib/shell.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/launch-plan.ts
import { resolve as resolve2 } from "node:path";
function buildPaneCommand(pane) {
  if (!pane.command) return null;
  return pane.command;
}
function collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir) {
  let focusPane = paneMap[0][0];
  const paneActions = [];
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const tmuxPane = paneMap[rowIdx][paneIdx];
      let paneRole;
      if (pane.role === "lead") {
        paneRole = "lead";
      } else if (pane.role === "teammate" || pane.role === "planner") {
        paneRole = "teammate";
      } else if (pane.type) {
        paneRole = "widget";
      } else {
        paneRole = "shell";
      }
      let paneType;
      if (pane.type) {
        paneType = pane.type;
      } else if (pane.command && /claude|codex/i.test(pane.command)) {
        paneType = "agent";
      } else {
        paneType = "shell";
      }
      const action = {
        targetPane: tmuxPane,
        title: pane.title ?? null,
        chdir: null,
        exports: [],
        command: null,
        widgetType: pane.type ?? null,
        widgetTarget: pane.target ?? null,
        paneRole,
        paneType
      };
      if (pane.dir && firstPanesOfRows.has(tmuxPane)) {
        action.chdir = resolve2(dir, pane.dir);
      }
      if (pane.env && typeof pane.env === "object") {
        action.exports = Object.entries(pane.env).map(
          ([key, value]) => `export ${shellEscape(key)}=${shellEscape(String(value))}`
        );
      }
      let command2 = buildPaneCommand(pane);
      if (command2 && pane.title && /claude|codex/i.test(command2) && !command2.includes("--name")) {
        command2 = `${command2} --name ${shellEscape(pane.title)}`;
      }
      if (command2) {
        action.command = command2;
      }
      if (pane.focus) {
        focusPane = tmuxPane;
      }
      paneActions.push(action);
    }
  }
  return { focusPane, paneActions };
}
var init_launch_plan = __esm({
  "packages/daemon/src/lib/launch-plan.ts"() {
    "use strict";
    init_shell();
  }
});

// packages/daemon/src/lib/session-options.ts
function buildSessionOptions(session, { theme = {} } = {}) {
  return [
    ...themeOptions(session, theme),
    ...borderOptions(session, theme),
    ...behaviorOptions(session),
    ...statusBarOptions(session, theme),
    ...keyBindings()
  ];
}
function themeOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const bg = theme.bg ?? "colour235";
  const fg = theme.fg ?? "colour248";
  return [
    ["set-option", "-t", session, "status-style", `bg=${bg},fg=${fg}`],
    ["set-option", "-t", session, "pane-border-style", `fg=${border}`],
    ["set-option", "-t", session, "pane-active-border-style", `fg=${accent}`]
  ];
}
function borderOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";
  return [
    ["set-option", "-t", session, "pane-border-status", "top"],
    [
      "set-option",
      "-t",
      session,
      "pane-border-format",
      ` #{?pane_active,#[fg=${accent}#,bold]\u25B8 #T  #[fg=${fg}]#{pane_current_path},#[fg=${border}]\xB7 #T  #{pane_current_path}} `
    ]
  ];
}
function behaviorOptions(session) {
  return [
    ["set-option", "-t", session, "mouse", "on"],
    ["set-option", "-t", session, "escape-time", "0"],
    ["set-option", "-t", session, "status-interval", "1"]
  ];
}
function statusBarOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";
  const agentIndicator = [
    `#{?#{==:#{@agent_busy},1},#[fg=${accent}]\u23FA ,`,
    `#{?#{==:#{@agent_idle},1},#[fg=${border}]\u25CF ,}}`
  ].join("");
  const portIndicator = `#{?#{==:#{@has_port},1},#[fg=green]\u23FA ,}`;
  const paneStyle = `#{?pane_active,#[fg=${accent}],#[fg=${border}]}`;
  const paneTab = `${agentIndicator}${portIndicator}${paneStyle}#[range=pane|#{pane_id}] #T #[norange]#[default]`;
  const separator = `#{?loop_last_flag,,#[fg=${border}]\u2502}`;
  return [
    [
      "set-option",
      "-t",
      session,
      "status-left",
      `#[fg=colour0,bg=${accent},bold]  ${session.toUpperCase()} IDE #[default] `
    ],
    ["set-option", "-t", session, "status-left-length", "30"],
    [
      "set-option",
      "-t",
      session,
      "status-right",
      `#[fg=colour243]%H:%M #[fg=${accent}]\u2502 #[fg=${fg}]%b %d `
    ],
    ["set-option", "-t", session, "status-justify", "centre"],
    ["set-option", "-t", session, "window-status-current-format", `#[fg=${accent},bold]\u25CF`],
    ["set-option", "-t", session, "window-status-format", `#[fg=${border}]\u25CB`],
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-format[1]", `  #{P:${paneTab}${separator}}`]
  ];
}
function keyBindings() {
  return [["bind-key", "-n", "MouseDown1StatusDefault", "select-pane", "-t", "="]];
}
var init_session_options = __esm({
  "packages/daemon/src/lib/session-options.ts"() {
    "use strict";
  }
});

// packages/contracts/src/lib-internal/auth.ts
import { z } from "zod";
var AuthConfigSchema;
var init_auth = __esm({
  "packages/contracts/src/lib-internal/auth.ts"() {
    "use strict";
    AuthConfigSchema = z.object({
      /** Auth method: "none" disables auth (default), "ssh" enables SSH key challenge-response. */
      method: z.enum(["none", "ssh"]).default("none"),
      /** JWT secret — auto-generated if omitted. */
      secret: z.string().optional(),
      /** Token expiry in seconds (default 86400 = 24h). */
      token_expiry: z.number().min(60).default(86400)
    });
  }
});

// packages/contracts/src/lib-internal/hq.ts
import { z as z2 } from "zod";
var RegistrationPayloadSchema, HQConfigSchema;
var init_hq = __esm({
  "packages/contracts/src/lib-internal/hq.ts"() {
    "use strict";
    RegistrationPayloadSchema = z2.object({
      id: z2.string().min(1),
      name: z2.string().min(1),
      url: z2.string().url(),
      token: z2.string().min(1)
    });
    HQConfigSchema = z2.object({
      enabled: z2.boolean().default(false),
      role: z2.enum(["hq", "remote"]),
      hq_url: z2.string().url().optional(),
      secret: z2.string().optional(),
      heartbeat_interval: z2.number().min(1e3).default(15e3),
      machine_name: z2.string().optional()
    });
  }
});

// packages/contracts/src/ide-config.ts
import { z as z3 } from "zod";
var sizeField, ThemeConfigSchema, PaneSchema, RowSchema, WebhookConfigSchema, OrchestratorYamlConfigSchema, TunnelConfigSchema, CommandCenterConfigSchema, DashboardConfigSchema, SidebarConfigSchema, IdeConfigSchema, PaneActionSchema, SessionStateSchema;
var init_ide_config = __esm({
  "packages/contracts/src/ide-config.ts"() {
    "use strict";
    init_auth();
    init_hq();
    sizeField = z3.string().regex(/^[1-9]\d*%$/).refine((v) => parseInt(v) <= 100);
    ThemeConfigSchema = z3.object({
      accent: z3.string().optional(),
      border: z3.string().optional(),
      bg: z3.string().optional(),
      fg: z3.string().optional()
    });
    PaneSchema = z3.object({
      title: z3.string().optional(),
      command: z3.string().optional(),
      type: z3.enum([
        "explorer",
        "changes",
        "preview",
        "tasks",
        "costs",
        "config",
        "mission-control",
        "sidebar"
      ]).optional(),
      target: z3.string().optional(),
      dir: z3.string().optional(),
      size: sizeField.optional(),
      focus: z3.boolean().optional(),
      env: z3.record(z3.string(), z3.union([z3.string(), z3.number()])).optional(),
      role: z3.enum(["lead", "teammate", "planner", "validator", "researcher"]).optional(),
      task: z3.string().optional(),
      specialty: z3.string().optional(),
      skill: z3.string().optional()
    });
    RowSchema = z3.object({
      size: sizeField.optional(),
      panes: z3.array(PaneSchema).min(1)
    });
    WebhookConfigSchema = z3.object({
      url: z3.string(),
      events: z3.array(z3.string()).optional(),
      secret: z3.string().optional()
    });
    OrchestratorYamlConfigSchema = z3.object({
      enabled: z3.boolean().optional(),
      port: z3.number().int().positive().optional(),
      auto_dispatch: z3.boolean().optional(),
      stall_timeout: z3.number().optional(),
      poll_interval: z3.number().min(100).optional(),
      master_pane: z3.string().optional(),
      before_run: z3.string().optional(),
      after_run: z3.string().optional(),
      dispatch_mode: z3.enum(["tasks", "goals", "missions"]).optional(),
      max_concurrent_agents: z3.number().min(1).max(50).optional(),
      widgets: z3.boolean().optional(),
      webhooks: z3.array(WebhookConfigSchema).optional(),
      services: z3.record(
        z3.string(),
        z3.object({
          command: z3.string(),
          port: z3.number().optional(),
          healthcheck: z3.string().optional()
        })
      ).optional(),
      research: z3.object({
        enabled: z3.boolean().optional(),
        triggers: z3.object({
          mission_start: z3.boolean().optional(),
          milestone_progress: z3.number().min(0).optional(),
          milestone_complete: z3.boolean().optional(),
          periodic_minutes: z3.number().min(0).optional(),
          retry_cluster: z3.boolean().optional(),
          stall_detected: z3.boolean().optional(),
          discovered_issue: z3.boolean().optional()
        }).optional()
      }).optional()
    });
    TunnelConfigSchema = z3.object({
      provider: z3.enum(["tailscale", "ngrok", "cloudflare"]),
      auto_start: z3.boolean().optional(),
      port: z3.number().int().positive().optional(),
      domain: z3.string().optional(),
      authtoken: z3.string().optional()
    });
    CommandCenterConfigSchema = z3.object({
      port: z3.number().optional(),
      enabled: z3.boolean().optional()
    });
    DashboardConfigSchema = z3.object({
      port: z3.number().int().positive().optional()
    });
    SidebarConfigSchema = z3.union([
      z3.boolean(),
      z3.object({ width: z3.string().optional() })
    ]);
    IdeConfigSchema = z3.object({
      name: z3.string().optional(),
      before: z3.string().optional(),
      team: z3.object({
        name: z3.string(),
        model: z3.string().optional(),
        permissions: z3.array(z3.string()).optional()
      }).optional(),
      rows: z3.array(RowSchema).min(1),
      sidebar: SidebarConfigSchema.optional(),
      theme: ThemeConfigSchema.optional(),
      orchestrator: OrchestratorYamlConfigSchema.optional(),
      command_center: CommandCenterConfigSchema.optional(),
      dashboard: DashboardConfigSchema.optional(),
      auth: AuthConfigSchema.optional(),
      tunnel: TunnelConfigSchema.optional(),
      hq: HQConfigSchema.optional()
    });
    PaneActionSchema = z3.object({
      targetPane: z3.string(),
      title: z3.string().nullable(),
      chdir: z3.string().nullable(),
      exports: z3.array(z3.string()),
      command: z3.string().nullable(),
      widgetType: z3.string().nullable(),
      widgetTarget: z3.string().nullable(),
      paneRole: z3.string().nullable(),
      paneType: z3.string().nullable()
    });
    SessionStateSchema = z3.object({
      running: z3.boolean(),
      reason: z3.string().nullable()
    });
  }
});

// packages/contracts/src/domain.ts
import { z as z4 } from "zod";
var PaneInfoSchemaZ, SessionOverviewSchemaZ;
var init_domain = __esm({
  "packages/contracts/src/domain.ts"() {
    "use strict";
    PaneInfoSchemaZ = z4.object({
      id: z4.string(),
      index: z4.number(),
      title: z4.string(),
      currentCommand: z4.string(),
      width: z4.number(),
      height: z4.number(),
      active: z4.boolean(),
      role: z4.enum(["lead", "teammate", "planner", "validator", "researcher", "widget", "shell"]).nullable(),
      name: z4.string().nullable(),
      type: z4.string().nullable()
    });
    SessionOverviewSchemaZ = z4.object({
      name: z4.string(),
      dir: z4.string()
    });
  }
});

// packages/contracts/src/tmux.ts
import { z as z5 } from "zod";
var TmuxPaneSchemaZ, TmuxWindowSchemaZ, TmuxSessionSchemaZ, TmuxPaneTargetSchemaZ;
var init_tmux = __esm({
  "packages/contracts/src/tmux.ts"() {
    "use strict";
    TmuxPaneSchemaZ = z5.object({
      /** Stable tmux pane id (e.g. `%23`). */
      id: z5.string(),
      /** Pane index within its window (zero-based). */
      paneIndex: z5.number().int().nonnegative(),
      /** Window index within the session (zero-based). */
      windowIndex: z5.number().int().nonnegative(),
      title: z5.string().nullable(),
      command: z5.string().nullable(),
      active: z5.boolean()
    });
    TmuxWindowSchemaZ = z5.object({
      index: z5.number().int().nonnegative(),
      name: z5.string(),
      panes: z5.array(TmuxPaneSchemaZ)
    });
    TmuxSessionSchemaZ = z5.object({
      name: z5.string(),
      windows: z5.array(TmuxWindowSchemaZ),
      /** Session creation time (epoch milliseconds). */
      created: z5.number().int().nonnegative(),
      attached: z5.boolean(),
      /** Project directory the session was launched from, when known. */
      projectDir: z5.string().nullable()
    });
    TmuxPaneTargetSchemaZ = z5.discriminatedUnion("kind", [
      z5.object({ kind: z5.literal("byId"), id: z5.string() }),
      z5.object({ kind: z5.literal("byIndex"), index: z5.number().int().nonnegative() }),
      z5.object({ kind: z5.literal("byTitle"), title: z5.string() }),
      z5.object({ kind: z5.literal("byRole"), role: z5.string() })
    ]);
  }
});

// packages/contracts/src/workspace.ts
import { z as z6 } from "zod";
var WorkspaceSchemaZ, WorkspaceListResponseSchemaZ, AddWorkspaceRequestSchemaZ, AddWorkspaceResponseSchemaZ, WorkspaceAddedFrameSchemaZ, WorkspaceRemovedFrameSchemaZ;
var init_workspace = __esm({
  "packages/contracts/src/workspace.ts"() {
    "use strict";
    WorkspaceSchemaZ = z6.object({
      /** Stable workspace name (typically equal to tmux session name). */
      name: z6.string().min(1),
      /** Tmux session this workspace maps to. */
      sessionName: z6.string().min(1),
      /** Absolute project directory. */
      projectDir: z6.string().min(1),
      /** Absolute path to the ide.yml driving this workspace. */
      ideConfigPath: z6.string().nullable(),
      /** ISO timestamp of when the workspace was added. */
      addedAt: z6.string()
    });
    WorkspaceListResponseSchemaZ = z6.object({
      workspaces: z6.array(WorkspaceSchemaZ)
    });
    AddWorkspaceRequestSchemaZ = z6.object({
      /** Absolute path to the project directory. */
      projectDir: z6.string().min(1),
      /** Optional explicit workspace name. Auto-derived from basename when absent. */
      name: z6.string().min(1).optional(),
      /** Optional override for the tmux session name (defaults to `name`). */
      sessionName: z6.string().min(1).optional(),
      /** Optional ide.yml path the workspace was launched with. */
      ideConfigPath: z6.string().min(1).optional()
    });
    AddWorkspaceResponseSchemaZ = z6.object({
      workspace: WorkspaceSchemaZ
    });
    WorkspaceAddedFrameSchemaZ = z6.object({
      type: z6.literal("workspace.added"),
      workspace: WorkspaceSchemaZ
    });
    WorkspaceRemovedFrameSchemaZ = z6.object({
      type: z6.literal("workspace.removed"),
      name: z6.string()
    });
  }
});

// packages/contracts/src/actions-contract.ts
import { z as z7 } from "zod";
function isActionName(name) {
  return name in ActionContractsZ;
}
var ProjectOpenTerminalInputZ, ProjectOpenTerminalResultZ, ProjectLaunchInputZ, ProjectLaunchResultZ, ProjectStopInputZ, ProjectStopResultZ, ProjectRestartInputZ, ProjectRestartResultZ, ProjectActivateInputZ, ProjectActivateResultZ, TerminalRespawnInputZ, TerminalRespawnResultZ, TerminalStopInputZ, TerminalStopResultZ, ConfigSetInputZ, ConfigResultZ, ConfigAddPaneInputZ, ConfigAddPaneResultZ, ConfigRemovePaneInputZ, ConfigRemovePaneResultZ, ConfigAddRowInputZ, ConfigAddRowResultZ, ConfigEnableTeamInputZ, ConfigEnableTeamResultZ, ConfigDisableTeamInputZ, ConfigDisableTeamResultZ, AppSetRemoteAccessInputZ, AppSetRemoteAccessResultZ, DaemonShutdownInputZ, DaemonShutdownResultZ, ActionContractsZ, ACTION_NAMES;
var init_actions_contract = __esm({
  "packages/contracts/src/actions-contract.ts"() {
    "use strict";
    init_ide_config();
    ProjectOpenTerminalInputZ = z7.object({
      name: z7.string().min(1)
    });
    ProjectOpenTerminalResultZ = z7.object({
      sessionName: z7.string(),
      cwd: z7.string().min(1),
      terminalTabId: z7.string(),
      /**
       * `true` when the dispatcher had to launch the tmux session as part of
       * resolving the terminal. `false` when the session was already running.
       */
      launched: z7.boolean()
    });
    ProjectLaunchInputZ = z7.object({
      name: z7.string().min(1)
    });
    ProjectLaunchResultZ = z7.object({
      sessionName: z7.string(),
      /**
       * `false` when the session was already running (idempotent no-op),
       * `true` when this call started a fresh session.
       */
      started: z7.boolean()
    });
    ProjectStopInputZ = z7.object({
      name: z7.string().min(1)
    });
    ProjectStopResultZ = z7.object({
      sessionName: z7.string(),
      /**
       * `false` when no session was running (idempotent no-op),
       * `true` when this call killed a session.
       */
      stopped: z7.boolean()
    });
    ProjectRestartInputZ = z7.object({
      name: z7.string().min(1)
    });
    ProjectRestartResultZ = z7.object({
      sessionName: z7.string(),
      restarted: z7.literal(true)
    });
    ProjectActivateInputZ = z7.object({
      name: z7.string().min(1)
    });
    ProjectActivateResultZ = z7.object({
      active: z7.boolean(),
      projectName: z7.string()
    });
    TerminalRespawnInputZ = z7.object({
      sessionName: z7.string().min(1),
      terminalId: z7.string().min(1),
      /**
       * Optional cwd override. Omit to respawn at the bridge's current cwd
       * (re-using the `lastCwd` recorded by the PTY bridge).
       */
      cwd: z7.string().min(1).optional()
    });
    TerminalRespawnResultZ = z7.object({
      respawned: z7.literal(true),
      cwd: z7.string().min(1)
    });
    TerminalStopInputZ = z7.object({
      sessionName: z7.string().min(1),
      terminalId: z7.string().min(1)
    });
    TerminalStopResultZ = z7.object({
      stopped: z7.literal(true)
    });
    ConfigSetInputZ = z7.object({
      projectName: z7.string().min(1).optional(),
      path: z7.string().min(1),
      value: z7.unknown()
    });
    ConfigResultZ = z7.object({
      config: IdeConfigSchema
    });
    ConfigAddPaneInputZ = PaneSchema.partial().extend({
      projectName: z7.string().min(1).optional(),
      rowIndex: z7.number().int().min(0)
    });
    ConfigAddPaneResultZ = ConfigResultZ;
    ConfigRemovePaneInputZ = z7.object({
      projectName: z7.string().min(1).optional(),
      rowIndex: z7.number().int().min(0),
      paneIndex: z7.number().int().min(0)
    });
    ConfigRemovePaneResultZ = ConfigResultZ;
    ConfigAddRowInputZ = z7.object({
      projectName: z7.string().min(1).optional(),
      size: z7.string().optional()
    });
    ConfigAddRowResultZ = ConfigResultZ;
    ConfigEnableTeamInputZ = z7.object({
      projectName: z7.string().min(1).optional(),
      name: z7.string().min(1).optional()
    });
    ConfigEnableTeamResultZ = ConfigResultZ;
    ConfigDisableTeamInputZ = z7.object({
      projectName: z7.string().min(1).optional()
    });
    ConfigDisableTeamResultZ = ConfigResultZ;
    AppSetRemoteAccessInputZ = z7.object({
      enabled: z7.boolean()
    });
    AppSetRemoteAccessResultZ = z7.object({
      enabled: z7.boolean(),
      url: z7.string().nullable(),
      token: z7.string().nullable(),
      qrPayload: z7.string().nullable()
    });
    DaemonShutdownInputZ = z7.object({
      reason: z7.string().optional()
    });
    DaemonShutdownResultZ = z7.object({
      stopping: z7.literal(true)
    });
    ActionContractsZ = {
      "project.openTerminal": {
        input: ProjectOpenTerminalInputZ,
        result: ProjectOpenTerminalResultZ
      },
      "project.launch": {
        input: ProjectLaunchInputZ,
        result: ProjectLaunchResultZ
      },
      "project.stop": {
        input: ProjectStopInputZ,
        result: ProjectStopResultZ
      },
      "project.restart": {
        input: ProjectRestartInputZ,
        result: ProjectRestartResultZ
      },
      "project.activate": {
        input: ProjectActivateInputZ,
        result: ProjectActivateResultZ
      },
      "terminal.respawn": {
        input: TerminalRespawnInputZ,
        result: TerminalRespawnResultZ
      },
      "terminal.stop": {
        input: TerminalStopInputZ,
        result: TerminalStopResultZ
      },
      "config.set": {
        input: ConfigSetInputZ,
        result: ConfigResultZ
      },
      "config.addPane": {
        input: ConfigAddPaneInputZ,
        result: ConfigAddPaneResultZ
      },
      "config.removePane": {
        input: ConfigRemovePaneInputZ,
        result: ConfigRemovePaneResultZ
      },
      "config.addRow": {
        input: ConfigAddRowInputZ,
        result: ConfigAddRowResultZ
      },
      "config.enableTeam": {
        input: ConfigEnableTeamInputZ,
        result: ConfigEnableTeamResultZ
      },
      "config.disableTeam": {
        input: ConfigDisableTeamInputZ,
        result: ConfigDisableTeamResultZ
      },
      "app.setRemoteAccess": {
        input: AppSetRemoteAccessInputZ,
        result: AppSetRemoteAccessResultZ
      },
      "daemon.shutdown": {
        input: DaemonShutdownInputZ,
        result: DaemonShutdownResultZ
      }
    };
    ACTION_NAMES = Object.keys(ActionContractsZ);
  }
});

// packages/contracts/src/actions-errors.ts
var init_actions_errors = __esm({
  "packages/contracts/src/actions-errors.ts"() {
    "use strict";
  }
});

// packages/contracts/src/terminals.ts
import { z as z8 } from "zod";
async function createScriptTerminalId(args) {
  const scope = args.scopeId ?? args.taskId;
  if (!scope) {
    throw new Error("createScriptTerminalId: scopeId (or taskId) is required");
  }
  const key = `${args.projectId}::${scope}::${args.kind}::${args.script}`;
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
var terminalKindSchema, terminalCreateRequestSchema, terminalRenameRequestSchema;
var init_terminals = __esm({
  "packages/contracts/src/terminals.ts"() {
    "use strict";
    terminalKindSchema = z8.enum(["shell", "setup", "run", "teardown"]);
    terminalCreateRequestSchema = z8.object({
      scopeId: z8.string().trim().min(1).max(256),
      name: z8.string().trim().min(1).max(120),
      kind: terminalKindSchema.optional(),
      /** Provide for script tabs to opt into deterministic id collapse. */
      script: z8.string().max(2048).optional(),
      /** Explicit id wins. Used by the dashboard to reserve a known id
       *  (e.g. the default shell tab derived from session.dir). */
      id: z8.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/u, "id may only contain alphanumerics, '-', '_'").optional()
    }).refine((v) => v.kind !== void 0 || v.script === void 0, {
      message: "script requires kind",
      path: ["script"]
    });
    terminalRenameRequestSchema = z8.object({
      name: z8.string().trim().min(1).max(120)
    });
  }
});

// packages/contracts/src/control.ts
import { z as z9 } from "zod";
var CONTROL_PROTOCOL_VERSION, controlIdSchema, agentStatusSchema, controlRequestSchema, controlErrorSchema, controlResponseSchema, controlEventSchema, agentStatusEventSchema, agentsParamsSchema, sendParamsSchema, CONTROL_WAIT_MAX_TIMEOUT_MS, waitTimeoutSchema, waitParamsSchema, spawnPlacementSchema, spawnParamsSchema, restartAgentParamsSchema, stopAgentParamsSchema, explainParamsSchema, subscribeParamsSchema;
var init_control = __esm({
  "packages/contracts/src/control.ts"() {
    "use strict";
    CONTROL_PROTOCOL_VERSION = 1;
    controlIdSchema = z9.union([z9.string(), z9.number()]);
    agentStatusSchema = z9.enum(["blocked", "working", "done", "idle", "unknown"]);
    controlRequestSchema = z9.object({
      v: z9.literal(CONTROL_PROTOCOL_VERSION),
      id: controlIdSchema,
      verb: z9.string().min(1),
      params: z9.record(z9.string(), z9.unknown()).optional()
    });
    controlErrorSchema = z9.object({
      code: z9.string(),
      message: z9.string()
    });
    controlResponseSchema = z9.discriminatedUnion("ok", [
      z9.object({
        v: z9.literal(CONTROL_PROTOCOL_VERSION),
        id: controlIdSchema.nullable(),
        ok: z9.literal(true),
        data: z9.unknown()
      }),
      z9.object({
        v: z9.literal(CONTROL_PROTOCOL_VERSION),
        id: controlIdSchema.nullable(),
        ok: z9.literal(false),
        error: controlErrorSchema
      })
    ]);
    controlEventSchema = z9.object({
      v: z9.literal(CONTROL_PROTOCOL_VERSION),
      event: z9.string().min(1),
      data: z9.unknown()
    });
    agentStatusEventSchema = z9.object({
      ts: z9.string(),
      session: z9.string(),
      from: agentStatusSchema.nullable(),
      to: agentStatusSchema
    });
    agentsParamsSchema = z9.object({
      session: z9.string().optional()
    });
    sendParamsSchema = z9.object({
      session: z9.string().min(1),
      target: z9.string().min(1),
      message: z9.string().min(1),
      noEnter: z9.boolean().optional(),
      dir: z9.string().optional()
    });
    CONTROL_WAIT_MAX_TIMEOUT_MS = 6e5;
    waitTimeoutSchema = z9.number().int().positive().max(CONTROL_WAIT_MAX_TIMEOUT_MS).optional();
    waitParamsSchema = z9.discriminatedUnion("kind", [
      z9.object({
        kind: z9.literal("agent-status"),
        session: z9.string().min(1),
        status: agentStatusSchema,
        timeoutMs: waitTimeoutSchema
      }),
      z9.object({
        kind: z9.literal("output"),
        target: z9.string().min(1),
        match: z9.string().min(1),
        timeoutMs: waitTimeoutSchema
      })
    ]);
    spawnPlacementSchema = z9.enum(["window", "split-h", "split-v"]);
    spawnParamsSchema = z9.object({
      kind: z9.string().min(1).optional(),
      command: z9.string().min(1).optional(),
      session: z9.string().min(1).optional(),
      sessionName: z9.string().min(1).optional(),
      dir: z9.string().optional(),
      placement: spawnPlacementSchema.optional(),
      paneId: z9.string().optional()
    }).refine((p) => Boolean(p.kind) !== Boolean(p.command), {
      message: "exactly one of `kind` or `command` is required"
    }).refine((p) => Boolean(p.session) || Boolean(p.sessionName), {
      message: "`session` (spawn into it) or `sessionName` (create it) is required"
    }).refine((p) => !(p.placement && p.placement !== "window") || Boolean(p.paneId), {
      message: "split placements need `paneId`"
    });
    restartAgentParamsSchema = z9.object({
      paneId: z9.string().min(1),
      kind: z9.string().min(1).optional(),
      command: z9.string().min(1).optional()
    }).refine((p) => Boolean(p.kind) || Boolean(p.command), {
      message: "`kind` or `command` is required"
    });
    stopAgentParamsSchema = z9.object({
      paneId: z9.string().min(1)
    });
    explainParamsSchema = z9.object({
      target: z9.string().min(1)
    });
    subscribeParamsSchema = z9.object({}).loose();
  }
});

// packages/contracts/src/index.ts
var init_src2 = __esm({
  "packages/contracts/src/index.ts"() {
    "use strict";
    init_auth();
    init_hq();
    init_ide_config();
    init_domain();
    init_tmux();
    init_workspace();
    init_actions_contract();
    init_actions_errors();
    init_terminals();
    init_control();
  }
});

// packages/daemon/src/schemas/ide-config.ts
var init_ide_config2 = __esm({
  "packages/daemon/src/schemas/ide-config.ts"() {
    "use strict";
    init_src2();
  }
});

// packages/daemon/src/validate.ts
import { resolve as resolve3 } from "node:path";
function validateConfig(config2) {
  if (config2 == null || typeof config2 !== "object" || Array.isArray(config2)) {
    return ["config must be an object"];
  }
  const result = IdeConfigSchema.safeParse(config2);
  if (!result.success) {
    return result.error.issues.map((issue) => mapZodIssue(issue, config2));
  }
  const errors = [];
  const cfg = result.data;
  const rowSizes = cfg.rows.filter((r) => r.size !== void 0).map((r) => parseInt(r.size, 10));
  const rowSum = rowSizes.reduce((a, b) => a + b, 0);
  if (rowSum > 100) {
    errors.push(`Row sizes sum to ${rowSum}%, which exceeds 100%`);
  }
  for (let i = 0; i < cfg.rows.length; i++) {
    const row = cfg.rows[i];
    const paneSizes = row.panes.filter((p) => p.size !== void 0).map((p) => parseInt(p.size, 10));
    const paneSum = paneSizes.reduce((a, b) => a + b, 0);
    if (paneSum > 100) {
      errors.push(`Row ${i} pane sizes sum to ${paneSum}%, which exceeds 100%`);
    }
    const focusCount = row.panes.filter((p) => p.focus === true).length;
    if (focusCount > 1) {
      errors.push(`Row ${i} has ${focusCount} panes with focus: true (max 1)`);
    }
    for (let j = 0; j < row.panes.length; j++) {
      const pane = row.panes[j];
      if (pane.type !== void 0 && pane.command !== void 0) {
        errors.push(`rows[${i}].panes[${j}] cannot have both 'type' and 'command'`);
      }
    }
  }
  return errors;
}
function formatPath(path2) {
  let result = "";
  for (let i = 0; i < path2.length; i++) {
    const seg = path2[i];
    if (typeof seg === "number") {
      result += `[${seg}]`;
    } else if (i === 0) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}
function shouldQuote(path2) {
  if (path2.length === 1 && typeof path2[0] === "string") return true;
  if (path2[0] === "team") return true;
  return false;
}
function isSizePath(path2) {
  return path2[path2.length - 1] === "size";
}
function isEnvValuePath(path2) {
  const envIdx = path2.indexOf("env");
  return envIdx >= 0 && envIdx < path2.length - 1;
}
function getValueAtPath(obj, path2) {
  let current = obj;
  for (const seg of path2) {
    if (current == null || typeof current !== "object") return void 0;
    current = current[String(seg)];
  }
  return current;
}
function typeDesc(path2, expected) {
  const base = expected.replace(/\s*\|\s*undefined/g, "").trim();
  let desc;
  if (base === "string") desc = "a string";
  else if (base === "boolean") desc = "a boolean";
  else if (base === "number") desc = "a number";
  else if (base === "array") desc = "an array";
  else if (base === "object" || base === "record") desc = "an object";
  else desc = base;
  const field = path2[path2.length - 1];
  if (path2[0] === "orchestrator" && typeof field === "string" && MS_FIELDS.has(field)) {
    return `${desc} (ms)`;
  }
  return desc;
}
function mapZodIssue(issue, config2) {
  const path2 = issue.path ?? [];
  const code = issue.code ?? "";
  const rawPath = formatPath(path2);
  const display = shouldQuote(path2) ? `'${rawPath}'` : rawPath;
  const lastSeg = path2[path2.length - 1];
  if (isEnvValuePath(path2)) {
    return `${formatPath(path2)} must be a string or number`;
  }
  if (isSizePath(path2) && code !== "invalid_type") {
    if (code === "custom") {
      return `${rawPath} must not exceed 100%`;
    }
    const val = getValueAtPath(config2, path2);
    return `${rawPath} "${val}" must be a percentage (e.g. "50%")`;
  }
  if (code === "too_small") {
    return `${display} must not be empty`;
  }
  if (code === "invalid_value" && lastSeg === "type" && path2.includes("panes")) {
    return `${rawPath} must be one of: explorer, changes, preview, tasks, costs, config, mission-control`;
  }
  if (code === "invalid_value" && lastSeg === "role") {
    return `${rawPath} must be "lead", "teammate", or "planner"`;
  }
  if (code === "invalid_value" && lastSeg === "dispatch_mode") {
    return `${rawPath} must be "tasks" or "goals"`;
  }
  if (path2.length === 2 && path2[0] === "team" && path2[1] === "name") {
    if (issue.received === "undefined") {
      return "'team.name' is required when team is specified";
    }
  }
  if (code === "invalid_type") {
    return `${display} must be ${typeDesc(path2, issue.expected ?? "")}`;
  }
  return `${display}: ${issue.message ?? "invalid value"}`;
}
async function validate(targetDir, { json: json2 } = {}) {
  const dir = resolve3(targetDir ?? ".");
  let config2;
  try {
    ({ config: config2 } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }
  const errors = validateConfig(config2);
  const valid = errors.length === 0;
  if (json2) {
    console.log(JSON.stringify({ valid, errors }, null, 2));
    return;
  }
  if (valid) {
    console.log("\u2713 ide.yml is valid");
  } else {
    console.log("\u2717 ide.yml has errors:");
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    process.exitCode = 1;
  }
}
var MS_FIELDS;
var init_validate = __esm({
  "packages/daemon/src/validate.ts"() {
    "use strict";
    init_yaml_io();
    init_output();
    init_ide_config2();
    MS_FIELDS = /* @__PURE__ */ new Set(["stall_timeout", "poll_interval"]);
  }
});

// packages/daemon/src/tui/detect/manifest.ts
function resolveRegion(snapshot, region) {
  switch (region) {
    case "text":
      return snapshot.text;
    case "title":
      return snapshot.title ?? "";
    case "bottom":
    default:
      return snapshot.bottomNonEmpty.join("\n");
  }
}
function safeRegex(source, caseInsensitive) {
  try {
    return new RegExp(source, caseInsensitive ? "i" : "");
  } catch {
    return void 0;
  }
}
function matchMatcher(snapshot, matcher) {
  const haystack = resolveRegion(snapshot, matcher.region ?? "bottom");
  if (matcher.contains !== void 0) {
    if (matcher.caseInsensitive) {
      return haystack.toLowerCase().includes(matcher.contains.toLowerCase());
    }
    return haystack.includes(matcher.contains);
  }
  if (matcher.regex !== void 0) {
    const re = safeRegex(matcher.regex, matcher.caseInsensitive);
    return re ? re.test(haystack) : false;
  }
  return false;
}
function matchRule(snapshot, rule) {
  const hasAll = rule.all !== void 0 && rule.all.length > 0;
  const hasAny = rule.any !== void 0 && rule.any.length > 0;
  if (!hasAll && !hasAny) return false;
  if (hasAll && !rule.all.every((m) => matchMatcher(snapshot, m))) return false;
  if (hasAny && !rule.any.some((m) => matchMatcher(snapshot, m))) return false;
  return true;
}
function evaluateManifest(snapshot, manifest) {
  for (const state of PRECEDENCE) {
    const rule = manifest.states[state];
    if (rule && matchRule(snapshot, rule)) {
      const matcher = firstMatchingMatcher(snapshot, rule);
      return matcher ? { state, matched: { state, matcher } } : { state };
    }
  }
  return { state: null };
}
function firstMatchingMatcher(snapshot, rule) {
  const matchers = [...rule.all ?? [], ...rule.any ?? []];
  return matchers.find((m) => matchMatcher(snapshot, m));
}
function explain(snapshot, manifest) {
  const checked = PRECEDENCE.map((state) => {
    const rule = manifest.states[state];
    return { state, matched: rule ? matchRule(snapshot, rule) : false };
  });
  const winner = checked.find((c) => c.matched);
  return { state: winner ? winner.state : null, checked };
}
function pickManifest(command2, manifests) {
  const cmd = command2.trim().toLowerCase();
  if (cmd.length === 0) return void 0;
  const exact = manifests.find((m) => m.commands.some((c) => c.toLowerCase() === cmd));
  if (exact) return exact;
  return manifests.find(
    (m) => m.commands.some((c) => {
      const name = c.toLowerCase();
      return cmd.includes(name) || name.includes(cmd);
    })
  );
}
var PRECEDENCE;
var init_manifest = __esm({
  "packages/daemon/src/tui/detect/manifest.ts"() {
    "use strict";
    PRECEDENCE = ["blocked", "working", "done"];
  }
});

// packages/daemon/src/tui/detect/manifests.ts
var BRAILLE_SPINNER, CLAUDE, CODEX, OPENCODE, GEMINI, AIDER, COPILOT, CURSOR, GOOSE, AMP, SHELL, BUNDLED_MANIFESTS;
var init_manifests = __esm({
  "packages/daemon/src/tui/detect/manifests.ts"() {
    "use strict";
    BRAILLE_SPINNER = "[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]";
    CLAUDE = {
      id: "claude",
      commands: ["claude"],
      confidence: "tuned",
      states: {
        // Approval / confirmation prompts — Claude is waiting on the user.
        // Claude's approval UI is a bordered box asking a "Do you want …?" question
        // with a numbered arrow menu ("❯ 1. Yes" / "3. No, and tell Claude …").
        // These phrases are approval-specific and never appear in the idle chrome
        // (a bare "❯ " input box) or the "How is Claude doing this session?" survey
        // (which uses "1: Bad" colon-style options, not "❯ 1.").
        blocked: {
          any: [
            // seen (approval dialogs): "Do you want to proceed?" / "Do you want to
            // make this edit to …"
            { region: "bottom", contains: "Do you want" },
            // seen: the highlighted first option of the numbered approval menu.
            { region: "bottom", contains: "\u276F 1." },
            // seen: "2. Yes, and don't ask again this session"
            { region: "bottom", contains: "Yes, and" },
            // seen: "3. No, and tell Claude what to do differently"
            { region: "bottom", contains: "No, and tell Claude" }
          ]
        },
        // Streaming / thinking indicators. While Claude works the bottom line shows
        // a spinner + gerund + the interrupt hint, e.g.
        //   "✳ Cerebrating… (esc to interrupt · ctrl+t to hide todos)".
        working: {
          any: [
            // seen: the interrupt hint is present for the entire duration of a turn
            // — the single most reliable "working" invariant.
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            // seen: the animated status verb ("Thinking…", "Cerebrating…").
            { region: "bottom", contains: "Thinking" },
            { region: "bottom", contains: "Cerebrating" },
            // The leading braille spinner glyph, in the body or (rarely) the title.
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
        // done: intentionally omitted — inferred by the classifier's seen-tracking.
        // NOTE (seen, NOT used): idle Claude shows a bordered "❯ " input box with a
        // "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents" or
        // "? for shortcuts · ← for agents" footer, and finished turns leave a
        // "✻ Brewed for 9s" summary — none of these are working/blocked evidence,
        // so they are deliberately absent and fall through to idle.
      }
    };
    CODEX = {
      id: "codex",
      commands: ["codex", "codex.exe"],
      confidence: "tuned",
      states: {
        // TUNED against real captures (codex-cli v0.142.5, driven through a turn).
        // The command-approval dialog and the directory-trust prompt are the two
        // "blocked" screens. Codex's approval menu uses a "› 1." numbered arrow —
        // note the arrow is "›" (U+203A), NOT claude's "❯".
        blocked: {
          any: [
            // seen (command approval): "Would you like to run the following
            // command?" above a "$ <cmd>" preview and the numbered menu.
            { region: "bottom", contains: "Would you like to run", caseInsensitive: true },
            // seen: the highlighted approval option "› 1. Yes, proceed".
            { region: "bottom", contains: "Yes, proceed" },
            // seen: "3. No, and tell Codex what to do differently (esc)".
            { region: "bottom", contains: "No, and tell Codex" },
            // seen: the confirm footer under the approval menu.
            { region: "bottom", contains: "Press enter to confirm", caseInsensitive: true },
            // seen (directory-trust prompt on first launch in an untrusted dir):
            // "Do you trust the contents of this directory?" + "1. Yes, continue".
            { region: "bottom", contains: "Do you trust the contents", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            // seen (verbatim): the working status line is
            //   "• Working (6s • esc to interrupt)".
            // Both the "Working (" prefix and the shared "esc to interrupt" hint
            // are present for the whole turn.
            { region: "bottom", regex: "Working \\(\\d" },
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
        // done: omitted. NOTE (seen, NOT used): a finished turn leaves the agent's
        // answer above the idle "›" input box (placeholder "Find and fix a bug in
        // @filename") and a "gpt-5.5 xhigh · <cwd>" status line; older builds also
        // showed "Goal achieved (5m)". None are working/blocked evidence, so codex
        // correctly falls through to idle and the classifier infers done.
      }
    };
    OPENCODE = {
      id: "opencode",
      commands: ["opencode", "opencode.exe"],
      confidence: "conservative",
      states: {
        // conservative — a live capture was attempted (opencode v1.17.10) but its
        // local auth DB errored ("no such column: name") and the TUI rendered
        // blank, so these stay best-effort. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "[y/n]", caseInsensitive: true },
            { region: "bottom", contains: "Do you want" }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    GEMINI = {
      id: "gemini",
      commands: ["gemini"],
      confidence: "conservative",
      states: {
        // conservative — gemini-cli needs a Google account/API key to reach a
        // working state, so no live capture was taken. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "Apply this change", caseInsensitive: true },
            { region: "bottom", contains: "Allow execution", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            // gemini-cli shows an "(esc to cancel)" hint during a turn.
            { region: "bottom", contains: "esc to cancel", caseInsensitive: true },
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    AIDER = {
      id: "aider",
      commands: ["aider"],
      confidence: "tuned",
      states: {
        // TUNED from aider's installed source (v0.86.2). Every confirmation renders
        // through `io.confirm_ask` (io.py), which appends the literal option string
        // " (Y)es/(N)o" (plus "/(A)ll/(S)kip all" or "/(D)on't ask again") and a
        // "[Yes]:"/"[No]:" default — so "(Y)es/(N)o" is aider's exact, universal
        // blocked marker. The specific questions below are verbatim from
        // base_coder.py / commands.py.
        blocked: {
          any: [
            { region: "bottom", contains: "(Y)es/(N)o", caseInsensitive: true },
            { region: "bottom", contains: "Add file to the chat", caseInsensitive: true },
            { region: "bottom", contains: "Allow edits to file", caseInsensitive: true },
            { region: "bottom", contains: "Add command output to the chat", caseInsensitive: true },
            { region: "bottom", contains: "Run pip install", caseInsensitive: true }
          ]
        },
        // TUNED: while a turn runs aider shows a `WaitingSpinner` (waiting.py)
        // rendered as "[░█   ] Waiting for <model>" — the text is literally
        // "Waiting for LLM" or "Waiting for " + the model name (base_coder.py:1440).
        // aider's spinner uses a "░█" scanner, NOT braille, so "Waiting for " is the
        // real invariant; the braille probe is kept only as a harmless fallback.
        working: {
          any: [
            { region: "bottom", contains: "Waiting for ", caseInsensitive: false },
            { region: "bottom", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    COPILOT = {
      id: "copilot",
      commands: ["copilot", "github-copilot", "github-copilot-cli"],
      confidence: "conservative",
      states: {
        // conservative — github-copilot-cli needs a GitHub account, so no live
        // capture was taken. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "Select an option", caseInsensitive: true },
            { region: "bottom", contains: "Allow", caseInsensitive: false }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    CURSOR = {
      id: "cursor",
      commands: ["cursor-agent", "cursor"],
      confidence: "conservative",
      states: {
        // conservative — cursor-agent (Cursor CLI) was launched live but sits on a
        // "Press any key to log in…" pre-auth screen without an account, so no
        // working/blocked turn could be captured. The pre-auth splash ("Cursor
        // Agent" / "Press any key to log in") is idle chrome and deliberately NOT
        // matched here. Markers below are high-precision guesses from public
        // knowledge of its approval/streaming UI. NOTE: cursor-agent runs under
        // `node`, so it resolves via the process-tree (argv0 basename), not the
        // pane's `current_command`.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Run this command", caseInsensitive: true },
            { region: "bottom", contains: "Apply this edit", caseInsensitive: true },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    GOOSE = {
      id: "goose",
      commands: ["goose"],
      confidence: "conservative",
      states: {
        // conservative — Block's goose CLI needs a configured provider, so no live
        // capture was taken. High-precision only; markers are best-effort from
        // public knowledge of its confirmation/streaming UI.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Allow this tool", caseInsensitive: true },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "[y/n]", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    AMP = {
      id: "amp",
      commands: ["amp"],
      confidence: "conservative",
      states: {
        // conservative — Sourcegraph's amp CLI needs an account, so no live capture
        // was taken. High-precision only; markers are best-effort from public
        // knowledge of its approval/streaming UI.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Allow", caseInsensitive: false },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    SHELL = {
      id: "shell",
      commands: ["bash", "zsh", "sh", "fish", "nu"],
      confidence: "conservative",
      states: {
        // Catch-all: a raw shell is almost always idle. We only flag an explicit
        // interactive confirmation as blocked; "working" is unreliable to read
        // from a shell snapshot, so it stays absent (idle by default).
        blocked: {
          any: [
            { region: "bottom", contains: "[y/n]", caseInsensitive: true },
            { region: "bottom", contains: "(yes/no)", caseInsensitive: true }
          ]
        }
      }
    };
    BUNDLED_MANIFESTS = [
      CLAUDE,
      CODEX,
      OPENCODE,
      GEMINI,
      AIDER,
      COPILOT,
      CURSOR,
      GOOSE,
      AMP,
      SHELL
    ];
  }
});

// packages/daemon/src/tui/detect/classify.ts
var classify_exports = {};
__export(classify_exports, {
  classifyInstant: () => classifyInstant,
  classifyPaneCommand: () => classifyPaneCommand,
  createStatusTracker: () => createStatusTracker,
  parseAuthority: () => parseAuthority,
  parseAuthorityEpoch: () => parseAuthorityEpoch
});
function parseAuthority(raw, nowSec) {
  if (!raw) return null;
  const sep2 = raw.lastIndexOf(":");
  if (sep2 === -1) return null;
  const state = raw.slice(0, sep2);
  const epoch = Number(raw.slice(sep2 + 1));
  if (!AUTHORITY_STATES.has(state) || !Number.isFinite(epoch)) return null;
  if ((state === "working" || state === "blocked") && nowSec - epoch > AUTHORITY_STALE_SECONDS) {
    return null;
  }
  return state;
}
function parseAuthorityEpoch(raw) {
  if (!raw) return null;
  const sep2 = raw.lastIndexOf(":");
  if (sep2 === -1) return null;
  const epoch = Number(raw.slice(sep2 + 1));
  return Number.isFinite(epoch) ? epoch : null;
}
function classifyInstant(snapshot, manifest) {
  if (!manifest) return "unknown";
  const { state } = evaluateManifest(snapshot, manifest);
  switch (state) {
    case "blocked":
      return "blocked";
    case "working":
      return "working";
    // "done" (instantaneous) and null both fall through to idle.
    default:
      return "idle";
  }
}
function classifyPaneCommand(snapshot, command2, manifests = BUNDLED_MANIFESTS) {
  return classifyInstant(snapshot, pickManifest(command2, manifests));
}
function createStatusTracker() {
  const states = /* @__PURE__ */ new Map();
  function get(paneId) {
    let s = states.get(paneId);
    if (!s) {
      s = { wasWorking: false, doneUnseen: false };
      states.set(paneId, s);
    }
    return s;
  }
  return {
    update(paneId, instant, opts) {
      const seen = opts?.seen === true;
      const s = get(paneId);
      switch (instant) {
        case "working":
          s.doneUnseen = false;
          s.wasWorking = true;
          return "working";
        case "blocked":
          s.doneUnseen = false;
          s.wasWorking = false;
          return "blocked";
        case "idle": {
          if (s.wasWorking) s.doneUnseen = true;
          s.wasWorking = false;
          if (seen) {
            s.doneUnseen = false;
            return "idle";
          }
          return s.doneUnseen ? "done" : "idle";
        }
        case "unknown":
        default:
          s.wasWorking = false;
          if (seen) s.doneUnseen = false;
          return "unknown";
      }
    },
    markSeen(paneId) {
      const s = states.get(paneId);
      if (s) s.doneUnseen = false;
    },
    forget(paneId) {
      states.delete(paneId);
    }
  };
}
var AUTHORITY_STALE_SECONDS, AUTHORITY_STATES;
var init_classify = __esm({
  "packages/daemon/src/tui/detect/classify.ts"() {
    "use strict";
    init_manifest();
    init_manifests();
    AUTHORITY_STALE_SECONDS = 600;
    AUTHORITY_STATES = /* @__PURE__ */ new Set(["working", "blocked", "done", "idle"]);
  }
});

// packages/daemon/src/tui/detect/manifest-loader.ts
import { readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function overrideDir() {
  return join(homedir(), ".tmux-ide", "agent-detection");
}
function validateManifestShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  if (typeof m.id !== "string" || m.id.trim().length === 0) return false;
  if (!Array.isArray(m.commands) || m.commands.length === 0) return false;
  if (!m.commands.every((c) => typeof c === "string" && c.length > 0)) return false;
  if (typeof m.states !== "object" || m.states === null) return false;
  const states = m.states;
  for (const key of ["blocked", "working", "done"]) {
    if (!(key in states)) continue;
    if (!isRuleShape(states[key])) return false;
  }
  return true;
}
function isRuleShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const r = value;
  for (const key of ["all", "any"]) {
    if (!(key in r)) continue;
    const arr = r[key];
    if (!Array.isArray(arr) || !arr.every(isMatcherShape)) return false;
  }
  return true;
}
function isMatcherShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  return typeof m.contains === "string" || typeof m.regex === "string";
}
function mergeManifests(bundled, overrides) {
  const byId = /* @__PURE__ */ new Map();
  for (const o of overrides) byId.set(o.id, o);
  const result = [];
  const consumed = /* @__PURE__ */ new Set();
  for (const b of bundled) {
    const override = byId.get(b.id);
    if (override) {
      result.push(override);
      consumed.add(b.id);
    } else {
      result.push(b);
    }
  }
  for (const o of overrides) {
    if (!consumed.has(o.id)) {
      result.push(byId.get(o.id));
      consumed.add(o.id);
    }
  }
  return result;
}
function readOverrideManifests(dir = overrideDir()) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const overrides = [];
  for (const file of files.sort()) {
    const path2 = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync2(path2, "utf8"));
      if (validateManifestShape(parsed)) {
        overrides.push(normalizeStates(parsed));
      } else {
        warnOnce(path2, "not a valid AgentManifest (need id, commands[], states)");
      }
    } catch (err) {
      warnOnce(path2, err instanceof Error ? err.message : String(err));
    }
  }
  return overrides;
}
function normalizeStates(m) {
  const states = {};
  if (m.states.blocked) states.blocked = m.states.blocked;
  if (m.states.working) states.working = m.states.working;
  if (m.states.done) states.done = m.states.done;
  const confidence = m.confidence === "tuned" ? "tuned" : "conservative";
  return { id: m.id, commands: m.commands, states, confidence };
}
function warnOnce(path2, reason) {
  if (warned.has(path2)) return;
  warned.add(path2);
  process.stderr.write(`tmux-ide: skipping agent-detection override ${path2}: ${reason}
`);
}
function loadManifests() {
  return mergeManifests(BUNDLED_MANIFESTS, readOverrideManifests());
}
function getManifests() {
  if (!cache) cache = loadManifests();
  return cache;
}
var warned, cache;
var init_manifest_loader = __esm({
  "packages/daemon/src/tui/detect/manifest-loader.ts"() {
    "use strict";
    init_manifests();
    warned = /* @__PURE__ */ new Set();
  }
});

// packages/daemon/src/tui/detect/process-tree.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function parsePsOutput(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command2 = match[3] ?? "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || command2.length === 0) continue;
    entries.push({ pid, ppid, command: command2 });
  }
  return entries;
}
function subtreeCommands(entries, rootPid, maxDepth = 6) {
  const childrenByParent = /* @__PURE__ */ new Map();
  const byPid = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.ppid, siblings);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const commands = [];
  const visited = /* @__PURE__ */ new Set();
  const walk = (pid, depth) => {
    if (depth > maxDepth || visited.has(pid)) return;
    visited.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      walk(child.pid, depth + 1);
    }
    const self = byPid.get(pid);
    if (self) commands.push(self.command);
  };
  walk(rootPid, 0);
  return commands;
}
function describeSubtree(entries, rootPid, limit = 8) {
  const seen = [];
  for (const command2 of subtreeCommands(entries, rootPid)) {
    for (const token of commandTokens(command2)) {
      if (!seen.includes(token)) seen.push(token);
      if (seen.length >= limit) return seen;
    }
  }
  return seen;
}
function readProcessTable() {
  try {
    const raw = execFileSync2("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    return parsePsOutput(raw);
  } catch {
    return [];
  }
}
function commandTokens(command2) {
  const parts = command2.trim().split(/\s+/).filter(Boolean);
  const tokens = [];
  const argv0 = parts[0];
  if (argv0) tokens.push(basename2(argv0));
  const argv1 = parts[1];
  if (argv1 && !argv1.startsWith("-")) tokens.push(basename2(argv1));
  return tokens;
}
function basename2(pathLike) {
  const segments = pathLike.split("/");
  return segments[segments.length - 1] ?? pathLike;
}
function resolveAgentCommand(paneCmd, panePid, table, opts = {}) {
  const manifests = opts.manifests ?? getManifests();
  const hint = opts.hint?.trim();
  if (hint) {
    const hinted = pickManifest(hint, manifests);
    if (hinted) return { manifest: hinted, matchedCommand: hint, source: "hint" };
  }
  const fast = pickManifest(paneCmd, manifests);
  if (fast) return { manifest: fast, matchedCommand: paneCmd, source: "fast" };
  let best;
  for (const command2 of subtreeCommands(table, panePid)) {
    for (const token of commandTokens(command2)) {
      const hit = pickManifest(token, manifests);
      if (!hit) continue;
      const rank = manifests.indexOf(hit);
      if (!best || rank < best.rank) best = { manifest: hit, matchedCommand: token, rank };
      if (best.rank === 0)
        return { manifest: best.manifest, matchedCommand: best.matchedCommand, source: "tree" };
    }
  }
  return best ? { manifest: best.manifest, matchedCommand: best.matchedCommand, source: "tree" } : { manifest: void 0, matchedCommand: "", source: "none" };
}
var init_process_tree = __esm({
  "packages/daemon/src/tui/detect/process-tree.ts"() {
    "use strict";
    init_manifest();
    init_manifest_loader();
  }
});

// packages/daemon/src/tui/detect/snapshot.ts
function stripAnsi(input) {
  return input.replace(ANSI, "");
}
function parseSnapshot(raw, opts = {}) {
  const lines = opts.lines ?? DEFAULT_LINES;
  const text = stripAnsi(raw ?? "");
  const nonEmpty = text.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.length > 0);
  const bottomNonEmpty = lines > 0 ? nonEmpty.slice(-lines) : [];
  return { bottomNonEmpty, text, raw: raw ?? "" };
}
function readPaneSnapshot(target, opts = {}) {
  const lines = opts.lines ?? DEFAULT_LINES;
  try {
    const raw = captureRecent(target, lines);
    return parseSnapshot(raw, { lines });
  } catch {
    return { bottomNonEmpty: [], text: "", raw: "" };
  }
}
var ANSI, DEFAULT_LINES;
var init_snapshot = __esm({
  "packages/daemon/src/tui/detect/snapshot.ts"() {
    "use strict";
    init_src();
    ANSI = /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
    DEFAULT_LINES = 20;
  }
});

// packages/daemon/src/tui/team/sessions.ts
var sessions_exports = {};
__export(sessions_exports, {
  SIDEBAR_PANE_OPTION: () => SIDEBAR_PANE_OPTION,
  buildAgentEntry: () => buildAgentEntry,
  excludeSidebarPanes: () => excludeSidebarPanes,
  isListableSession: () => isListableSession,
  listTeamSessions: () => listTeamSessions,
  rollupStatus: () => rollupStatus,
  rollupWindows: () => rollupWindows
});
import { execFileSync as execFileSync3 } from "node:child_process";
function buildAgentEntry(input) {
  const { manifest, pane } = input;
  if (!manifest || manifest.id === "shell") return null;
  return {
    paneId: pane.id,
    windowIndex: pane.windowIndex,
    session: input.sessionName,
    kind: manifest.id,
    state: input.state,
    confidence: manifest.confidence ?? "conservative",
    since: input.since,
    title: pane.title,
    command: pane.cmd,
    dir: pane.dir
  };
}
function excludeSidebarPanes(panes) {
  return panes.filter((pane) => !pane.sidebar);
}
function isListableSession(name) {
  return !name.startsWith("_");
}
function tmux(args) {
  try {
    return execFileSync3("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function listTeamSessions(tracker, opts = {}) {
  const raw = tmux([
    "list-sessions",
    "-F",
    "#{session_name}	#{session_attached}	#{session_windows}"
  ]);
  if (!raw) return [];
  const panesBySession = collectPanes();
  const processTable = readProcessTable();
  return raw.split("\n").filter(Boolean).filter((line) => isListableSession(line.split("	")[0] ?? "")).map((line) => {
    const [name = "", attached = "", windows = "0"] = line.split("	");
    const panes = excludeSidebarPanes(panesBySession.get(name) ?? []);
    const seen = opts.viewed === name;
    const nowSec = Math.floor(Date.now() / 1e3);
    const agents = [];
    const statuses = panes.map((pane) => {
      const authority = parseAuthority(pane.authority, nowSec);
      let status2;
      let manifest;
      let since = null;
      if (authority !== null) {
        since = parseAuthorityEpoch(pane.authority);
        if (authority === "done" && seen) {
          ackDone(pane.id, nowSec);
          status2 = "idle";
        } else {
          status2 = authority;
        }
        manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
          hint: pane.hint
        }).manifest;
      } else {
        manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
          hint: pane.hint
        }).manifest;
        const instant = manifest ? classifyInstant({ ...readPaneSnapshot(pane.id), title: pane.title }, manifest) : "unknown";
        status2 = tracker.update(pane.id, instant, { seen });
      }
      opts.onPane?.({
        sessionName: name,
        paneId: pane.id,
        agent: manifest && manifest.id !== "shell" ? manifest.id : null,
        status: status2
      });
      const entry = buildAgentEntry({ sessionName: name, pane, manifest, state: status2, since });
      if (entry) agents.push(entry);
      return status2;
    });
    return {
      name,
      attached: attached === "1",
      windows: Number(windows) || 0,
      panes: panes.length,
      status: rollupStatus(statuses),
      // `panes` and `statuses` are parallel (statuses = panes.map(...)), so
      // the pure rollup can group each pane's window with its resolved status.
      windowList: rollupWindows(panes, statuses),
      agents
    };
  });
}
function collectPanes() {
  const raw = tmux([
    "list-panes",
    "-a",
    "-F",
    // Window fields + pane_current_path sit before pane_title so the (tab-safe)
    // title stays the trailing catch-all — window names/paths don't contain tabs
    // in practice. pane_current_path rides this SAME list-panes call (no extra
    // tmux round-trip) so per-pane agent entries can carry a working dir.
    `#{session_name}	#{pane_id}	#{pane_pid}	#{pane_current_command}	#{@agent_state}	#{@agent_hint}	#{${SIDEBAR_PANE_OPTION}}	#{window_index}	#{window_name}	#{window_active}	#{pane_current_path}	#{pane_title}`
  ]);
  const bySession = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [
      session = "",
      id = "",
      pid = "",
      cmd = "",
      authority = "",
      hint = "",
      sidebar = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      dir = "",
      ...titleParts
    ] = line.split("	");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({
      id,
      pid: Number(pid) || 0,
      cmd,
      authority,
      hint,
      sidebar: sidebar === "1",
      windowIndex: Number(windowIndex) || 0,
      windowName,
      windowActive: windowActive === "1",
      dir,
      title: titleParts.join("	")
    });
    bySession.set(session, list);
  }
  return bySession;
}
function ackDone(paneId, nowSec) {
  tmux(["set-option", "-p", "-t", paneId, "@agent_state", `idle:${nowSec}`]);
}
function rollupStatus(statuses) {
  if (statuses.length === 0) return "idle";
  const present = new Set(statuses);
  for (const status2 of SEVERITY) {
    if (present.has(status2)) return status2;
  }
  return "unknown";
}
function rollupWindows(panes, statuses) {
  const byIndex = /* @__PURE__ */ new Map();
  panes.forEach((pane, i) => {
    let entry = byIndex.get(pane.windowIndex);
    if (!entry) {
      entry = { name: pane.windowName, active: false, statuses: [] };
      byIndex.set(pane.windowIndex, entry);
    }
    if (pane.windowActive) entry.active = true;
    const status2 = statuses[i];
    if (status2) entry.statuses.push(status2);
  });
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([index, entry]) => ({
    index,
    name: entry.name,
    active: entry.active,
    panes: entry.statuses.length,
    status: rollupStatus(entry.statuses)
  }));
}
var SIDEBAR_PANE_OPTION, SEVERITY;
var init_sessions2 = __esm({
  "packages/daemon/src/tui/team/sessions.ts"() {
    "use strict";
    init_classify();
    init_process_tree();
    init_snapshot();
    SIDEBAR_PANE_OPTION = "@tmux_ide_sidebar";
    SEVERITY = ["blocked", "working", "done", "idle", "unknown"];
  }
});

// packages/daemon/src/lib/update-check.ts
var update_check_exports = {};
__export(update_check_exports, {
  CHECK_INTERVAL_MS: () => CHECK_INTERVAL_MS,
  REGISTRY_URL: () => REGISTRY_URL,
  compareSemver: () => compareSemver,
  deriveStatus: () => deriveStatus,
  fetchLatestVersion: () => fetchLatestVersion,
  getCurrentVersion: () => getCurrentVersion,
  getUpdateStatus: () => getUpdateStatus,
  isNewer: () => isNewer,
  markUpdateNotified: () => markUpdateNotified,
  maybeCheckForUpdate: () => maybeCheckForUpdate,
  parseRegistryResponse: () => parseRegistryResponse,
  readUpdateCache: () => readUpdateCache,
  runUpdateCheck: () => runUpdateCheck,
  shouldCheck: () => shouldCheck,
  updateCachePath: () => updateCachePath,
  writeUpdateCache: () => writeUpdateCache
});
import { existsSync, mkdirSync, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
function parseSemver(version) {
  const core = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dash = core.indexOf("-");
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? "" : core.slice(dash + 1);
  const parts = main.split(".");
  const num = (i) => {
    const n = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { nums: [num(0), num(1), num(2)], pre };
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
function isNewer(latest, current) {
  return compareSemver(latest, current) === 1;
}
function shouldCheck(lastCheckedAt, nowMs) {
  if (lastCheckedAt === null) return true;
  return nowMs - lastCheckedAt >= CHECK_INTERVAL_MS;
}
function parseRegistryResponse(json2) {
  try {
    const parsed = JSON.parse(json2);
    if (!parsed || typeof parsed !== "object") return null;
    const version = parsed.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
function deriveStatus(latest, currentVersion) {
  return {
    latest,
    updateAvailable: latest !== null && isNewer(latest, currentVersion)
  };
}
function updateCachePath() {
  const home = process.env.TMUX_IDE_HOME ?? join2(homedir2(), ".tmux-ide");
  return join2(home, "update-check.json");
}
function readUpdateCache() {
  const path2 = updateCachePath();
  if (!existsSync(path2)) return null;
  try {
    const parsed = JSON.parse(readFileSync3(path2, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed;
    const lastCheckedAt = typeof obj.lastCheckedAt === "number" ? obj.lastCheckedAt : null;
    const latest = typeof obj.latest === "string" && obj.latest.length > 0 ? obj.latest : null;
    const notified = Array.isArray(obj.notified) ? obj.notified.filter((v) => typeof v === "string") : void 0;
    return { lastCheckedAt, latest, ...notified ? { notified } : {} };
  } catch {
    return null;
  }
}
function writeUpdateCache(cache3) {
  const path2 = updateCachePath();
  try {
    mkdirSync(dirname(path2), { recursive: true });
    writeFileSync2(path2, JSON.stringify(cache3));
  } catch {
  }
}
async function fetchLatestVersion(timeoutMs = 3e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return parseRegistryResponse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function getCurrentVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join2(here, "../package.json"),
    // bundled bin/cli.js → repo root
    join2(here, "../../../../package.json")
    // dev src/lib → repo root
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync3(candidate, "utf-8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
    }
  }
  return "0.0.0";
}
function getUpdateStatus({
  currentVersion = getCurrentVersion()
} = {}) {
  const cache3 = readUpdateCache();
  return deriveStatus(cache3?.latest ?? null, currentVersion);
}
async function runUpdateCheck({ now = Date.now() } = {}) {
  const cache3 = readUpdateCache();
  if (!shouldCheck(cache3?.lastCheckedAt ?? null, now)) return;
  const fetched = await fetchLatestVersion();
  writeUpdateCache({
    lastCheckedAt: now,
    latest: fetched ?? cache3?.latest ?? null,
    ...cache3?.notified ? { notified: cache3.notified } : {}
  });
}
function maybeCheckForUpdate({
  enabled,
  now = Date.now(),
  currentVersion = getCurrentVersion()
}) {
  if (!enabled) return { latest: null, updateAvailable: false };
  const status2 = getUpdateStatus({ now, currentVersion });
  void runUpdateCheck({ now }).catch(() => {
  });
  return status2;
}
function markUpdateNotified(version) {
  const cache3 = readUpdateCache() ?? { lastCheckedAt: null, latest: null };
  const notified = cache3.notified ?? [];
  if (notified.includes(version)) return false;
  writeUpdateCache({ ...cache3, notified: [...notified, version] });
  return true;
}
var REGISTRY_URL, CHECK_INTERVAL_MS;
var init_update_check = __esm({
  "packages/daemon/src/lib/update-check.ts"() {
    "use strict";
    REGISTRY_URL = "https://registry.npmjs.org/tmux-ide/latest";
    CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
  }
});

// packages/daemon/src/lib/tui-binary.ts
var tui_binary_exports = {};
__export(tui_binary_exports, {
  MIN_TUI_BINARY_BYTES: () => MIN_TUI_BINARY_BYTES,
  RELEASE_REPO: () => RELEASE_REPO,
  bunTargetForTag: () => bunTargetForTag,
  downloadTuiBinary: () => downloadTuiBinary,
  downloadedTuiPath: () => downloadedTuiPath,
  findDownloadedTui: () => findDownloadedTui,
  normalizeVersion: () => normalizeVersion,
  releaseAssetName: () => releaseAssetName,
  releaseAssetUrl: () => releaseAssetUrl,
  tuiPlatformTag: () => tuiPlatformTag,
  tuiStateHome: () => tuiStateHome
});
import { chmodSync, existsSync as existsSync2, mkdirSync as mkdirSync2, renameSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
import { gunzipSync } from "node:zlib";
function tuiPlatformTag(platform = process.platform, arch = process.arch) {
  return SUPPORTED[`${platform}-${arch}`] ?? null;
}
function bunTargetForTag(tag) {
  return `bun-${tag}`;
}
function releaseAssetName(tag) {
  return `tmux-ide-tui-${tag}.gz`;
}
function normalizeVersion(version) {
  return version.startsWith("v") ? version.slice(1) : version;
}
function releaseAssetUrl(version, tag) {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${normalizeVersion(version)}/${releaseAssetName(tag)}`;
}
function downloadedTuiPath(home, tag, version) {
  return join3(home, "bin", `tmux-ide-tui-${tag}-${normalizeVersion(version)}`);
}
function tuiStateHome() {
  return process.env.TMUX_IDE_HOME ?? join3(homedir3(), ".tmux-ide");
}
function findDownloadedTui(version = getCurrentVersion()) {
  const tag = tuiPlatformTag();
  if (!tag) return null;
  const path2 = downloadedTuiPath(tuiStateHome(), tag, version);
  return existsSync2(path2) ? path2 : null;
}
async function downloadTuiBinary(opts = {}) {
  const log = opts.log ?? (() => {
  });
  const version = normalizeVersion(opts.version ?? getCurrentVersion());
  const tag = tuiPlatformTag();
  if (!tag) {
    throw new Error(
      `no prebuilt TUI binary is published for ${process.platform}-${process.arch} \u2014 install bun (https://bun.sh) to run the TUI surfaces from source instead`
    );
  }
  const url = releaseAssetUrl(version, tag);
  const dest = downloadedTuiPath(tuiStateHome(), tag, version);
  mkdirSync2(dirname2(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not download the TUI binary (${url} \u2192 HTTP ${res.status} ${res.statusText}). Check that release v${version} exists and published its assets.`
    );
  }
  const gz = Buffer.from(await res.arrayBuffer());
  const bin = gunzipSync(gz);
  if (bin.byteLength < MIN_TUI_BINARY_BYTES) {
    throw new Error(
      `the downloaded TUI binary is only ${bin.byteLength} bytes (expected >10MB) \u2014 treating it as corrupt and leaving the previous binary (if any) in place`
    );
  }
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync3(tmp, bin, { mode: 493 });
  chmodSync(tmp, 493);
  renameSync(tmp, dest);
  const mb = (bin.byteLength / 1024 / 1024).toFixed(1);
  log(`installed ${dest} (${mb} MB)`);
  return { path: dest, bytes: bin.byteLength };
}
var RELEASE_REPO, MIN_TUI_BINARY_BYTES, SUPPORTED;
var init_tui_binary = __esm({
  "packages/daemon/src/lib/tui-binary.ts"() {
    "use strict";
    init_update_check();
    RELEASE_REPO = "wavyrai/tmux-ide";
    MIN_TUI_BINARY_BYTES = 10 * 1024 * 1024;
    SUPPORTED = {
      "darwin-arm64": "darwin-arm64",
      "darwin-x64": "darwin-x64",
      "linux-x64": "linux-x64",
      "linux-arm64": "linux-arm64"
    };
  }
});

// packages/daemon/src/tui/compiled.ts
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname3, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { execFileSync as execFileSync4 } from "node:child_process";
function resolveTuiLaunch(input) {
  if (input.checkoutExists && input.bunAvailable) {
    return { mode: "bun", bin: "bun", argv: [input.scriptPath, ...input.args] };
  }
  if (input.compiledBinary) {
    return { mode: "binary", bin: input.compiledBinary, argv: [input.surface, ...input.args] };
  }
  const reasons = [];
  if (!input.checkoutExists) {
    reasons.push(
      "the TUI widget sources are absent (reinstall tmux-ide \u2014 releases since v2.6.1 ship them)"
    );
  }
  if (!input.bunAvailable) {
    reasons.push("the `bun` runtime is not installed (https://bun.sh)");
  }
  reasons.push(
    "no compiled `tmux-ide-tui` binary was found (build one with `pnpm build:tui`, download it with `tmux-ide update --tui-binary`, or reinstall a release that ships it)"
  );
  return { mode: "unavailable", reasons };
}
function findCompiledTui() {
  const override = process.env.TMUX_IDE_TUI_BIN;
  if (override) return existsSync3(override) ? override : null;
  const anchors = [];
  if (process.argv[1]) anchors.push(dirname3(process.argv[1]));
  anchors.push(__dirname);
  for (const anchor of anchors) {
    for (const rel of BINARY_RELS) {
      const candidate = resolve4(anchor, rel);
      if (existsSync3(candidate)) return candidate;
    }
  }
  return findDownloadedTui();
}
function isBunAvailable() {
  try {
    execFileSync4("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
var __dirname, BINARY_RELS;
var init_compiled = __esm({
  "packages/daemon/src/tui/compiled.ts"() {
    "use strict";
    init_tui_binary();
    __dirname = dirname3(fileURLToPath2(import.meta.url));
    BINARY_RELS = [
      "../packages/daemon/dist/tui/tmux-ide-tui",
      "../../dist/tui/tmux-ide-tui",
      "../dist/tui/tmux-ide-tui",
      "dist/tui/tmux-ide-tui",
      "tmux-ide-tui"
    ];
  }
});

// packages/daemon/src/tui/chrome/sidebar.ts
var sidebar_exports = {};
__export(sidebar_exports, {
  DEFAULT_SIDEBAR_WIDTH: () => DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_KEY: () => SIDEBAR_KEY,
  SIDEBAR_PANE_OPTION: () => SIDEBAR_PANE_OPTION,
  closeSidebarPane: () => closeSidebarPane,
  findSidebarPane: () => findSidebarPane,
  openSidebarPane: () => openSidebarPane,
  parseSidebarWidth: () => parseSidebarWidth,
  resolveSidebarConfig: () => resolveSidebarConfig,
  sidebarSplitCommand: () => sidebarSplitCommand,
  sidebarToggleBindCommand: () => sidebarToggleBindCommand,
  sidebarToggleUnbindCommand: () => sidebarToggleUnbindCommand,
  sidebarWidgetCommand: () => sidebarWidgetCommand,
  sidebarWidgetScript: () => sidebarWidgetScript
});
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname4, resolve as resolve5 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
function sidebarWidgetScript() {
  const candidates = [
    resolve5(__dirname2, "../../widgets/sidebar/index.tsx"),
    resolve5(__dirname2, "../packages/daemon/src/widgets/sidebar/index.tsx")
  ];
  return candidates.find((p) => existsSync4(p)) ?? candidates[0];
}
function sidebarWidgetCommand(scriptPath, session, dir, theme) {
  const args = [`--session=${session}`, `--dir=${dir}`];
  if (theme) args.push(`--theme=${JSON.stringify(theme)}`);
  const launch2 = resolveTuiLaunch({
    surface: "sidebar",
    scriptPath,
    args,
    checkoutExists: existsSync4(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    return `cd ${shellEscape(dir)} && bun ${shellEscape(scriptPath)} ${args.map(shellEscape).join(" ")}`;
  }
  const escaped = launch2.argv.map(shellEscape).join(" ");
  return `cd ${shellEscape(dir)} && ${shellEscape(launch2.bin)} ${escaped}`;
}
function resolveSidebarConfig(raw) {
  if (raw === true) return { enabled: true, width: DEFAULT_SIDEBAR_WIDTH };
  if (!raw || typeof raw !== "object") return { enabled: false, width: DEFAULT_SIDEBAR_WIDTH };
  const width = parseSidebarWidth(raw.width);
  return { enabled: true, width };
}
function parseSidebarWidth(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(10, Math.floor(n));
}
function sidebarToggleBindCommand(cli = "tmux-ide sidebar-toggle", key = SIDEBAR_KEY) {
  return ["bind-key", "-n", key, "run-shell", `${cli} --session '#{session_name}'`];
}
function sidebarToggleUnbindCommand(key = SIDEBAR_KEY) {
  return ["unbind-key", "-n", key];
}
function sidebarSplitCommand(session, dir, width, widgetCmd) {
  return [
    "split-window",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    session,
    "-h",
    "-b",
    "-f",
    "-l",
    String(width),
    "-c",
    dir,
    widgetCmd
  ];
}
function findSidebarPane(session) {
  try {
    const raw = runTmux(
      ["list-panes", "-t", session, "-F", `#{pane_id}	#{${SIDEBAR_PANE_OPTION}}`],
      { encoding: "utf-8" }
    ).toString().trim();
    for (const line of raw.split("\n").filter(Boolean)) {
      const [id = "", flag = ""] = line.split("	");
      if (flag === "1" && id) return id;
    }
  } catch {
  }
  return null;
}
function openSidebarPane(session, dir, width, theme) {
  const widgetCmd = sidebarWidgetCommand(sidebarWidgetScript(), session, dir, theme);
  const paneId = runTmux(sidebarSplitCommand(session, dir, width, widgetCmd), {
    encoding: "utf-8"
  }).toString().trim();
  runTmux(["set-option", "-pqt", paneId, SIDEBAR_PANE_OPTION, "1"]);
  runTmux(["select-pane", "-t", paneId, "-T", "sidebar"]);
  return paneId;
}
function closeSidebarPane(paneId) {
  runTmux(["kill-pane", "-t", paneId]);
}
var __dirname2, SIDEBAR_KEY, DEFAULT_SIDEBAR_WIDTH;
var init_sidebar = __esm({
  "packages/daemon/src/tui/chrome/sidebar.ts"() {
    "use strict";
    init_src();
    init_shell();
    init_sessions2();
    init_compiled();
    __dirname2 = dirname4(fileURLToPath3(import.meta.url));
    SIDEBAR_KEY = "M-b";
    DEFAULT_SIDEBAR_WIDTH = 30;
  }
});

// packages/daemon/src/widgets/resolve.ts
var resolve_exports = {};
__export(resolve_exports, {
  WIDGET_TYPES: () => WIDGET_TYPES,
  resolveWidgetCommand: () => resolveWidgetCommand,
  resolveWidgetSpawn: () => resolveWidgetSpawn
});
import { resolve as resolve6, dirname as dirname5 } from "node:path";
import { existsSync as existsSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath4 } from "node:url";
function widgetEntryPath(entry) {
  const sibling = resolve6(__dirname3, entry);
  if (existsSync5(sibling)) return sibling;
  return resolve6(__dirname3, "../packages/daemon/src/widgets", entry);
}
function widgetArgs(opts) {
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme=${JSON.stringify(opts.theme)}`);
  return args;
}
function resolveWidgetCommand(type, opts) {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);
  const scriptPath = widgetEntryPath(entry);
  const launch2 = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync5(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch2.reasons.join("; ")}`);
  }
  const escapedArgs = launch2.argv.map(shellEscape).join(" ");
  if (launch2.mode === "bun") {
    return `cd ${shellEscape(REPO_ROOT)} && bun ${escapedArgs}`;
  }
  return `cd ${shellEscape(opts.dir)} && ${shellEscape(launch2.bin)} ${escapedArgs}`;
}
function resolveWidgetSpawn(type, opts) {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);
  const scriptPath = widgetEntryPath(entry);
  const launch2 = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync5(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch2.reasons.join("; ")}`);
  }
  const cwd = launch2.mode === "bun" ? REPO_ROOT : opts.dir;
  return { cwd, cmd: [launch2.bin, ...launch2.argv] };
}
var __dirname3, WIDGET_ENTRY_POINTS, REPO_ROOT, WIDGET_TYPES;
var init_resolve = __esm({
  "packages/daemon/src/widgets/resolve.ts"() {
    "use strict";
    init_shell();
    init_compiled();
    __dirname3 = dirname5(fileURLToPath4(import.meta.url));
    WIDGET_ENTRY_POINTS = {
      explorer: "explorer/index.tsx",
      changes: "changes/index.tsx",
      preview: "preview/index.tsx",
      setup: "setup/index.tsx",
      config: "config/index.tsx",
      sidebar: "sidebar/index.tsx"
    };
    REPO_ROOT = existsSync5(resolve6(__dirname3, "explorer/index.tsx")) ? resolve6(__dirname3, "../../../..") : resolve6(__dirname3, "..");
    WIDGET_TYPES = Object.keys(WIDGET_ENTRY_POINTS);
  }
});

// packages/daemon/src/lib/app-config.ts
var app_config_exports = {};
__export(app_config_exports, {
  DEFAULT_APP_CONFIG: () => DEFAULT_APP_CONFIG,
  DEFAULT_KEYS: () => DEFAULT_KEYS,
  DEFAULT_THEME: () => DEFAULT_THEME,
  _resetForTests: () => _resetForTests,
  appConfigPath: () => appConfigPath,
  getAppConfig: () => getAppConfig,
  loadAppConfig: () => loadAppConfig,
  loadRawAppConfig: () => loadRawAppConfig,
  mergeConfigPatch: () => mergeConfigPatch,
  parseAppConfig: () => parseAppConfig,
  updateAppConfig: () => updateAppConfig
});
import { existsSync as existsSync6, mkdirSync as mkdirSync3, readFileSync as readFileSync4, renameSync as renameSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname6, join as join4 } from "node:path";
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function pickString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function pickPosInt(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function pickChoice(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
function parseAppConfig(input) {
  const D = DEFAULT_APP_CONFIG;
  const root = asObject(input);
  const keys = asObject(root.keys);
  const panels = asObject(keys.panels);
  const theme = asObject(root.theme);
  const status2 = asObject(theme.status);
  const glyphs = asObject(theme.glyphs);
  const updater = asObject(root.updater);
  const notifications = asObject(root.notifications);
  const restore2 = asObject(root.restore);
  const updates = asObject(root.updates);
  const welcome = asObject(root.welcome);
  const integrations = asObject(root.integrations);
  const worktrees = asObject(root.worktrees);
  const app = asObject(root.app);
  return {
    keys: {
      popup: pickString(keys.popup, D.keys.popup),
      home: pickString(keys.home, D.keys.home),
      cheatsheet: pickString(keys.cheatsheet, D.keys.cheatsheet),
      menu: pickString(keys.menu, D.keys.menu),
      sidebar: pickString(keys.sidebar, D.keys.sidebar),
      panels: {
        explorer: pickString(panels.explorer, D.keys.panels.explorer),
        changes: pickString(panels.changes, D.keys.panels.changes),
        config: pickString(panels.config, D.keys.panels.config)
      }
    },
    theme: {
      accent: pickString(theme.accent, D.theme.accent),
      muted: pickString(theme.muted, D.theme.muted),
      fg: pickString(theme.fg, D.theme.fg),
      status: {
        blocked: pickString(status2.blocked, D.theme.status.blocked),
        working: pickString(status2.working, D.theme.status.working),
        done: pickString(status2.done, D.theme.status.done),
        idle: pickString(status2.idle, D.theme.status.idle),
        unknown: pickString(status2.unknown, D.theme.status.unknown)
      },
      glyphs: {
        active: pickString(glyphs.active, D.theme.glyphs.active),
        inactive: pickString(glyphs.inactive, D.theme.glyphs.inactive)
      }
    },
    updater: {
      tickMs: pickPosInt(updater.tickMs, D.updater.tickMs),
      snapshotEvery: pickPosInt(updater.snapshotEvery, D.updater.snapshotEvery)
    },
    notifications: {
      toast: pickBool(notifications.toast, D.notifications.toast),
      macos: pickBool(notifications.macos, D.notifications.macos)
    },
    restore: { resumeAgents: pickBool(restore2.resumeAgents, D.restore.resumeAgents) },
    updates: { check: pickBool(updates.check, D.updates.check) },
    welcome: { show: pickBool(welcome.show, D.welcome.show) },
    integrations: { offer: pickBool(integrations.offer, D.integrations.offer) },
    worktrees: { dir: pickString(worktrees.dir, D.worktrees.dir) },
    app: {
      frontDoor: pickBool(app.frontDoor, D.app.frontDoor),
      detachable: pickBool(app.detachable, D.app.detachable),
      dragSelect: pickChoice(app.dragSelect, ["agents", "always", "never"], D.app.dragSelect),
      newAgentCwd: pickChoice(app.newAgentCwd, ["pane", "session"], D.app.newAgentCwd),
      kittyKeys: pickBool(app.kittyKeys, D.app.kittyKeys)
    }
  };
}
function appConfigPath() {
  return process.env.TMUX_IDE_CONFIG ?? join4(homedir4(), ".tmux-ide", "config.json");
}
function loadAppConfig() {
  const path2 = appConfigPath();
  if (!existsSync6(path2)) return parseAppConfig(void 0);
  try {
    return parseAppConfig(JSON.parse(readFileSync4(path2, "utf-8")));
  } catch {
    return parseAppConfig(void 0);
  }
}
function getAppConfig() {
  if (!cached) cached = loadAppConfig();
  return cached;
}
function _resetForTests() {
  cached = null;
}
function loadRawAppConfig() {
  const path2 = appConfigPath();
  if (!existsSync6(path2)) return {};
  try {
    const parsed = JSON.parse(readFileSync4(path2, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function mergeConfigPatch(raw, patch) {
  const out = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === void 0) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeConfigPatch(out[key], value);
    } else if (isPlainObject(value)) {
      out[key] = mergeConfigPatch({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function updateAppConfig(patch) {
  const path2 = appConfigPath();
  const merged = mergeConfigPatch(loadRawAppConfig(), patch);
  mkdirSync3(dirname6(path2), { recursive: true });
  const tmp = `${path2}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync4(tmp, `${JSON.stringify(merged, null, 2)}
`, "utf-8");
  renameSync2(tmp, path2);
  cached = null;
  return parseAppConfig(merged);
}
var DEFAULT_APP_CONFIG, DEFAULT_THEME, DEFAULT_KEYS, cached;
var init_app_config = __esm({
  "packages/daemon/src/lib/app-config.ts"() {
    "use strict";
    DEFAULT_APP_CONFIG = {
      keys: {
        popup: "M-p",
        home: "M-h",
        cheatsheet: "M-k",
        menu: "M-m",
        sidebar: "M-b",
        panels: { explorer: "M-e", changes: "M-g", config: "M-," }
      },
      theme: {
        accent: "colour75",
        muted: "colour240",
        fg: "colour250",
        status: {
          blocked: "colour203",
          working: "colour221",
          done: "colour111",
          idle: "colour114",
          unknown: "colour244"
        },
        glyphs: { active: "\u25CF", inactive: "\u25CB" }
      },
      updater: { tickMs: 2e3, snapshotEvery: 15 },
      notifications: { toast: true, macos: false },
      restore: { resumeAgents: false },
      updates: { check: true },
      welcome: { show: true },
      integrations: { offer: true },
      worktrees: { dir: "" },
      app: {
        frontDoor: false,
        detachable: false,
        dragSelect: "agents",
        newAgentCwd: "pane",
        kittyKeys: true
      }
    };
    DEFAULT_THEME = DEFAULT_APP_CONFIG.theme;
    DEFAULT_KEYS = DEFAULT_APP_CONFIG.keys;
    cached = null;
  }
});

// packages/daemon/src/tui/team/keymap.ts
import { existsSync as existsSync7, readFileSync as readFileSync5 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join5 } from "node:path";
var ACTION_ORDER, DEFAULT_KEYMAP;
var init_keymap = __esm({
  "packages/daemon/src/tui/team/keymap.ts"() {
    "use strict";
    ACTION_ORDER = [
      "up",
      "down",
      "enter",
      "launch",
      "new",
      "rename",
      "split",
      "register",
      "unregister",
      "kill",
      "filter",
      "refresh",
      "help",
      "quit"
    ];
    DEFAULT_KEYMAP = {
      up: { keys: ["up", "k"], description: "move up" },
      down: { keys: ["down", "j"], description: "move down" },
      enter: { keys: ["return"], description: "launch / attach" },
      launch: { keys: ["l"], description: "launch project" },
      new: { keys: ["n"], description: "new session" },
      rename: { keys: ["R"], description: "rename session" },
      split: { keys: ["s"], description: "split pane" },
      register: { keys: ["a"], description: "add project" },
      unregister: { keys: ["d"], description: "unregister project" },
      kill: { keys: ["x"], description: "kill (confirm)" },
      filter: { keys: ["/"], description: "fuzzy filter" },
      refresh: { keys: ["r"], description: "refresh" },
      help: { keys: ["?"], description: "toggle help" },
      quit: { keys: ["q"], description: "quit" }
    };
  }
});

// packages/daemon/src/widgets/lib/grammar.ts
var GRAMMAR_HELP;
var init_grammar = __esm({
  "packages/daemon/src/widgets/lib/grammar.ts"() {
    "use strict";
    GRAMMAR_HELP = [
      { keys: "j / \u2193", label: "move down" },
      { keys: "k / \u2191", label: "move up" },
      { keys: "enter", label: "activate / open" },
      { keys: "/", label: "filter list" },
      { keys: "esc", label: "close filter \u2192 detail \u2192 widget" },
      { keys: "q", label: "quit" },
      { keys: "?", label: "toggle this help" }
    ];
  }
});

// packages/daemon/src/tui/chrome/panels.ts
var panels_exports = {};
__export(panels_exports, {
  PANEL_POPUPS: () => PANEL_POPUPS,
  POPUP_WIDGETS: () => POPUP_WIDGETS,
  panelKey: () => panelKey,
  panelPopupBindCommand: () => panelPopupBindCommand,
  panelPopupCli: () => panelPopupCli,
  panelPopupCommand: () => panelPopupCommand,
  panelPopupUnbindCommand: () => panelPopupUnbindCommand
});
function panelPopupCli(widget) {
  return `tmux-ide popup ${widget}`;
}
function panelKey(panel, keys) {
  return keys[panel.widget];
}
function panelPopupCommand(panel, cli = panelPopupCli(panel.widget)) {
  return `display-popup -E -d '#{pane_current_path}' -w ${panel.width} -h ${panel.height} "${cli}"`;
}
function panelPopupBindCommand(panel, key, cli = panelPopupCli(panel.widget)) {
  return [
    "bind-key",
    "-n",
    key,
    "display-popup",
    "-E",
    "-d",
    "#{pane_current_path}",
    "-w",
    panel.width,
    "-h",
    panel.height,
    cli
  ];
}
function panelPopupUnbindCommand(key) {
  return ["unbind-key", "-n", key];
}
var PANEL_POPUPS, POPUP_WIDGETS;
var init_panels = __esm({
  "packages/daemon/src/tui/chrome/panels.ts"() {
    "use strict";
    PANEL_POPUPS = [
      { widget: "explorer", label: "\u229E Files", width: "60%", height: "85%" },
      { widget: "changes", label: "\xB1 Changes", width: "85%", height: "90%" },
      { widget: "config", label: "\u2699 Config", width: "80%", height: "85%" }
    ];
    POPUP_WIDGETS = PANEL_POPUPS.map((p) => p.widget);
  }
});

// packages/daemon/src/tui/chrome/cheatsheet.ts
var cheatsheet_exports = {};
__export(cheatsheet_exports, {
  CHEATSHEET_KEY: () => CHEATSHEET_KEY,
  buildCheatsheet: () => buildCheatsheet,
  cheatsheetBindCommand: () => cheatsheetBindCommand,
  cheatsheetPopupCommand: () => cheatsheetPopupCommand,
  cheatsheetUnbindCommand: () => cheatsheetUnbindCommand
});
function tokenCode(token) {
  const m = /^colou?r(\d+)$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}
function legendMark(token, glyph) {
  const code = tokenCode(token);
  return code === null ? dim(glyph) : color(code, glyph);
}
function renderKey(tmuxKey) {
  return tmuxKey.replace(/M-/g, "\u2325").replace(/C-/g, "^").replace(/S-/g, "\u21E7");
}
function clip(line, width) {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1B") {
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    out += line[i];
    visible++;
    i++;
  }
  return `${out}\x1B[0m`;
}
function visibleWidth(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function buildCheatsheet(opts) {
  const width = Math.max(20, opts.width);
  const keys = opts.keys ?? DEFAULT_KEYS;
  const theme = opts.theme ?? DEFAULT_THEME;
  const lines = [];
  const pad = (s) => `  ${s}`;
  lines.push(`${head(" tmux-ide")}  ${dim("cheat sheet \u2014 press any key to close")}`);
  lines.push("");
  lines.push(head("dock"));
  lines.push(
    pad(
      `${bold(renderKey(keys.home))} home cockpit   ${bold(renderKey(keys.popup))} switcher popup   ${bold(renderKey(keys.cheatsheet))} this sheet   ${bold(renderKey(keys.menu))} actions menu   ${bold(renderKey(keys.sidebar))} sidebar`
    )
  );
  lines.push(
    pad(
      dim(
        `bar: click a project tab = switch there \xB7 [ \u2302 home ${renderKey(keys.home)} ] = home \xB7 [ \u29C9 switch ${renderKey(keys.popup)} ] = switcher \xB7 right-click anywhere = menu`
      )
    )
  );
  const active2 = theme.glyphs.active;
  const legend = `${legendMark(theme.status.blocked, active2)} blocked  ${legendMark(theme.status.working, active2)} working  ${legendMark(theme.status.done, active2)} done  ${legendMark(theme.status.idle, active2)} idle  ${dim("\xB7")} unknown  ${dim(theme.glyphs.inactive)} stopped`;
  lines.push(pad(legend));
  lines.push("");
  lines.push(head("prefix keys (always work)"));
  lines.push(
    pad(
      `${bold("prefix h")} home  ${bold("prefix j")} switcher  ${bold("prefix k")} keys  ${bold("prefix u")} menu  ${bold("prefix b")} sidebar  ${bold("prefix e")} files  ${bold("prefix g")} changes  ${bold("prefix v")} config`
    )
  );
  lines.push(
    pad(dim(`prefix = your tmux prefix (usually C-b) \u2014 use these when Alt keys don't reach tmux`))
  );
  lines.push("");
  lines.push(head("panels"));
  const panelHints = PANEL_POPUPS.map(
    (p) => `${bold(renderKey(panelKey(p, keys.panels)))} ${p.label}`
  ).join("   ");
  lines.push(pad(`${panelHints}   ${dim("esc/q closes any panel")}`));
  lines.push("");
  lines.push(head("in panels & sidebar"));
  const gKeyW = Math.max(...GRAMMAR_HELP.map((r) => r.keys.length));
  for (const row of GRAMMAR_HELP) {
    lines.push(pad(`${bold(row.keys.padEnd(gKeyW))}  ${dim(row.label)}`));
  }
  lines.push("");
  lines.push(head(`picker  ${dim(`(inside the ${renderKey(keys.popup)} popup)`)}`));
  lines.push(
    pad(`${bold("\u21B5")} switch   ${bold("l")} launch   ${bold("/")} find   ${bold("esc")} close`)
  );
  lines.push("");
  lines.push(head("team app"));
  const cells = ACTION_ORDER.map((action) => {
    const binding = DEFAULT_KEYMAP[action];
    return { keys: binding.keys.join("/"), desc: binding.description };
  });
  const keyW = Math.max(...cells.map((c) => c.keys.length));
  const descW = Math.max(...cells.map((c) => c.desc.length));
  const cellW = keyW + 2 + descW;
  const renderCell = (c) => {
    const text = `${bold(c.keys.padEnd(keyW))}  ${dim(c.desc)}`;
    return text + " ".repeat(Math.max(0, cellW - visibleWidth(text)));
  };
  const twoCols = width >= cellW * 2 + 4;
  if (twoCols) {
    const half = Math.ceil(cells.length / 2);
    for (let i = 0; i < half; i++) {
      const left = cells[i];
      const right = cells[i + half];
      const rendered = left ? renderCell(left) : "";
      lines.push(pad(right ? `${rendered}  ${renderCell(right)}` : rendered));
    }
  } else {
    for (const c of cells) lines.push(pad(renderCell(c)));
  }
  lines.push("");
  lines.push(head("tmux essentials"));
  lines.push(
    pad(
      `${bold("prefix d")} detach   ${bold("prefix z")} zoom pane   ${bold("prefix [")} copy mode`
    )
  );
  lines.push(
    pad(
      `${bold("prefix c")} new window   ${bold("prefix n/p")} next/prev   ${bold('prefix % / "')} splits`
    )
  );
  lines.push("");
  lines.push(head("cli"));
  lines.push(pad(cyan("tmux-ide team --json")));
  lines.push(pad(cyan("tmux-ide wait agent-status <s> --status done")));
  lines.push(pad(cyan("tmux-ide adopt/unadopt <session>")));
  lines.push(pad(cyan("tmux-ide worktree create <branch>") + dim("   (\u2387 in the menu)")));
  return lines.map((line) => clip(line, width)).join("\n");
}
function cheatsheetPopupCommand(cheatsheetCmd = "tmux-ide cheatsheet") {
  return `display-popup -E -w 90% -h 80% "${cheatsheetCmd}"`;
}
function cheatsheetBindCommand(cheatsheetCmd = "tmux-ide cheatsheet", key = CHEATSHEET_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "90%", "-h", "80%", cheatsheetCmd];
}
function cheatsheetUnbindCommand(key = CHEATSHEET_KEY) {
  return ["unbind-key", "-n", key];
}
var CHEATSHEET_KEY, bold, dim, cyan, head, color;
var init_cheatsheet = __esm({
  "packages/daemon/src/tui/chrome/cheatsheet.ts"() {
    "use strict";
    init_app_config();
    init_keymap();
    init_grammar();
    init_panels();
    CHEATSHEET_KEY = "M-k";
    bold = (s) => `\x1B[1m${s}\x1B[22m`;
    dim = (s) => `\x1B[2m${s}\x1B[22m`;
    cyan = (s) => `\x1B[36m${s}\x1B[39m`;
    head = (s) => `\x1B[1;36m${s}\x1B[0m`;
    color = (code, s) => `\x1B[38;5;${code}m${s}\x1B[39m`;
  }
});

// packages/daemon/src/tui/chrome/menu.ts
var menu_exports = {};
__export(menu_exports, {
  MENU_KEY: () => MENU_KEY,
  MENU_PANE_KEY: () => MENU_PANE_KEY,
  MENU_STATUS_KEY: () => MENU_STATUS_KEY,
  buildMenu: () => buildMenu,
  menuBindCommand: () => menuBindCommand,
  menuPaneBindCommand: () => menuPaneBindCommand,
  menuPaneUnbindCommand: () => menuPaneUnbindCommand,
  menuPositionArgs: () => menuPositionArgs,
  menuQuoteName: () => menuQuoteName,
  menuStatusBindCommand: () => menuStatusBindCommand,
  menuStatusUnbindCommand: () => menuStatusUnbindCommand,
  menuUnbindCommand: () => menuUnbindCommand
});
function menuGlyph(status2, theme) {
  const glyph = status2 === "idle" ? theme.glyphs.inactive : status2 === "unknown" ? "\xB7" : theme.glyphs.active;
  return { glyph, colour: theme.status[status2] };
}
function menuQuoteName(name) {
  return `'${name.replace(/'/g, `'\\''`)}'`;
}
function sessionLabel(session, theme) {
  const g = menuGlyph(session.status, theme);
  return `#[fg=${g.colour}]${g.glyph}#[default] ${session.name}`;
}
function buildMenu(sessions, theme = DEFAULT_THEME, update) {
  const updateItems = update?.updateAvailable && update.latest ? [`#[fg=${theme.accent}]\u2B06 Update available (v${update.latest})`, "u", updatePopupCommand()] : [];
  const header = [
    "\u2302 Home cockpit",
    "h",
    homePopupCommand(),
    "\u29C9 Switch session\u2026",
    "s",
    switcherPopupCommand(),
    "? Cheat sheet",
    "k",
    cheatsheetPopupCommand(),
    "\u258F Toggle sidebar",
    "b",
    // run-shell format-expands #{session_name}, so the toggle targets whatever
    // session the opening client is viewing (bind args don't expand; run-shell
    // does — the same trick the menu bind itself uses).
    `run-shell "tmux-ide sidebar-toggle --session '#{session_name}'"`
  ];
  const panelItems = [];
  PANEL_POPUPS.forEach((panel, i) => {
    panelItems.push(panel.label, PANEL_MENU_KEYS[i] ?? "", panelPopupCommand(panel));
  });
  const sessionItems = [];
  sessions.slice(0, MAX_SESSION_ITEMS).forEach((session, i) => {
    sessionItems.push(
      sessionLabel(session, theme),
      String(i + 1),
      `switch-client -t ${menuQuoteName(session.name)}`
    );
  });
  const footer = [
    "\uFF0B New session\u2026",
    "n",
    `command-prompt -p "new session name:" "new-session -d -s '%%' ; switch-client -t '%%'"`,
    "\u2387 New worktree\u2026",
    "w",
    // Prompt for a branch, then create a git worktree + session for it. The
    // command-prompt template is SINGLE-quoted so the inner run-shell arg can be
    // DOUBLE-quoted — run-shell only format-expands #{session_name} inside double
    // quotes (single quotes suppress it). `%%` is command-prompt's branch
    // substitution; --session carries the current session so the CLI resolves the
    // repo from its cwd (run-shell's own cwd is the tmux server's, not the pane's).
    // Quoting verified live on tmux 3.6 with branch `feat/x-1`.
    `command-prompt -p "worktree branch:" 'run-shell "tmux-ide worktree create %% --session #{session_name}"'`,
    "\u2715 Kill this session",
    "x",
    `confirm-before -p "kill session #S? (y/n)" kill-session`
  ];
  const items = [];
  for (const group of [updateItems, header, panelItems, sessionItems, footer]) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push("");
    items.push(...group);
  }
  return ["-T", "tmux-ide", ...items];
}
function menuRunShellArgs(menuCmd) {
  return ["run-shell", "-b", `${menuCmd} --client '#{client_name}'`];
}
function menuPaneMouseRunShellArgs(menuCmd) {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{e|+:#{pane_left},#{mouse_x}}' --y '#{e|+:#{pane_top},#{mouse_y}}'`
  ];
}
function menuStatusMouseRunShellArgs(menuCmd) {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{mouse_x}' --y '#{client_height}'`
  ];
}
function menuPositionArgs(x, y) {
  const nx = parseCoord(x);
  const ny = parseCoord(y);
  if (nx === null || ny === null) return [];
  return ["-x", String(nx), "-y", String(Math.max(0, ny - 1))];
}
function parseCoord(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}
function menuBindCommand(menuCmd = "tmux-ide menu", key = MENU_KEY) {
  return ["bind-key", "-n", key, ...menuRunShellArgs(menuCmd)];
}
function menuStatusBindCommand(menuCmd = "tmux-ide menu") {
  return ["bind-key", "-n", MENU_STATUS_KEY, ...menuStatusMouseRunShellArgs(menuCmd)];
}
function menuPaneBindCommand(menuCmd = "tmux-ide menu") {
  return ["bind-key", "-n", MENU_PANE_KEY, ...menuPaneMouseRunShellArgs(menuCmd)];
}
function menuUnbindCommand(key = MENU_KEY) {
  return ["unbind-key", "-n", key];
}
function menuStatusUnbindCommand() {
  return ["unbind-key", "-n", MENU_STATUS_KEY];
}
function menuPaneUnbindCommand() {
  return ["unbind-key", "-n", MENU_PANE_KEY];
}
var PANEL_MENU_KEYS, MAX_SESSION_ITEMS;
var init_menu = __esm({
  "packages/daemon/src/tui/chrome/menu.ts"() {
    "use strict";
    init_app_config();
    init_statusline();
    init_cheatsheet();
    init_panels();
    PANEL_MENU_KEYS = ["e", "g", ","];
    MAX_SESSION_ITEMS = 8;
  }
});

// packages/daemon/src/tui/chrome/welcome.ts
var welcome_exports = {};
__export(welcome_exports, {
  buildWelcomeText: () => buildWelcomeText,
  markWelcomed: () => markWelcomed,
  maybeShowWelcomePopup: () => maybeShowWelcomePopup,
  shouldShowWelcome: () => shouldShowWelcome,
  welcomeMarkerPath: () => welcomeMarkerPath
});
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync4, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname7, join as join6 } from "node:path";
function renderKey2(tmuxKey) {
  return tmuxKey.replace(/M-/g, "\u2325").replace(/C-/g, "^").replace(/S-/g, "\u21E7");
}
function welcomeMarkerPath() {
  const home = process.env.TMUX_IDE_HOME ?? join6(homedir6(), ".tmux-ide");
  return join6(home, "welcomed");
}
function shouldShowWelcome() {
  return !existsSync8(welcomeMarkerPath()) && getAppConfig().welcome.show;
}
function markWelcomed() {
  const path2 = welcomeMarkerPath();
  try {
    mkdirSync4(dirname7(path2), { recursive: true });
    writeFileSync5(path2, (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function buildWelcomeText(keys = DEFAULT_KEYS) {
  const lines = [
    head2(" You're in tmux-ide"),
    dim2(" your terminal, now a fleet you can see and steer."),
    "",
    " Four keys unlock everything:",
    `   ${bold2("right-click")}   the actions menu \u2014 anywhere`,
    `   ${bold2(renderKey2(keys.home).padEnd(11))}   the home cockpit`,
    `   ${bold2(renderKey2(keys.popup).padEnd(11))}   switch session`,
    `   ${bold2(renderKey2(keys.cheatsheet).padEnd(11))}   all keys (the cheat sheet)`,
    "",
    dim2(" This card shows once \u2014 press any key to close.")
  ];
  return lines.join("\n");
}
function maybeShowWelcomePopup() {
  if (!shouldShowWelcome()) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn2(
      "tmux",
      ["display-popup", "-E", "-w", "60", "-h", "12", "tmux-ide welcome"],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch {
  }
  markWelcomed();
}
var bold2, dim2, head2;
var init_welcome = __esm({
  "packages/daemon/src/tui/chrome/welcome.ts"() {
    "use strict";
    init_app_config();
    bold2 = (s) => `\x1B[1m${s}\x1B[22m`;
    dim2 = (s) => `\x1B[2m${s}\x1B[22m`;
    head2 = (s) => `\x1B[1;36m${s}\x1B[0m`;
  }
});

// packages/daemon/src/tui/integrations/claude.ts
var claude_exports = {};
__export(claude_exports, {
  EVENT_STATES: () => EVENT_STATES,
  HOOK_SCRIPT: () => HOOK_SCRIPT,
  HOOK_SCRIPT_RELPATH: () => HOOK_SCRIPT_RELPATH,
  claudeIntegrationStatus: () => claudeIntegrationStatus,
  claudeSettingsPath: () => claudeSettingsPath,
  hookScriptPath: () => hookScriptPath,
  installClaudeIntegration: () => installClaudeIntegration,
  isInstalled: () => isInstalled,
  mergeHooks: () => mergeHooks,
  removeHooks: () => removeHooks,
  uninstallClaudeIntegration: () => uninstallClaudeIntegration
});
import {
  chmodSync as chmodSync2,
  copyFileSync,
  existsSync as existsSync9,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync6,
  writeFileSync as writeFileSync6
} from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname8, join as join7 } from "node:path";
function hookScriptPath() {
  return join7(homedir7(), HOOK_SCRIPT_RELPATH);
}
function claudeSettingsPath() {
  return process.env.TMUX_IDE_CLAUDE_SETTINGS ?? join7(homedir7(), ".claude", "settings.json");
}
function isOurs(group) {
  return group.hooks?.some((h) => h.command?.includes(HOOK_SCRIPT_RELPATH)) ?? false;
}
function mergeHooks(settings, scriptPath) {
  const next = { ...settings, hooks: { ...settings.hooks ?? {} } };
  const hooks = next.hooks;
  for (const { event, state, matcher } of EVENT_STATES) {
    const existing = (hooks[event] ?? []).filter((g) => !isOurs(g));
    const group = {
      ...matcher !== void 0 ? { matcher } : {},
      hooks: [{ type: "command", command: `${scriptPath} ${state}` }]
    };
    hooks[event] = [...existing, group];
  }
  return next;
}
function removeHooks(settings) {
  if (!settings.hooks) return { ...settings };
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length > 0) hooks[event] = kept;
  }
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}
function isInstalled(settings) {
  return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isOurs));
}
function readSettings(path2) {
  if (!existsSync9(path2)) return {};
  try {
    return JSON.parse(readFileSync6(path2, "utf8"));
  } catch {
    throw new Error(`${path2} is not valid JSON \u2014 fix or move it, then retry`);
  }
}
function installClaudeIntegration() {
  const script = hookScriptPath();
  mkdirSync5(dirname8(script), { recursive: true });
  writeFileSync6(script, HOOK_SCRIPT, "utf8");
  chmodSync2(script, 493);
  const settingsPath = claudeSettingsPath();
  mkdirSync5(dirname8(settingsPath), { recursive: true });
  const settings = readSettings(settingsPath);
  const backup = `${settingsPath}.tmux-ide.bak`;
  if (existsSync9(settingsPath) && !existsSync9(backup)) copyFileSync(settingsPath, backup);
  writeFileSync6(settingsPath, `${JSON.stringify(mergeHooks(settings, script), null, 2)}
`, "utf8");
  return { scriptPath: script, settingsPath };
}
function uninstallClaudeIntegration() {
  const settingsPath = claudeSettingsPath();
  const settings = readSettings(settingsPath);
  const wasInstalled = isInstalled(settings);
  if (wasInstalled) {
    writeFileSync6(settingsPath, `${JSON.stringify(removeHooks(settings), null, 2)}
`, "utf8");
  }
  return { settingsPath, wasInstalled };
}
function claudeIntegrationStatus() {
  return {
    installed: isInstalled(readSettings(claudeSettingsPath())),
    scriptExists: existsSync9(hookScriptPath())
  };
}
var HOOK_SCRIPT_RELPATH, HOOK_SCRIPT, EVENT_STATES;
var init_claude = __esm({
  "packages/daemon/src/tui/integrations/claude.ts"() {
    "use strict";
    HOOK_SCRIPT_RELPATH = ".tmux-ide/hooks/claude-state.sh";
    HOOK_SCRIPT = `#!/bin/sh
# tmux-ide agent-state hook (installed by: tmux-ide integration install claude)
# $1 = state to report: working | blocked | done | idle
state="\${1:-idle}"
payload="$(cat 2>/dev/null || true)"
[ -n "$TMUX_PANE" ] || exit 0
tmux set-option -p -t "$TMUX_PANE" @agent_state "\${state}:$(date +%s)" 2>/dev/null || exit 0
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
[ -n "$sid" ] && tmux set-option -p -t "$TMUX_PANE" @agent_session_id "$sid" 2>/dev/null
exit 0
`;
    EVENT_STATES = [
      { event: "UserPromptSubmit", state: "working" },
      { event: "PreToolUse", state: "working", matcher: "*" },
      { event: "Notification", state: "blocked" },
      { event: "Stop", state: "done" },
      { event: "SessionEnd", state: "idle" }
    ];
  }
});

// packages/daemon/src/tui/integrations/offer.ts
var offer_exports = {};
__export(offer_exports, {
  buildOfferText: () => buildOfferText,
  integrationOfferMarkerPath: () => integrationOfferMarkerPath,
  markIntegrationOffered: () => markIntegrationOffered,
  maybeOfferIntegrationPopup: () => maybeOfferIntegrationPopup,
  shouldOfferIntegration: () => shouldOfferIntegration
});
import { execFileSync as execFileSync5, spawn as spawn3 } from "node:child_process";
import { existsSync as existsSync10, mkdirSync as mkdirSync6, writeFileSync as writeFileSync7 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { dirname as dirname9, join as join8 } from "node:path";
function integrationOfferMarkerPath() {
  const home = process.env.TMUX_IDE_HOME ?? join8(homedir8(), ".tmux-ide");
  return join8(home, "integration-offered");
}
function shouldOfferIntegration(input) {
  return input.claudeOnPath && !input.integrationInstalled && !input.markerPresent && input.offerEnabled;
}
function markIntegrationOffered() {
  const path2 = integrationOfferMarkerPath();
  try {
    mkdirSync6(dirname9(path2), { recursive: true });
    writeFileSync7(path2, (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function buildOfferText() {
  const bold4 = (s) => `\x1B[1m${s}\x1B[22m`;
  const dim4 = (s) => `\x1B[2m${s}\x1B[22m`;
  const head3 = (s) => `\x1B[1;36m${s}\x1B[0m`;
  return [
    head3(" Claude Code detected"),
    "",
    " Install the tmux-ide integration for ground-truth agent status?",
    dim4(" It hooks Claude Code's lifecycle so pane state is exact, not guessed."),
    "",
    ` ${bold4("[y]")} install    ${bold4("[N]")} skip (any other key)`,
    dim4(" Asked once \u2014 press a key.")
  ].join("\n");
}
function maybeOfferIntegrationPopup() {
  let offer;
  try {
    const status2 = claudeIntegrationStatus();
    offer = shouldOfferIntegration({
      claudeOnPath: claudeOnPath(),
      integrationInstalled: status2.installed,
      markerPresent: existsSync10(integrationOfferMarkerPath()),
      offerEnabled: getAppConfig().integrations.offer
    });
  } catch {
    return;
  }
  if (!offer) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn3(
      "tmux",
      ["display-popup", "-E", "-w", "64", "-h", "12", "tmux-ide integration offer"],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch {
  }
  markIntegrationOffered();
}
function claudeOnPath() {
  try {
    execFileSync5("which", ["claude"], { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch {
    return false;
  }
}
var init_offer = __esm({
  "packages/daemon/src/tui/integrations/offer.ts"() {
    "use strict";
    init_app_config();
    init_claude();
  }
});

// packages/daemon/src/tui/chrome/kitty-keys.ts
function kittyEscapeFor(key) {
  const m = /^M-(.)$/.exec(key);
  const ch = m?.[1];
  if (ch === void 0) return null;
  const code = ch.toLowerCase().codePointAt(0);
  if (code === void 0) return null;
  return `\x1B[${code};3:1u`;
}
function kittyUserKeyIndex(slot) {
  return 100 + slot;
}
function kittyUserKeyName(slot) {
  return `User${kittyUserKeyIndex(slot)}`;
}
var init_kitty_keys = __esm({
  "packages/daemon/src/tui/chrome/kitty-keys.ts"() {
    "use strict";
  }
});

// packages/daemon/src/schemas/registry.ts
import { z as z10 } from "zod";
var RegisteredProjectSchemaZ, RegisterProjectRequestSchemaZ, InitProjectRequestSchemaZ, ProjectTemplateSchemaZ;
var init_registry = __esm({
  "packages/daemon/src/schemas/registry.ts"() {
    "use strict";
    RegisteredProjectSchemaZ = z10.object({
      /** Unique registry key. Defaults to `basename(dir)`; collisions resolved by appending `-2`, `-3`, … */
      name: z10.string(),
      /** Absolute path to the project directory. */
      dir: z10.string(),
      /** Whether `<dir>/ide.yml` exists; refreshed on register and on `probe()`. */
      hasIdeYml: z10.boolean(),
      /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
      gitOrigin: z10.string().nullable(),
      /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
      gitBranch: z10.string().nullable(),
      /** ISO-8601 timestamp the project was first registered. */
      registeredAt: z10.string()
    });
    RegisterProjectRequestSchemaZ = z10.object({
      dir: z10.string().min(1),
      name: z10.string().min(1).optional()
    });
    InitProjectRequestSchemaZ = z10.object({
      dir: z10.string().min(1),
      template: z10.string().min(1).optional()
    });
    ProjectTemplateSchemaZ = z10.object({
      id: z10.string(),
      label: z10.string(),
      description: z10.string()
    });
  }
});

// packages/daemon/src/lib/project-probe.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync11 } from "node:fs";
import { basename as basename3, isAbsolute, resolve as resolve7 } from "node:path";
function sanitizeName(raw) {
  return raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^-+|-+$/g, "");
}
async function probeProject(dir, io = realIo) {
  const absoluteDir = isAbsolute(dir) ? dir : resolve7(dir);
  const rawName = basename3(absoluteDir);
  const sanitized = sanitizeName(rawName);
  const name = sanitized.length > 0 ? sanitized : "project";
  const hasIdeYml = io.exists(`${absoluteDir}/ide.yml`);
  const [gitOrigin, gitBranch] = await Promise.all([
    io.runGit(["config", "--get", "remote.origin.url"], absoluteDir),
    io.runGit(["branch", "--show-current"], absoluteDir)
  ]);
  return {
    name,
    dir: absoluteDir,
    hasIdeYml,
    // Treat empty string as null — branch --show-current returns "" on a
    // detached HEAD.
    gitOrigin: gitOrigin && gitOrigin.length > 0 ? gitOrigin : null,
    gitBranch: gitBranch && gitBranch.length > 0 ? gitBranch : null
  };
}
var GIT_TIMEOUT_MS, realIo;
var init_project_probe = __esm({
  "packages/daemon/src/lib/project-probe.ts"() {
    "use strict";
    GIT_TIMEOUT_MS = 2e3;
    realIo = {
      exists: existsSync11,
      runGit: (args, cwd) => new Promise((resolveResult) => {
        execFile(
          "git",
          ["-C", cwd, ...args],
          { timeout: GIT_TIMEOUT_MS, encoding: "utf-8" },
          (err, stdout) => {
            if (err) {
              resolveResult(null);
              return;
            }
            resolveResult(stdout.trim());
          }
        );
      })
    };
  }
});

// packages/daemon/src/lib/project-registry.ts
import { EventEmitter } from "node:events";
import { existsSync as existsSync12, mkdirSync as mkdirSync7, readFileSync as readFileSync7, renameSync as renameSync3, writeFileSync as writeFileSync8 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { dirname as dirname10, isAbsolute as isAbsolute2, join as join9, resolve as resolve8 } from "node:path";
import { z as z11 } from "zod";
function applyAction(state, action) {
  switch (action.type) {
    case "register":
      return [...state, action.project];
    case "unregister":
      return state.filter((p) => p.name !== action.name);
    case "replace":
      return state.map((p) => p.name === action.project.name ? action.project : p);
  }
}
function resolveUniqueName(state, desired) {
  const used = new Set(state.map((p) => p.name));
  if (!used.has(desired)) return desired;
  let counter = 2;
  while (used.has(`${desired}-${counter}`)) counter++;
  return `${desired}-${counter}`;
}
function buildRegisteredProject(probe, name, registeredAt) {
  return {
    name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    registeredAt
  };
}
function registryDir() {
  const override = process.env[REGISTRY_DIR_ENV];
  if (override && override.length > 0) return override;
  return join9(homedir9(), ".tmux-ide");
}
function registryPath() {
  return join9(registryDir(), "projects.json");
}
function readDisk() {
  const path2 = registryPath();
  if (!existsSync12(path2)) return [];
  const raw = readFileSync7(path2, "utf-8");
  if (raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[project-registry] %s contains invalid JSON; ignoring", path2);
    return [];
  }
  const result = RegistryFileSchemaZ.safeParse(parsed);
  if (!result.success) {
    console.warn(
      "[project-registry] %s failed schema validation; ignoring (%s)",
      path2,
      result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
    return [];
  }
  return result.data.projects;
}
function writeDisk(projects) {
  const path2 = registryPath();
  const dir = dirname10(path2);
  mkdirSync7(dir, { recursive: true });
  const file = { version: 1, projects };
  const tmpPath = `${path2}.tmp`;
  writeFileSync8(tmpPath, JSON.stringify(file, null, 2) + "\n");
  renameSync3(tmpPath, path2);
}
function ensureCache() {
  if (cache2 !== null) return cache2;
  cache2 = readDisk();
  return cache2;
}
function commit(next) {
  cache2 = next;
  writeDisk(next);
  projectRegistryEmitter.emit("change");
}
function listProjects() {
  return [...ensureCache()];
}
function getProject(name) {
  return ensureCache().find((p) => p.name === name) ?? null;
}
async function registerProject(input) {
  const exists = input.exists ?? existsSync12;
  const absoluteDir = isAbsolute2(input.dir) ? input.dir : resolve8(input.dir);
  if (!exists(absoluteDir)) {
    throw new ProjectDirNotFoundError(absoluteDir);
  }
  const probe = await probeProject(absoluteDir, input.io);
  const state = ensureCache();
  const desired = input.name ? sanitizeName(input.name) : probe.name;
  const cleaned = desired.length > 0 ? desired : probe.name;
  let resolvedName;
  if (input.name) {
    if (state.some((p) => p.name === cleaned)) {
      throw new ProjectAlreadyRegisteredError(cleaned, resolveUniqueName(state, cleaned));
    }
    resolvedName = cleaned;
  } else {
    resolvedName = resolveUniqueName(state, cleaned);
  }
  const dupDir = state.find((p) => p.dir === probe.dir);
  if (dupDir) {
    throw new ProjectAlreadyRegisteredError(dupDir.name, dupDir.name);
  }
  const now = (input.now ?? (() => /* @__PURE__ */ new Date()))();
  const project = buildRegisteredProject(probe, resolvedName, now.toISOString());
  commit(applyAction(state, { type: "register", project }));
  return project;
}
function unregisterProject(name) {
  const state = ensureCache();
  if (!state.some((p) => p.name === name)) {
    throw new ProjectNotFoundError(name);
  }
  commit(applyAction(state, { type: "unregister", name }));
}
async function refreshProject(name, options = {}) {
  const state = ensureCache();
  const existing = state.find((p) => p.name === name);
  if (!existing) throw new ProjectNotFoundError(name);
  const probe = await probeProject(existing.dir, options.io);
  const refreshed = buildRegisteredProject(probe, existing.name, existing.registeredAt);
  commit(applyAction(state, { type: "replace", project: refreshed }));
  return refreshed;
}
var REGISTRY_DIR_ENV, RegistryFileSchemaZ, ProjectRegistryError, ProjectAlreadyRegisteredError, ProjectNotFoundError, ProjectDirNotFoundError, projectRegistryEmitter, cache2;
var init_project_registry = __esm({
  "packages/daemon/src/lib/project-registry.ts"() {
    "use strict";
    init_registry();
    init_project_probe();
    REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
    RegistryFileSchemaZ = z11.object({
      version: z11.literal(1),
      projects: z11.array(RegisteredProjectSchemaZ)
    });
    ProjectRegistryError = class extends Error {
      code;
      constructor(message, code) {
        super(message);
        this.name = "ProjectRegistryError";
        this.code = code;
      }
    };
    ProjectAlreadyRegisteredError = class extends ProjectRegistryError {
      suggestion;
      constructor(name, suggestion) {
        super(`Project "${name}" is already registered`, "ALREADY_REGISTERED");
        this.name = "ProjectAlreadyRegisteredError";
        this.suggestion = suggestion;
      }
    };
    ProjectNotFoundError = class extends ProjectRegistryError {
      constructor(name) {
        super(`Project "${name}" not found in registry`, "NOT_FOUND");
        this.name = "ProjectNotFoundError";
      }
    };
    ProjectDirNotFoundError = class extends ProjectRegistryError {
      constructor(dir) {
        super(`Directory "${dir}" does not exist`, "DIR_NOT_FOUND");
        this.name = "ProjectDirNotFoundError";
      }
    };
    projectRegistryEmitter = new EventEmitter();
    projectRegistryEmitter.setMaxListeners(0);
    cache2 = null;
  }
});

// packages/daemon/src/tui/team/projects.ts
var projects_exports = {};
__export(projects_exports, {
  groupSessions: () => groupSessions,
  listTeamProjects: () => listTeamProjects
});
function normalizeDir(dir) {
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}
function isInside(cwd, dir) {
  const base = normalizeDir(dir);
  const path2 = normalizeDir(cwd);
  if (path2 === base) return true;
  return path2.startsWith(base === "/" ? "/" : `${base}/`);
}
function groupSessions(projectsIn, sessionsIn, sessionCwd) {
  const projects = projectsIn.filter((p) => !p.name.startsWith("_"));
  const sessions = sessionsIn.filter((s) => !s.name.startsWith("_"));
  const buckets = /* @__PURE__ */ new Map();
  for (const p of projects) buckets.set(p.name, []);
  const matched = /* @__PURE__ */ new Set();
  const byName = new Map(projects.map((p) => [p.name, p]));
  for (const session of sessions) {
    if (byName.has(session.name)) {
      buckets.get(session.name).push(session);
      matched.add(session);
    }
  }
  for (const session of sessions) {
    if (matched.has(session)) continue;
    const cwd = sessionCwd(session.name);
    if (!cwd) continue;
    let best;
    for (const p of projects) {
      if (!isInside(cwd, p.dir)) continue;
      if (!best || normalizeDir(p.dir).length > normalizeDir(best.dir).length) best = p;
    }
    if (best) {
      buckets.get(best.name).push(session);
      matched.add(session);
    }
  }
  const registered = projects.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const own = buckets.get(p.name) ?? [];
    return {
      name: p.name,
      dir: p.dir,
      hasIdeYml: p.hasIdeYml ?? false,
      gitBranch: p.gitBranch ?? null,
      registered: true,
      running: own.length > 0,
      status: rollupStatus(own.map((s) => s.status)),
      sessions: own
    };
  });
  const adhoc = sessions.filter((s) => !matched.has(s)).map((s) => ({
    name: s.name,
    dir: sessionCwd(s.name) ?? null,
    hasIdeYml: false,
    gitBranch: null,
    registered: false,
    running: true,
    status: rollupStatus([s.status]),
    sessions: [s]
  }));
  return [...registered, ...adhoc];
}
function listTeamProjects(tracker, opts = {}) {
  let projects;
  try {
    projects = listProjects();
  } catch {
    projects = [];
  }
  let sessions;
  try {
    sessions = listTeamSessions(tracker, opts);
  } catch {
    sessions = [];
  }
  const cwd = (name) => {
    try {
      return getSessionCwd(name);
    } catch {
      return null;
    }
  };
  return groupSessions(projects, sessions, cwd);
}
var init_projects = __esm({
  "packages/daemon/src/tui/team/projects.ts"() {
    "use strict";
    init_src();
    init_project_registry();
    init_sessions2();
  }
});

// packages/daemon/src/tui/chrome/chip.ts
function paneChip(agent, status2, theme = DEFAULT_THEME) {
  if (!agent) return "";
  return `${statusStyle(status2, theme)}${agent} \xB7 ${status2}#[default]`;
}
var init_chip = __esm({
  "packages/daemon/src/tui/chrome/chip.ts"() {
    "use strict";
    init_app_config();
    init_statusline();
  }
});

// packages/daemon/src/tui/chrome/events.ts
var events_exports = {};
__export(events_exports, {
  EVENTS_MAX_BYTES: () => EVENTS_MAX_BYTES,
  appendEvents: () => appendEvents,
  diffFleet: () => diffFleet,
  eventsPath: () => eventsPath,
  formatEventLine: () => formatEventLine,
  shouldRotate: () => shouldRotate
});
import { appendFileSync, existsSync as existsSync13, mkdirSync as mkdirSync8, renameSync as renameSync4, statSync } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { join as join10 } from "node:path";
function diffFleet(prev, next) {
  const state = /* @__PURE__ */ new Map();
  const events = [];
  for (const { name, status: status2 } of next) {
    const before = prev.has(name) ? prev.get(name) : null;
    state.set(name, status2);
    if (before === null) {
      events.push({ session: name, from: null, to: status2 });
    } else if (before !== status2) {
      events.push({ session: name, from: before, to: status2 });
    }
  }
  return { events, state };
}
function shouldRotate(sizeBytes) {
  return sizeBytes > EVENTS_MAX_BYTES;
}
function isoTime(ts) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}
function formatEventLine(ev, paint = (_s, t) => t) {
  const from = ev.from === null ? "\xB7" : paint(ev.from, ev.from);
  return `${isoTime(ev.ts)} ${ev.session} ${from} \u2192 ${paint(ev.to, ev.to)}`;
}
function eventsPath() {
  return join10(homedir10(), ".tmux-ide", "events.jsonl");
}
function appendEvents(events, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  if (events.length === 0) return;
  const path2 = eventsPath();
  try {
    mkdirSync8(join10(homedir10(), ".tmux-ide"), { recursive: true });
    if (existsSync13(path2) && shouldRotate(statSync(path2).size)) {
      renameSync4(path2, `${path2}.1`);
    }
    const ts = now();
    const lines = events.map((e) => `${JSON.stringify({ ts, ...e })}
`).join("");
    appendFileSync(path2, lines);
  } catch {
  }
}
var EVENTS_MAX_BYTES;
var init_events = __esm({
  "packages/daemon/src/tui/chrome/events.ts"() {
    "use strict";
    EVENTS_MAX_BYTES = 1024 * 1024;
  }
});

// packages/daemon/src/tui/chrome/notify.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { existsSync as existsSync14, readFileSync as readFileSync8 } from "node:fs";
function statusPhrase(to) {
  return to === "blocked" ? "needs input" : "finished";
}
function notifyMessage(ev) {
  const agent = ev.agent && ev.agent.length > 0 ? ev.agent : "agent";
  const where = ev.location && ev.location.length > 0 ? ev.location : ev.session;
  const text = `${agent} ${ev.to} \xB7 ${where} \u2014 ${statusPhrase(ev.to)}`;
  return text.length > NOTIFY_MAX_LEN ? `${text.slice(0, NOTIFY_MAX_LEN - 1)}\u2026` : text;
}
function enabledStates(prefs) {
  const states = /* @__PURE__ */ new Set();
  if (prefs.onBlocked) states.add("blocked");
  if (prefs.onDone) states.add("done");
  return states;
}
function decideNotifications(events, clients, lastNotified, nowMs, states = NOTIFY_STATES) {
  const nextLastNotified = new Map(lastNotified);
  const toasts = [];
  const system = [];
  for (const ev of events) {
    if (!states.has(ev.to)) continue;
    const key = `${ev.session}:${ev.to}`;
    const last = nextLastNotified.get(key);
    if (last !== void 0 && nowMs - last < NOTIFY_DEBOUNCE_MS) continue;
    nextLastNotified.set(key, nowMs);
    const message = notifyMessage(ev);
    for (const c of clients) {
      if (c.session === ev.session) continue;
      toasts.push({ client: c.client, message });
    }
    system.push({ message, session: ev.session });
  }
  return { toasts, system, nextLastNotified };
}
function parseClients(lines) {
  const out = [];
  for (const line of lines) {
    const [client = "", session = ""] = line.split("	");
    if (client && session) out.push({ client, session });
  }
  return out;
}
function listAttachedClients() {
  try {
    const raw = runTmux(["list-clients", "-F", "#{client_name}	#{session_name}"]).toString().trim();
    return raw ? parseClients(raw.split("\n")) : [];
  } catch {
    return [];
  }
}
function sendToasts(toasts) {
  for (const { client, message } of toasts) {
    try {
      runTmux(["display-message", "-c", client, "-d", "3000", message]);
    } catch {
    }
  }
}
function hasTerminalNotifier() {
  try {
    execFileSync6("which", ["terminal-notifier"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function terminalNotifierArgs(n) {
  return [
    "-title",
    "tmux-ide",
    "-message",
    n.message,
    "-execute",
    `tmux switch-client -t ${shellSingleQuote(n.session)}`
  ];
}
function sendSystemNotification(n) {
  if (process.platform !== "darwin") return;
  try {
    if (hasTerminalNotifier()) {
      execFileSync6("terminal-notifier", terminalNotifierArgs(n), { stdio: "ignore" });
      return;
    }
    const escaped = n.message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFileSync6("osascript", ["-e", `display notification "${escaped}" with title "tmux-ide"`], {
      stdio: "ignore"
    });
  } catch {
  }
}
function asObject2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function pickBool2(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function parseHHMM(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
function inQuietHours(now, quiet) {
  if (!quiet) return false;
  const start2 = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start2 === null || end === null || start2 === end) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return start2 < end ? nowMin >= start2 && nowMin < end : nowMin >= start2 || nowMin < end;
}
function parseQuietHours(value) {
  const o = asObject2(value);
  const start2 = typeof o.start === "string" ? o.start : null;
  const end = typeof o.end === "string" ? o.end : null;
  if (start2 === null || end === null) return null;
  if (parseHHMM(start2) === null || parseHHMM(end) === null) return null;
  return { start: start2, end };
}
function parseNotificationPrefs(rawConfig) {
  const base = parseAppConfig(rawConfig).notifications;
  const n = asObject2(asObject2(rawConfig).notifications);
  return {
    enabled: pickBool2(n.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    toast: base.toast,
    macos: base.macos,
    onBlocked: pickBool2(n.onBlocked, DEFAULT_NOTIFICATION_PREFS.onBlocked),
    onDone: pickBool2(n.onDone, DEFAULT_NOTIFICATION_PREFS.onDone),
    quietHours: parseQuietHours(n.quietHours)
  };
}
function applyKillSwitch(prefs, envValue) {
  return envValue === "0" ? { ...prefs, enabled: false, toast: false, macos: false } : prefs;
}
function readRawConfig() {
  const path2 = appConfigPath();
  if (!existsSync14(path2)) return void 0;
  try {
    return JSON.parse(readFileSync8(path2, "utf-8"));
  } catch {
    return void 0;
  }
}
function readNotificationPrefs() {
  return applyKillSwitch(parseNotificationPrefs(readRawConfig()), process.env.TMUX_IDE_NOTIFY);
}
var NOTIFY_STATES, NOTIFY_DEBOUNCE_MS, NOTIFY_MAX_LEN, DEFAULT_NOTIFICATION_PREFS;
var init_notify = __esm({
  "packages/daemon/src/tui/chrome/notify.ts"() {
    "use strict";
    init_src();
    init_app_config();
    NOTIFY_STATES = /* @__PURE__ */ new Set(["blocked", "done"]);
    NOTIFY_DEBOUNCE_MS = 3e4;
    NOTIFY_MAX_LEN = 120;
    DEFAULT_NOTIFICATION_PREFS = {
      enabled: true,
      toast: true,
      macos: false,
      onBlocked: true,
      onDone: true,
      quietHours: null
    };
  }
});

// packages/daemon/src/tui/chrome/snapshot.ts
import { existsSync as existsSync15, mkdirSync as mkdirSync9, readFileSync as readFileSync9, renameSync as renameSync5, writeFileSync as writeFileSync9 } from "node:fs";
import { homedir as homedir11 } from "node:os";
import { dirname as dirname11, join as join11 } from "node:path";
import { z as z12 } from "zod";
function isBareShell(cmd) {
  return /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu)$/.test(cmd.trim());
}
function resolvePaneCommand(cmd, pid, hint, table) {
  const { manifest } = resolveAgentCommand(cmd, pid, table, { hint: hint || void 0 });
  if (manifest && manifest.id !== "shell") {
    return { agent: manifest.id, command: manifest.id };
  }
  if (isBareShell(cmd)) return { agent: null, command: null };
  return { agent: null, command: cmd };
}
function nullable(value) {
  return value.length > 0 ? value : null;
}
function buildSnapshot(rawPanes, rawSessions, table, savedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const adopted = /* @__PURE__ */ new Set();
  for (const line of rawSessions) {
    const [name = "", flag = ""] = line.split("	");
    if (name && flag === "1") adopted.add(name);
  }
  const sessions = /* @__PURE__ */ new Map();
  for (const line of rawPanes) {
    if (line.length === 0) continue;
    const [
      session = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      layout = "",
      paneIndex = "0",
      cwd = "",
      cmd = "",
      pid = "0",
      agentSessionId = "",
      agentState = "",
      hint = "",
      ...titleParts
    ] = line.split("	");
    if (!session || !isListableSession(session)) continue;
    let windows = sessions.get(session);
    if (!windows) {
      windows = /* @__PURE__ */ new Map();
      sessions.set(session, windows);
    }
    const wIndex = Number(windowIndex) || 0;
    let win = windows.get(wIndex);
    if (!win) {
      win = {
        index: wIndex,
        name: windowName,
        active: windowActive === "1",
        layout,
        panes: []
      };
      windows.set(wIndex, win);
    }
    const { agent, command: command2 } = resolvePaneCommand(cmd, Number(pid) || 0, hint, table);
    win.panes.push({
      index: Number(paneIndex) || 0,
      cwd,
      command: command2,
      agent,
      agentSessionId: nullable(agentSessionId),
      agentState: nullable(agentState),
      title: titleParts.join("	")
    });
  }
  const out = [];
  for (const [name, windows] of sessions) {
    const windowList = [...windows.values()].sort((a, b) => a.index - b.index).map((w) => ({
      index: w.index,
      name: w.name,
      active: w.active,
      layout: w.layout,
      panes: w.panes.slice().sort((a, b) => a.index - b.index)
    }));
    const cwd = windowList[0]?.panes[0]?.cwd ?? "";
    out.push({ name, cwd, adopted: adopted.has(name), windows: windowList });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { version: 1, savedAt, sessions: out };
}
function snapshotFingerprint(snapshot) {
  const structural = {
    sessions: snapshot.sessions.map((s) => ({
      name: s.name,
      cwd: s.cwd,
      adopted: s.adopted,
      windows: s.windows.map((w) => ({
        index: w.index,
        name: w.name,
        active: w.active,
        layout: w.layout,
        panes: w.panes.map((p) => ({
          index: p.index,
          cwd: p.cwd,
          command: p.command,
          agent: p.agent,
          agentSessionId: p.agentSessionId,
          title: p.title
          // agentState deliberately omitted — it churns every tick.
        }))
      }))
    }))
  };
  return JSON.stringify(structural);
}
function collectFleetSnapshot(io = defaultIo) {
  const rawPanes = io.listPanes().split("\n").filter(Boolean);
  const rawSessions = io.listSessions().split("\n").filter(Boolean);
  return buildSnapshot(rawPanes, rawSessions, io.processTable());
}
function snapshotPath() {
  return join11(homedir11(), ".tmux-ide", "snapshot.json");
}
function writeSnapshot(snapshot) {
  const path2 = snapshotPath();
  try {
    mkdirSync9(dirname11(path2), { recursive: true });
    const tmp = `${path2}.tmp`;
    writeFileSync9(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    if (existsSync15(path2)) {
      try {
        renameSync5(path2, `${path2}.1`);
      } catch {
      }
    }
    renameSync5(tmp, path2);
  } catch {
  }
}
function readSnapshot() {
  const path2 = snapshotPath();
  try {
    if (!existsSync15(path2)) return null;
    const raw = readFileSync9(path2, "utf-8");
    if (raw.trim().length === 0) return null;
    const result = FleetSnapshotSchemaZ.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function createSnapshotter(deps2) {
  let ticks = 0;
  let seeded = false;
  let lastFingerprint = null;
  return {
    onTick() {
      ticks++;
      if (deps2.every <= 0 || ticks % deps2.every !== 0) return;
      if (!seeded) {
        const existing = deps2.read();
        lastFingerprint = existing ? snapshotFingerprint(existing) : null;
        seeded = true;
      }
      const snapshot = deps2.collect();
      const fingerprint = snapshotFingerprint(snapshot);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      deps2.write(snapshot);
    }
  };
}
var PaneSnapshotSchemaZ, WindowSnapshotSchemaZ, SessionSnapshotSchemaZ, FleetSnapshotSchemaZ, SNAPSHOT_PANE_FORMAT, SNAPSHOT_SESSION_FORMAT, defaultIo;
var init_snapshot2 = __esm({
  "packages/daemon/src/tui/chrome/snapshot.ts"() {
    "use strict";
    init_src();
    init_process_tree();
    init_sessions2();
    PaneSnapshotSchemaZ = z12.object({
      index: z12.number(),
      cwd: z12.string(),
      command: z12.string().nullable(),
      agent: z12.string().nullable(),
      agentSessionId: z12.string().nullable(),
      agentState: z12.string().nullable(),
      title: z12.string()
    });
    WindowSnapshotSchemaZ = z12.object({
      index: z12.number(),
      name: z12.string(),
      active: z12.boolean(),
      layout: z12.string(),
      panes: z12.array(PaneSnapshotSchemaZ)
    });
    SessionSnapshotSchemaZ = z12.object({
      name: z12.string(),
      cwd: z12.string(),
      adopted: z12.boolean(),
      windows: z12.array(WindowSnapshotSchemaZ)
    });
    FleetSnapshotSchemaZ = z12.object({
      version: z12.literal(1),
      savedAt: z12.string(),
      sessions: z12.array(SessionSnapshotSchemaZ)
    });
    SNAPSHOT_PANE_FORMAT = [
      "#{session_name}",
      "#{window_index}",
      "#{window_name}",
      "#{window_active}",
      "#{window_layout}",
      "#{pane_index}",
      "#{pane_current_path}",
      "#{pane_current_command}",
      "#{pane_pid}",
      "#{@agent_session_id}",
      "#{@agent_state}",
      "#{@agent_hint}",
      "#{pane_title}"
    ].join("	");
    SNAPSHOT_SESSION_FORMAT = ["#{session_name}", "#{@tmux_ide_adopted}"].join("	");
    defaultIo = {
      listPanes: () => runTmux(["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]).toString(),
      listSessions: () => runTmux(["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]).toString(),
      processTable: () => readProcessTable()
    };
  }
});

// packages/daemon/src/tui/chrome/updater.ts
var updater_exports = {};
__export(updater_exports, {
  ADOPTED_OPTION: () => ADOPTED_OPTION,
  CHIP_OPTION: () => CHIP_OPTION,
  STATUS_OPTION: () => STATUS_OPTION,
  TICK_MS: () => TICK_MS,
  UPDATER_PID_OPTION: () => UPDATER_PID_OPTION,
  UPDATER_SESSION: () => UPDATER_SESSION,
  adoptedSessionsFrom: () => adoptedSessionsFrom,
  enrichEvents: () => enrichEvents,
  fleetStatuses: () => fleetStatuses,
  listAdoptedSessions: () => listAdoptedSessions,
  paneLocation: () => paneLocation,
  pickRepresentativePane: () => pickRepresentativePane,
  runUpdaterLoop: () => runUpdaterLoop,
  runUpdaterTick: () => runUpdaterTick,
  seedSessionStatus: () => seedSessionStatus,
  startUpdaterIfNeeded: () => startUpdaterIfNeeded,
  stopUpdater: () => stopUpdater,
  updateSegment: () => updateSegment,
  updaterRunning: () => updaterRunning
});
function adoptedSessionsFrom(lines) {
  const out = [];
  for (const line of lines) {
    const [name = "", flag = ""] = line.split("	");
    if (name && flag === "1") out.push(name);
  }
  return out;
}
function listAdoptedSessions() {
  try {
    const raw = runTmux(["list-sessions", "-F", `#{session_name}	#{${ADOPTED_OPTION}}`]).toString().trim();
    return raw ? adoptedSessionsFrom(raw.split("\n")) : [];
  } catch {
    return [];
  }
}
function writeSessionStatus(session, value) {
  runTmux(["set-option", "-t", session, STATUS_OPTION, value]);
}
function writePaneChip(paneId, value) {
  runTmux(["set-option", "-p", "-t", paneId, CHIP_OPTION, value]);
}
function updateSegment(status2, theme) {
  if (!status2.updateAvailable || !status2.latest) return "";
  return `#[range=user|update]#[fg=${theme.accent}]\u2B06 v${status2.latest}#[default]#[norange]`;
}
function fleetStatuses(projects) {
  return projects.flatMap((p) => p.sessions.map((s) => ({ name: s.name, status: s.status })));
}
function runUpdaterTick(deps2) {
  const adopted = deps2.listAdopted();
  if (adopted.length === 0) return;
  const theme = deps2.theme ?? DEFAULT_THEME;
  const panes = [];
  const projects = deps2.computeProjects((pane) => panes.push(pane));
  const update = deps2.maybeCheckForUpdate?.();
  const extra = update ? updateSegment(update, theme) : "";
  for (const session of adopted) {
    deps2.writeStatus(session, buildStatusline(projects, session, 12, theme, extra));
  }
  writeChips(deps2, adopted, panes, theme);
  if (update?.updateAvailable && update.latest) dispatchUpdateToast(deps2, update.latest);
  if (deps2.prevState && deps2.appendEvents) {
    const { events, state } = diffFleet(deps2.prevState, fleetStatuses(projects));
    deps2.prevState.clear();
    for (const [name, status2] of state) deps2.prevState.set(name, status2);
    if (events.length > 0) {
      deps2.appendEvents(events);
      dispatchNotifications(deps2, enrichEvents(events, panes, deps2.locatePane));
    }
  }
}
function writeChips(deps2, adopted, panes, theme) {
  const { writeChip, chipCache } = deps2;
  if (!writeChip || !chipCache) return;
  const adoptedSet = new Set(adopted);
  for (const pane of panes) {
    if (!adoptedSet.has(pane.sessionName)) continue;
    const chip = paneChip(pane.agent, pane.status, theme);
    if (chipCache.get(pane.paneId) === chip) continue;
    chipCache.set(pane.paneId, chip);
    writeChip(pane.paneId, chip);
  }
}
function pickRepresentativePane(session, to, panes) {
  const matching = panes.filter((p) => p.sessionName === session && p.status === to);
  if (matching.length === 0) return null;
  return matching.find((p) => p.agent !== null) ?? matching[0];
}
function enrichEvents(events, panes, locate) {
  return events.map((ev) => {
    const notifiable = ev.to === "blocked" || ev.to === "done";
    const rep = notifiable ? pickRepresentativePane(ev.session, ev.to, panes) : null;
    return {
      ...ev,
      agent: rep?.agent ?? null,
      location: rep && locate ? locate(rep.paneId) : ev.session
    };
  });
}
function dispatchNotifications(deps2, events) {
  const { listClients, lastNotified, now, prefs, sendToasts: toast, sendSystem } = deps2;
  if (!listClients || !lastNotified || !now || !prefs) return;
  if (!prefs.enabled) return;
  if (!prefs.toast && !prefs.macos) return;
  const nowMs = now();
  const decision = decideNotifications(
    events,
    listClients(),
    lastNotified,
    nowMs,
    enabledStates(prefs)
  );
  lastNotified.clear();
  for (const [key, ts] of decision.nextLastNotified) lastNotified.set(key, ts);
  if (prefs.toast && toast) toast(decision.toasts);
  if (prefs.macos && sendSystem && !inQuietHours(new Date(nowMs), prefs.quietHours)) {
    for (const n of decision.system) sendSystem(n);
  }
}
function paneLocation(paneId) {
  try {
    const raw = runTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_index}.#{pane_index}"
    ]).toString().trim();
    return raw || paneId;
  } catch {
    return paneId;
  }
}
function dispatchUpdateToast(deps2, version) {
  const { markUpdateNotified: mark, listClients, sendToasts: toast, prefs } = deps2;
  if (!mark || !listClients || !toast) return;
  if (prefs && !prefs.toast) return;
  if (!mark(version)) return;
  const message = `\u2B06 tmux-ide v${version} available \u2014 run: tmux-ide update`;
  toast(listClients().map((c) => ({ client: c.client, message })));
}
function seedSessionStatus(session) {
  try {
    const projects = listTeamProjects(createStatusTracker());
    writeSessionStatus(session, buildStatusline(projects, session, 12, getAppConfig().theme));
  } catch {
  }
}
function updaterRunning() {
  try {
    return hasSession(UPDATER_SESSION);
  } catch {
    return false;
  }
}
function startUpdaterIfNeeded() {
  try {
    if (updaterRunning()) return;
    runTmux(["new-session", "-d", "-s", UPDATER_SESSION, "exec tmux-ide chrome-updater"]);
  } catch {
  }
}
function stopUpdater() {
  try {
    if (updaterRunning()) runTmux(["kill-session", "-t", UPDATER_SESSION]);
  } catch {
  }
}
function readUpdaterPid() {
  try {
    const raw = runTmux(["show-option", "-s", "-v", UPDATER_PID_OPTION]).toString().trim();
    const pid = Number(raw);
    return raw && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
function claimUpdater() {
  const existing = readUpdaterPid();
  if (existing !== null && existing !== process.pid && isProcessAlive(existing)) return false;
  try {
    runTmux(["set-option", "-s", UPDATER_PID_OPTION, String(process.pid)]);
  } catch {
  }
  return true;
}
function releaseUpdater() {
  try {
    if (readUpdaterPid() === process.pid) runTmux(["set-option", "-s", "-u", UPDATER_PID_OPTION]);
  } catch {
  }
}
function runUpdaterLoop() {
  if (!claimUpdater()) return;
  const config2 = getAppConfig();
  const tracker = createStatusTracker();
  const prevState = /* @__PURE__ */ new Map();
  const lastNotified = /* @__PURE__ */ new Map();
  const chipCache = /* @__PURE__ */ new Map();
  const snapshotter = createSnapshotter({
    collect: () => collectFleetSnapshot(),
    read: readSnapshot,
    write: writeSnapshot,
    every: config2.updater.snapshotEvery
  });
  const tick = () => {
    try {
      runUpdaterTick({
        listAdopted: listAdoptedSessions,
        computeProjects: (onPane) => listTeamProjects(tracker, { onPane }),
        writeStatus: writeSessionStatus,
        theme: config2.theme,
        writeChip: writePaneChip,
        chipCache,
        prevState,
        appendEvents,
        listClients: listAttachedClients,
        lastNotified,
        now: () => Date.now(),
        prefs: readNotificationPrefs(),
        sendToasts,
        sendSystem: sendSystemNotification,
        locatePane: paneLocation,
        maybeCheckForUpdate: () => maybeCheckForUpdate({ enabled: config2.updates.check }),
        markUpdateNotified
      });
    } catch {
    }
    try {
      snapshotter.onTick();
    } catch {
    }
  };
  tick();
  const timer = setInterval(tick, config2.updater.tickMs);
  const shutdown = () => {
    clearInterval(timer);
    releaseUpdater();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
var STATUS_OPTION, CHIP_OPTION, ADOPTED_OPTION, UPDATER_SESSION, UPDATER_PID_OPTION, TICK_MS;
var init_updater = __esm({
  "packages/daemon/src/tui/chrome/updater.ts"() {
    "use strict";
    init_src();
    init_app_config();
    init_update_check();
    init_classify();
    init_projects();
    init_chip();
    init_events();
    init_notify();
    init_snapshot2();
    init_statusline();
    STATUS_OPTION = "@tmux_ide_status";
    CHIP_OPTION = "@tmux_ide_chip";
    ADOPTED_OPTION = "@tmux_ide_adopted";
    UPDATER_SESSION = "_tmux-ide-chrome";
    UPDATER_PID_OPTION = "@tmux_ide_updater_pid";
    TICK_MS = 2e3;
  }
});

// packages/daemon/src/tui/chrome/statusline.ts
var statusline_exports = {};
__export(statusline_exports, {
  HOME_KEY: () => HOME_KEY,
  MENU_KEY: () => MENU_KEY,
  MENU_PANE_KEY: () => MENU_PANE_KEY,
  MENU_STATUS_KEY: () => MENU_STATUS_KEY,
  POPUP_KEY: () => POPUP_KEY,
  STATUS_CLICK_KEY: () => STATUS_CLICK_KEY,
  adoptOptionCommands: () => adoptOptionCommands,
  adoptSession: () => adoptSession,
  adoptableSessionNames: () => adoptableSessionNames,
  altKeyBinds: () => altKeyBinds,
  buildStatusline: () => buildStatusline,
  homeBindCommand: () => homeBindCommand,
  homePopupCommand: () => homePopupCommand,
  homeUnbindCommand: () => homeUnbindCommand,
  isInternalName: () => isInternalName,
  popupBindCommand: () => popupBindCommand,
  popupUnbindCommand: () => popupUnbindCommand,
  prefixKeyBinds: () => prefixKeyBinds,
  statusClickBindCommand: () => statusClickBindCommand,
  statusClickUnbindCommand: () => statusClickUnbindCommand,
  statusGlyph: () => statusGlyph,
  statusStyle: () => statusStyle,
  switcherPopupCommand: () => switcherPopupCommand,
  unadoptOptionCommands: () => unadoptOptionCommands,
  unadoptSession: () => unadoptSession,
  updatePopupCommand: () => updatePopupCommand
});
function statusStyle(status2, theme) {
  const color2 = theme.status[status2];
  return status2 === "blocked" ? `#[fg=${color2},bold]` : `#[fg=${color2}]`;
}
function statusGlyph(status2, theme) {
  return status2 === "unknown" ? "\xB7" : theme.glyphs.active;
}
function isInternalName(name) {
  return name.startsWith("_");
}
function adoptableSessionNames(names) {
  return names.filter((name) => name.length > 0 && !isInternalName(name));
}
function buildStatusline(projects, active2, maxItems = 12, theme = DEFAULT_THEME, extraSegment = "") {
  const visible = projects.filter((p) => !isInternalName(p.name));
  const segments = [];
  for (const project of visible.slice(0, maxItems)) {
    const isActive = active2 !== null && (project.name === active2 || project.sessions.some((s) => s.name === active2));
    const glyph = project.running ? `${statusStyle(project.status, theme)}${statusGlyph(project.status, theme)}#[default]` : `#[fg=${theme.muted}]${theme.glyphs.inactive}#[default]`;
    const name = isActive ? `#[fg=colour231,bold,underscore]${project.name}#[default]` : project.running ? `#[fg=${theme.fg}]${project.name}#[default]` : `#[fg=${theme.muted}]${project.name}#[default]`;
    const label = `${glyph} ${name}`;
    const session = project.sessions[0]?.name;
    segments.push(
      project.running && session ? `#[range=user|sw${session}]${label}#[norange]` : label
    );
  }
  if (visible.length > maxItems) {
    segments.push(`#[fg=${theme.muted}]+${visible.length - maxItems}#[default]`);
  }
  const body = segments.join("  ");
  const extra = extraSegment ? `${extraSegment} ` : "";
  const keysTrigger = `#[range=user|keys]#[fg=colour244][ ? keys ^b k ]#[default]#[norange]`;
  const homeTrigger = `#[range=user|home]#[fg=colour244][ \u2302 home ^b h ]#[default]#[norange]`;
  const trigger = `#[range=user|switcher]#[fg=${theme.accent},bold][ \u29C9 switch ^b j ]#[default]#[norange]`;
  return `#[fg=${theme.accent},bold] tmux-ide #[default] ${body}#[align=right]${extra}${homeTrigger} ${keysTrigger} ${trigger} `;
}
function switcherPopupCommand(switcherCmd = "tmux-ide switcher") {
  return `display-popup -E -w 80% -h 60% "${switcherCmd}"`;
}
function popupBindCommand(switcherCmd = "tmux-ide switcher", key = POPUP_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "80%", "-h", "60%", switcherCmd];
}
function popupUnbindCommand(key = POPUP_KEY) {
  return ["unbind-key", "-n", key];
}
function homePopupCommand(homeCmd = "tmux-ide team --popup") {
  return `display-popup -E -w 95% -h 95% "${homeCmd}"`;
}
function homeBindCommand(homeCmd = "tmux-ide team --popup", key = HOME_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "95%", "-h", "95%", homeCmd];
}
function homeUnbindCommand(key = HOME_KEY) {
  return ["unbind-key", "-n", key];
}
function updatePopupCommand(updateCmd = "tmux-ide update --dry-run") {
  const shell = `${updateCmd}; echo ''; echo '[ press Enter to close ]'; read _`;
  return `display-popup -E -w 70% -h 50% "${shell}"`;
}
function dq(cmd) {
  return `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function statusClickBindCommand(switcherCmd = "tmux-ide switcher", cheatsheetCmd = "tmux-ide cheatsheet") {
  const popup = switcherPopupCommand(switcherCmd);
  const cheatsheet = cheatsheetPopupCommand(cheatsheetCmd);
  const home = homePopupCommand();
  const update = updatePopupCommand();
  const switchClient = `run-shell "tmux switch-client -c '#{client_name}' -t '#{s/^sw//:mouse_status_range}'"`;
  const swBranch = `if-shell -F "#{m:sw*,#{mouse_status_range}}" ${dq(switchClient)} "select-window -t ="`;
  const keysBranch = `if-shell -F "#{==:#{mouse_status_range},keys}" ${dq(cheatsheet)} ${dq(swBranch)}`;
  const homeBranch = `if-shell -F "#{==:#{mouse_status_range},home}" ${dq(home)} ${dq(keysBranch)}`;
  const updateBranch = `if-shell -F "#{==:#{mouse_status_range},update}" ${dq(update)} ${dq(homeBranch)}`;
  return [
    "bind-key",
    "-n",
    STATUS_CLICK_KEY,
    "if-shell",
    "-F",
    "#{==:#{mouse_status_range},switcher}",
    popup,
    updateBranch
  ];
}
function statusClickUnbindCommand() {
  return ["unbind-key", "-n", STATUS_CLICK_KEY];
}
function adoptOptionCommands(session) {
  const format = `#[align=left]#{${STATUS_OPTION}}`;
  const borderFormat = ` #{?#{${CHIP_OPTION}},#{${CHIP_OPTION}},#{pane_title}} `;
  return [
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-interval", "2"],
    ["set-option", "-t", session, "status-format[1]", format],
    // Status-line clicks need mouse mode ON. NOTE: this also changes scroll
    // behavior (the wheel enters copy-mode / scrolls pane history instead of the
    // terminal's native scrollback). Per-session (`-t`) so only adopted change.
    ["set-option", "-t", session, "mouse", "on"],
    // Per-pane agent chips on the bottom border (see borderFormat above).
    ["set-option", "-t", session, "pane-border-status", "bottom"],
    ["set-option", "-t", session, "pane-border-format", borderFormat],
    // Marker the updater enumerates by (readable in list-sessions -F formats).
    ["set-option", "-t", session, ADOPTED_OPTION, "1"]
  ];
}
function unadoptOptionCommands(session) {
  return [
    ["set-option", "-u", "-t", session, "status"],
    ["set-option", "-u", "-t", session, "status-interval"],
    ["set-option", "-u", "-t", session, "status-format[1]"],
    ["set-option", "-u", "-t", session, "mouse"],
    ["set-option", "-u", "-t", session, "pane-border-status"],
    ["set-option", "-u", "-t", session, "pane-border-format"],
    ["set-option", "-u", "-t", session, ADOPTED_OPTION],
    ["set-option", "-u", "-t", session, STATUS_OPTION]
  ];
}
function altKeyBinds(keys, switcherCmd = "tmux-ide switcher") {
  return [
    { key: keys.popup, bind: popupBindCommand(switcherCmd, keys.popup) },
    { key: keys.home, bind: homeBindCommand("tmux-ide team --popup", keys.home) },
    { key: keys.cheatsheet, bind: cheatsheetBindCommand("tmux-ide cheatsheet", keys.cheatsheet) },
    { key: keys.menu, bind: menuBindCommand("tmux-ide menu", keys.menu) },
    { key: keys.sidebar, bind: sidebarToggleBindCommand("tmux-ide sidebar-toggle", keys.sidebar) },
    ...PANEL_POPUPS.map((panel) => {
      const key = panelKey(panel, keys.panels);
      return { key, bind: panelPopupBindCommand(panel, key) };
    })
  ];
}
function prefixKeyBinds(keys, switcherCmd = "tmux-ide switcher") {
  const out = [];
  for (const { key, bind } of altKeyBinds(keys, switcherCmd)) {
    const remapped = PREFIX_REMAP[key];
    const letter = remapped ?? /^M-([a-z])$/.exec(key)?.[1];
    if (!letter || !remapped && PREFIX_TAKEN.has(letter)) continue;
    out.push({ pkey: letter, bind: ["bind-key", "-T", "prefix", letter, ...bind.slice(3)] });
  }
  return out;
}
function adoptSession(session, switcherCmd = "tmux-ide switcher") {
  for (const argv of adoptOptionCommands(session)) runTmux(argv);
  for (const legacy of LEGACY_BINDS) {
    try {
      runTmux(legacy);
    } catch {
    }
  }
  const keys = getAppConfig().keys;
  runTmux(statusClickBindCommand(switcherCmd));
  runTmux(menuStatusBindCommand());
  runTmux(menuPaneBindCommand());
  altKeyBinds(keys, switcherCmd).forEach(({ key, bind }, i) => {
    runTmux(bind);
    const escape = kittyEscapeFor(key);
    if (escape === null) return;
    const idx = kittyUserKeyIndex(i);
    runTmux(["set-option", "-s", `user-keys[${idx}]`, escape]);
    runTmux(["bind-key", "-n", kittyUserKeyName(i), ...bind.slice(3)]);
  });
  for (const { bind } of prefixKeyBinds(keys, switcherCmd)) runTmux(bind);
  seedSessionStatus(session);
  startUpdaterIfNeeded();
  maybeShowWelcomePopup();
  maybeOfferIntegrationPopup();
}
function unadoptSession(session) {
  for (const argv of unadoptOptionCommands(session)) runTmux(argv);
  const keys = getAppConfig().keys;
  for (const undo of [
    statusClickUnbindCommand(),
    menuStatusUnbindCommand(),
    menuPaneUnbindCommand()
  ]) {
    try {
      runTmux(undo);
    } catch {
    }
  }
  altKeyBinds(keys, "tmux-ide switcher").forEach(({ key }, i) => {
    try {
      runTmux(["unbind-key", "-n", key]);
    } catch {
    }
    if (kittyEscapeFor(key) === null) return;
    try {
      runTmux(["unbind-key", "-n", kittyUserKeyName(i)]);
    } catch {
    }
    try {
      runTmux(["set-option", "-su", `user-keys[${kittyUserKeyIndex(i)}]`]);
    } catch {
    }
  });
  for (const { pkey } of prefixKeyBinds(keys, "tmux-ide switcher")) {
    try {
      runTmux(["unbind-key", "-T", "prefix", pkey]);
    } catch {
    }
  }
  if (listAdoptedSessions().length === 0) stopUpdater();
}
var POPUP_KEY, HOME_KEY, MENU_KEY, MENU_STATUS_KEY, MENU_PANE_KEY, STATUS_CLICK_KEY, PREFIX_TAKEN, PREFIX_REMAP, LEGACY_BINDS;
var init_statusline = __esm({
  "packages/daemon/src/tui/chrome/statusline.ts"() {
    "use strict";
    init_src();
    init_app_config();
    init_cheatsheet();
    init_menu();
    init_panels();
    init_sidebar();
    init_welcome();
    init_offer();
    init_kitty_keys();
    init_updater();
    POPUP_KEY = "M-p";
    HOME_KEY = "M-h";
    MENU_KEY = "M-m";
    MENU_STATUS_KEY = "MouseUp3Status";
    MENU_PANE_KEY = "MouseUp3Pane";
    STATUS_CLICK_KEY = "MouseDown1Status";
    PREFIX_TAKEN = /* @__PURE__ */ new Set([..."cdfilmnopqrstwxz"]);
    PREFIX_REMAP = {
      "M-m": "u",
      // menu — m is mark-pane
      "M-p": "j",
      // switcher — p is previous-window; j = "jump"
      "M-,": "v"
      // config panel — , is rename-window
    };
    LEGACY_BINDS = [
      ["unbind-key", "-n", "MouseDown3Status"],
      ["unbind-key", "-n", "MouseDown3Pane"]
    ];
  }
});

// packages/daemon/src/lib/canonical-daemon.ts
var canonical_daemon_exports = {};
__export(canonical_daemon_exports, {
  clearCanonicalDaemonInfo: () => clearCanonicalDaemonInfo,
  getCanonicalDaemonInfoPath: () => getCanonicalDaemonInfoPath,
  isCanonicalDaemonAlive: () => isCanonicalDaemonAlive,
  readCanonicalDaemonInfo: () => readCanonicalDaemonInfo,
  warnOnDaemonVersionSkew: () => warnOnDaemonVersionSkew,
  writeCanonicalDaemonInfo: () => writeCanonicalDaemonInfo
});
import { existsSync as existsSync16, mkdirSync as mkdirSync10, readFileSync as readFileSync10, renameSync as renameSync6, rmSync, writeFileSync as writeFileSync10 } from "node:fs";
import { homedir as homedir12 } from "node:os";
import { dirname as dirname12, join as join12 } from "node:path";
function getCanonicalDaemonInfoPath() {
  const dir = process.env[DAEMON_INFO_DIR_ENV] ?? process.env[REGISTRY_DIR_ENV2] ?? join12(homedir12(), ".tmux-ide");
  return join12(dir, DAEMON_INFO_FILE);
}
function parseCanonicalDaemonInfo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const info = raw;
  const pid = info.pid;
  const port = info.port;
  if (typeof pid !== "number" || typeof port !== "number") return null;
  if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
  if (typeof info.version !== "string" || typeof info.startedAt !== "string") return null;
  if (typeof info.bindHostname !== "string") return null;
  if (info.authToken !== null && typeof info.authToken !== "string") return null;
  return {
    pid,
    port,
    version: info.version,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken
  };
}
function writeCanonicalDaemonInfo(info) {
  const path2 = getCanonicalDaemonInfoPath();
  mkdirSync10(dirname12(path2), { recursive: true });
  const tmpPath = `${path2}.${process.pid}.${Date.now()}.tmp`;
  const persisted = {
    pid: info.pid,
    port: info.port,
    version: info.version,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken
  };
  writeFileSync10(tmpPath, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
  renameSync6(tmpPath, path2);
}
function readCanonicalDaemonInfo() {
  const path2 = getCanonicalDaemonInfoPath();
  if (!existsSync16(path2)) return null;
  try {
    return parseCanonicalDaemonInfo(JSON.parse(readFileSync10(path2, "utf-8")));
  } catch {
    return null;
  }
}
function clearCanonicalDaemonInfo() {
  rmSync(getCanonicalDaemonInfoPath(), { force: true });
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function probeHostname(bindHostname) {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
function warnOnDaemonVersionSkew(info, expectedVersion) {
  if (info.version === expectedVersion) return;
  console.warn(
    `[tmux-ide] canonical daemon version skew: daemon.json reports "${info.version}" but this client expects "${expectedVersion}". The action/WS contract may have drifted \u2014 restart the canonical daemon (tmux-ide) so it matches this client build.`
  );
}
async function isCanonicalDaemonAlive(info) {
  if (!isPidAlive(info.pid)) return false;
  try {
    const res = await fetch(`http://${probeHostname(info.bindHostname)}:${info.port}/health`, {
      signal: timeoutSignal(750)
    });
    return res.ok;
  } catch {
    return false;
  }
}
var DAEMON_INFO_DIR_ENV, REGISTRY_DIR_ENV2, DAEMON_INFO_FILE;
var init_canonical_daemon = __esm({
  "packages/daemon/src/lib/canonical-daemon.ts"() {
    "use strict";
    DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
    REGISTRY_DIR_ENV2 = "TMUX_IDE_REGISTRY_DIR";
    DAEMON_INFO_FILE = "daemon.json";
  }
});

// packages/daemon/src/launch.ts
var launch_exports = {};
__export(launch_exports, {
  buildPaneMap: () => buildPaneMap,
  launch: () => launch,
  waitForPaneCommand: () => waitForPaneCommand
});
import { resolve as resolve9 } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
function stripWidgetPanes(rows) {
  return rows.map((row) => ({
    ...row,
    panes: row.panes.filter((p) => !p.type)
  })).filter((row) => row.panes.length > 0);
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function configHash(config2) {
  return createHash("sha256").update(JSON.stringify(config2)).digest("hex").slice(0, 12);
}
function waitForPaneCommand(targetPane, expectedCommands, {
  attempts = 20,
  delayMs = 100,
  getCurrentCommand = getPaneCurrentCommand,
  sleep: sleep2 = sleepMs
} = {}) {
  const allowed = new Set(expectedCommands.map((command2) => command2.toLowerCase()));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const current = getCurrentCommand(targetPane)?.trim().toLowerCase();
      if (current && allowed.has(current)) return true;
    } catch {
    }
    if (attempt < attempts - 1) {
      sleep2(delayMs);
    }
  }
  return false;
}
function buildPaneMap(rows, dir, rootPaneId, splitPaneFn) {
  const rowSizes = computeSizes(rows);
  const rowSplitPercents = toSplitPercents(rowSizes);
  const rowPaneIds = [rootPaneId];
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const splitFrom = rowPaneIds[rowIdx - 1];
    const newPaneId = splitPaneFn({
      targetPane: splitFrom,
      direction: "vertical",
      cwd: dir,
      percent: rowSplitPercents[rowIdx - 1]
    });
    rowPaneIds.push(newPaneId);
  }
  const paneMap = [];
  const firstPanesOfRows = new Set(rowPaneIds);
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    const rowPaneId = rowPaneIds[rowIdx];
    const rowPanes = [rowPaneId];
    const paneSizes = computeSizes(panes);
    const paneSplitPercents = toSplitPercents(paneSizes);
    for (let paneIdx = 1; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const targetPane = rowPanes[paneIdx - 1];
      const paneDir = pane.dir ? resolve9(dir, pane.dir) : dir;
      const newPaneId = splitPaneFn({
        targetPane,
        direction: "horizontal",
        cwd: paneDir,
        percent: paneSplitPercents[paneIdx - 1]
      });
      rowPanes.push(newPaneId);
    }
    paneMap.push(rowPanes);
  }
  return { paneMap, firstPanesOfRows };
}
function loadLaunchConfig(dir) {
  let config2;
  try {
    ({ config: config2 } = readConfig(dir));
  } catch (error) {
    if (error?.code === "ENOENT") {
      outputError(
        `No ide.yml found in ${dir}. Run "tmux-ide init" or "tmux-ide detect --write" to create one.`,
        "CONFIG_NOT_FOUND"
      );
    }
    outputError(`Cannot read ide.yml: ${error.message}`, "READ_ERROR");
  }
  const errors = validateConfig(config2);
  if (errors.length > 0) {
    outputError(
      `Invalid ide.yml in ${dir}. Run "tmux-ide validate" for details.`,
      "INVALID_CONFIG"
    );
  }
  return config2;
}
async function bestEffortAdopt(session) {
  try {
    const { adoptSession: adoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
    adoptSession2(session);
  } catch {
  }
}
function runBeforeHook(command2, dir) {
  if (!command2) return;
  console.log(`Running: ${command2}`);
  try {
    execSync(command2, { cwd: dir, stdio: "inherit", timeout: 6e4 });
  } catch {
    outputError(`The before hook failed: ${command2}`, "BEFORE_HOOK_FAILED");
  }
}
async function launch(targetDir, {
  json: json2 = false,
  attach: attach2 = true,
  sessionName
} = {}) {
  const dir = resolve9(targetDir ?? ".");
  const config2 = loadLaunchConfig(dir);
  const { name: fallbackName } = getSessionName(dir);
  const session = sessionName ?? config2.name ?? fallbackName;
  const headless = config2.orchestrator?.widgets === false;
  const rows = headless ? stripWidgetPanes(config2.rows) : config2.rows;
  const theme = config2.theme ?? {};
  const team = config2.team ?? null;
  runBeforeHook(config2.before, dir);
  if (hasSession(session)) {
    const currentHash = configHash(config2);
    const storedHash = getSessionVariable(session, "@config_hash");
    const configChanged = Boolean(storedHash && currentHash !== storedHash);
    if (json2) {
      console.log(JSON.stringify({ session, running: true, configChanged }));
    } else if (configChanged) {
      console.log(`Session "${session}" is running but ide.yml has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
    }
    await bestEffortAdopt(session);
    if (attach2) {
      attachSession(session);
    }
    return;
  }
  const cols = process.stdout.columns ?? 200;
  const lines = process.stdout.rows ?? 50;
  const rootPaneId = createDetachedSession(session, dir, { cols, lines });
  if (team) {
    setSessionEnvironment(session, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1");
  }
  const { paneMap, firstPanesOfRows } = buildPaneMap(
    rows,
    dir,
    rootPaneId,
    ({ targetPane, direction, cwd, percent }) => splitPane(targetPane, direction, cwd, percent)
  );
  const { focusPane, paneActions } = collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir);
  for (const action of paneActions) {
    if (action.title) {
      setPaneTitle(action.targetPane, action.title);
    }
    setPaneOption(action.targetPane, "@ide_role", action.paneRole ?? "shell");
    setPaneOption(action.targetPane, "@ide_name", action.title ?? "");
    setPaneOption(action.targetPane, "@ide_type", action.paneType ?? "shell");
    if (action.paneRole === "lead" || action.paneRole === "teammate") {
      setPaneOption(action.targetPane, "allow-rename", "off");
    }
    if (action.chdir) {
      sendLiteral(action.targetPane, `cd ${shellEscape(action.chdir)}`);
    }
    for (const exportCommand of action.exports) {
      sendLiteral(action.targetPane, exportCommand);
    }
    if (action.widgetType) {
      const widgetCmd = resolveWidgetCommand(action.widgetType, {
        session,
        dir,
        target: action.widgetTarget ?? null,
        theme: config2.theme ?? null
      });
      sendLiteral(action.targetPane, widgetCmd);
    } else if (action.command) {
      sendLiteral(action.targetPane, action.command);
    }
  }
  for (const command2 of buildSessionOptions(session, { theme })) {
    runSessionCommand(command2);
  }
  setSessionVariable(session, "@config_hash", configHash(config2));
  const sidebar = resolveSidebarConfig(config2.sidebar);
  if (sidebar.enabled) {
    try {
      const { openSidebarPane: openSidebarPane2 } = await Promise.resolve().then(() => (init_sidebar(), sidebar_exports));
      openSidebarPane2(session, dir, sidebar.width, config2.theme ?? null);
    } catch {
    }
  }
  selectPane(focusPane);
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(
    `Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`
  );
  try {
    const { readCanonicalDaemonInfo: readCanonicalDaemonInfo2 } = await Promise.resolve().then(() => (init_canonical_daemon(), canonical_daemon_exports));
    const info = readCanonicalDaemonInfo2();
    if (info) {
      console.log(`Command center: http://${info.bindHostname}:${info.port}/`);
    }
  } catch {
  }
  await bestEffortAdopt(session);
  if (attach2) {
    attachSession(session);
  }
}
var init_launch = __esm({
  "packages/daemon/src/launch.ts"() {
    "use strict";
    init_yaml_io();
    init_sizes();
    init_output();
    init_launch_plan();
    init_session_options();
    init_src();
    init_validate();
    init_sidebar();
    init_resolve();
    init_shell();
  }
});

// packages/daemon/src/detect.ts
import { resolve as resolve10, basename as basename4 } from "node:path";
import { readFileSync as readFileSync11, existsSync as existsSync17 } from "node:fs";
function fileExists(dir, name) {
  return existsSync17(resolve10(dir, name));
}
function readJson(dir, name) {
  try {
    return JSON.parse(readFileSync11(resolve10(dir, name), "utf-8"));
  } catch {
    return null;
  }
}
function detectStack(dir) {
  const detected = {
    packageManager: null,
    frameworks: [],
    devCommand: null,
    language: null,
    reasons: []
  };
  if (fileExists(dir, "pnpm-lock.yaml")) {
    detected.packageManager = "pnpm";
    detected.reasons.push('Detected pnpm from "pnpm-lock.yaml".');
  } else if (fileExists(dir, "bun.lockb") || fileExists(dir, "bun.lock")) {
    detected.packageManager = "bun";
    detected.reasons.push('Detected bun from "bun.lockb" or "bun.lock".');
  } else if (fileExists(dir, "yarn.lock")) {
    detected.packageManager = "yarn";
    detected.reasons.push('Detected yarn from "yarn.lock".');
  } else if (fileExists(dir, "package-lock.json")) {
    detected.packageManager = "npm";
    detected.reasons.push('Detected npm from "package-lock.json".');
  }
  const pkg = readJson(dir, "package.json");
  if (pkg) {
    detected.language = "javascript";
    detected.reasons.push('Detected JavaScript from "package.json".');
    const deps2 = {
      ...pkg.dependencies,
      ...pkg.devDependencies
    };
    if (deps2["next"]) pushFramework(detected, "next", 'Found dependency "next".');
    if (deps2["convex"]) pushFramework(detected, "convex", 'Found dependency "convex".');
    if (deps2["vite"]) pushFramework(detected, "vite", 'Found dependency "vite".');
    if (deps2["remix"] || deps2["@remix-run/node"])
      pushFramework(detected, "remix", "Found Remix dependency.");
    if (deps2["nuxt"]) pushFramework(detected, "nuxt", 'Found dependency "nuxt".');
    if (deps2["astro"]) pushFramework(detected, "astro", 'Found dependency "astro".');
    if (deps2["svelte"] || deps2["@sveltejs/kit"])
      pushFramework(detected, "svelte", "Found Svelte dependency.");
    const pm = detected.packageManager ?? "npm";
    const run = pm === "npm" ? "npm run" : pm;
    const scripts = pkg.scripts;
    if (scripts?.dev) {
      detected.devCommand = `${run} dev`;
      detected.reasons.push(
        `Using dev command "${detected.devCommand}" from package.json scripts.`
      );
    } else if (scripts?.start) {
      detected.devCommand = `${run} start`;
      detected.reasons.push(
        `Using start command "${detected.devCommand}" from package.json scripts.`
      );
    }
  }
  if (fileExists(dir, "pyproject.toml") || fileExists(dir, "requirements.txt")) {
    detected.language = detected.language ?? "python";
    detected.reasons.push('Detected Python from "pyproject.toml" or "requirements.txt".');
    try {
      const pyproject = readFileSync11(resolve10(dir, "pyproject.toml"), "utf-8");
      if (pyproject.includes("fastapi"))
        pushFramework(detected, "fastapi", 'Found "fastapi" in pyproject.toml.');
      else if (pyproject.includes("django"))
        pushFramework(detected, "django", 'Found "django" in pyproject.toml.');
      else if (pyproject.includes("flask"))
        pushFramework(detected, "flask", 'Found "flask" in pyproject.toml.');
    } catch {
    }
  }
  if (fileExists(dir, "Cargo.toml")) {
    detected.language = detected.language ?? "rust";
    detected.reasons.push('Detected Rust from "Cargo.toml".');
    pushFramework(detected, "cargo", 'Using Cargo workflow from "Cargo.toml".');
  }
  if (fileExists(dir, "go.mod")) {
    detected.language = detected.language ?? "go";
    detected.reasons.push('Detected Go from "go.mod".');
    pushFramework(detected, "go", 'Using Go workflow from "go.mod".');
  }
  if (fileExists(dir, "docker-compose.yml") || fileExists(dir, "docker-compose.yaml")) {
    pushFramework(
      detected,
      "docker",
      'Detected Docker from "docker-compose.yml" or "docker-compose.yaml".'
    );
  }
  if (detected.reasons.length === 0) {
    detected.reasons.push("No framework-specific signals found; using the generic layout.");
  }
  return detected;
}
function suggestConfig(dir, detected) {
  const name = basename4(dir);
  const pm = detected.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;
  const config2 = {
    name,
    rows: [
      {
        size: "70%",
        panes: [
          { title: "Claude 1", command: "claude" },
          { title: "Claude 2", command: "claude" }
        ]
      },
      {
        panes: []
      }
    ]
  };
  const bottom = config2.rows[1].panes;
  const frameworks = detected.frameworks;
  if (frameworks.length >= 2) {
    config2.rows[0].panes.push({ title: "Claude 3", command: "claude" });
  }
  if (frameworks.includes("next")) {
    bottom.push({ title: "Next.js", command: `${run} dev` });
  } else if (frameworks.includes("vite")) {
    bottom.push({ title: "Vite", command: `${run} dev` });
  } else if (frameworks.includes("nuxt")) {
    bottom.push({ title: "Nuxt", command: `${run} dev` });
  } else if (frameworks.includes("remix")) {
    bottom.push({ title: "Remix", command: `${run} dev` });
  } else if (frameworks.includes("astro")) {
    bottom.push({ title: "Astro", command: `${run} dev` });
  } else if (frameworks.includes("svelte")) {
    bottom.push({ title: "SvelteKit", command: `${run} dev` });
  } else if (frameworks.includes("fastapi")) {
    bottom.push({ title: "FastAPI", command: "uvicorn main:app --reload" });
  } else if (frameworks.includes("django")) {
    bottom.push({ title: "Django", command: "python manage.py runserver" });
  } else if (frameworks.includes("flask")) {
    bottom.push({ title: "Flask", command: "flask run --reload" });
  } else if (frameworks.includes("cargo")) {
    bottom.push({ title: "Cargo", command: "cargo watch -x run" });
  } else if (frameworks.includes("go")) {
    bottom.push({ title: "Go", command: "go run ." });
  } else if (detected.devCommand) {
    bottom.push({ title: "Dev Server", command: detected.devCommand });
  }
  if (frameworks.includes("convex")) {
    bottom.push({ title: "Convex", command: "npx convex dev" });
  }
  bottom.push({ title: "Shell" });
  return config2;
}
async function detect(targetDir, { json: json2, write } = {}) {
  const dir = resolve10(targetDir ?? ".");
  const detected = detectStack(dir);
  const suggested = suggestConfig(dir, detected);
  if (write) {
    writeConfig(dir, suggested);
    if (json2) {
      console.log(JSON.stringify({ detected, suggestedConfig: suggested, written: true }, null, 2));
    } else {
      const desc = detected.frameworks.length > 0 ? detected.frameworks.join(" + ") : detected.language ?? "generic project";
      console.log(`Detected ${desc}. Created ide.yml.`);
      console.log("\nWhy this layout:");
      for (const reason of detected.reasons) {
        console.log(`  - ${reason}`);
      }
    }
    return;
  }
  if (json2) {
    console.log(JSON.stringify({ detected, suggestedConfig: suggested }, null, 2));
    return;
  }
  console.log("Detected stack:");
  if (detected.packageManager) console.log(`  Package manager: ${detected.packageManager}`);
  if (detected.language) console.log(`  Language: ${detected.language}`);
  if (detected.frameworks.length) console.log(`  Frameworks: ${detected.frameworks.join(", ")}`);
  if (detected.devCommand) console.log(`  Dev command: ${detected.devCommand}`);
  console.log("\nReasoning:");
  for (const reason of detected.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log("\nRun with --write to create ide.yml, or --json to see the suggested config.");
}
function pushFramework(detected, framework, reason) {
  if (!detected.frameworks.includes(framework)) {
    detected.frameworks.push(framework);
  }
  detected.reasons.push(reason);
}
var init_detect = __esm({
  "packages/daemon/src/detect.ts"() {
    "use strict";
    init_yaml_io();
  }
});

// packages/daemon/src/lib/skill-sync.ts
var skill_sync_exports = {};
__export(skill_sync_exports, {
  VERSION_MARKER_RE: () => VERSION_MARKER_RE,
  claudeDir: () => claudeDir,
  defaultSkillSource: () => defaultSkillSource,
  installedSkillVersion: () => installedSkillVersion,
  parseSkillVersion: () => parseSkillVersion,
  rewriteVersionMarker: () => rewriteVersionMarker,
  skillTargetDir: () => skillTargetDir,
  skillTargetFile: () => skillTargetFile,
  syncSkill: () => syncSkill,
  versionMarker: () => versionMarker
});
import { existsSync as existsSync19, mkdirSync as mkdirSync12, readFileSync as readFileSync13, writeFileSync as writeFileSync12 } from "node:fs";
import { homedir as homedir13 } from "node:os";
import { dirname as dirname14, join as join14 } from "node:path";
import { fileURLToPath as fileURLToPath6 } from "node:url";
function claudeDir() {
  return process.env.TMUX_IDE_CLAUDE_DIR ?? join14(homedir13(), ".claude");
}
function skillTargetDir() {
  return join14(claudeDir(), "skills", "tmux-ide");
}
function skillTargetFile() {
  return join14(skillTargetDir(), "SKILL.md");
}
function defaultSkillSource() {
  const here = dirname14(fileURLToPath6(import.meta.url));
  const candidates = [
    join14(here, "../skill/SKILL.md"),
    // bundled bin/cli.js → repo root
    join14(here, "../../../../skill/SKILL.md")
    // dev src/lib → repo root
  ];
  return candidates.find((c) => existsSync19(c)) ?? candidates[0];
}
function versionMarker(version) {
  return `<!-- tmux-ide-skill-version: ${version} -->`;
}
function parseSkillVersion(content) {
  const match = content.match(VERSION_MARKER_RE);
  return match ? match[1] : null;
}
function rewriteVersionMarker(content, version) {
  if (!VERSION_MARKER_RE.test(content)) return content;
  return content.replace(VERSION_MARKER_RE, versionMarker(version));
}
function installedSkillVersion(dir = skillTargetDir()) {
  const file = join14(dir, "SKILL.md");
  if (!existsSync19(file)) return null;
  try {
    return parseSkillVersion(readFileSync13(file, "utf-8"));
  } catch {
    return null;
  }
}
function syncSkill({
  source = defaultSkillSource(),
  version = getCurrentVersion()
} = {}) {
  const rendered = rewriteVersionMarker(readFileSync13(source, "utf-8"), version);
  const dir = skillTargetDir();
  const target = join14(dir, "SKILL.md");
  const existing = existsSync19(target) ? readFileSync13(target, "utf-8") : null;
  if (existing === rendered) {
    return { action: "unchanged", path: target, to: version };
  }
  mkdirSync12(dir, { recursive: true });
  writeFileSync12(target, rendered, "utf-8");
  if (existing === null) return { action: "installed", path: target, to: version };
  return { action: "updated", path: target, from: parseSkillVersion(existing), to: version };
}
var VERSION_MARKER_RE;
var init_skill_sync = __esm({
  "packages/daemon/src/lib/skill-sync.ts"() {
    "use strict";
    init_update_check();
    VERSION_MARKER_RE = /<!--\s*tmux-ide-skill-version:\s*([^\s]+)\s*-->/;
  }
});

// packages/daemon/src/lib/agent-discovery.ts
var agent_discovery_exports = {};
__export(agent_discovery_exports, {
  KNOWN_AGENTS: () => KNOWN_AGENTS,
  discoverAgents: () => discoverAgents,
  presentAgents: () => presentAgents
});
import { execFileSync as execFileSync7 } from "node:child_process";
function discoverAgents(which = defaultWhich, isInstalled2 = defaultIntegrationProbe) {
  return KNOWN_AGENTS.map((agent) => {
    const path2 = which(agent.bin);
    const present = path2 !== null;
    const installed = present && agent.integration ? isInstalled2(agent.id) : false;
    return { id: agent.id, bin: agent.bin, integration: agent.integration, path: path2, installed };
  });
}
function presentAgents(agents) {
  return agents.filter((a) => a.path !== null);
}
var KNOWN_AGENTS, defaultWhich, defaultIntegrationProbe;
var init_agent_discovery = __esm({
  "packages/daemon/src/lib/agent-discovery.ts"() {
    "use strict";
    init_claude();
    KNOWN_AGENTS = [
      { id: "claude", bin: "claude", integration: true },
      { id: "codex", bin: "codex", integration: false },
      { id: "opencode", bin: "opencode", integration: false },
      { id: "gemini", bin: "gemini", integration: false },
      { id: "aider", bin: "aider", integration: false }
    ];
    defaultWhich = (bin) => {
      try {
        const out = execFileSync7("which", [bin], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        }).trim();
        if (out.length === 0) return null;
        return out.split("\n")[0].trim() || null;
      } catch {
        return null;
      }
    };
    defaultIntegrationProbe = (agentId) => {
      if (agentId !== "claude") return false;
      try {
        return claudeIntegrationStatus().installed;
      } catch {
        return false;
      }
    };
  }
});

// packages/daemon/src/lib/dot-path.ts
function setByPath(obj, path2, value) {
  const keys = path2.split(".");
  const last = keys.pop();
  let i = 0;
  const target = keys.reduce((o, k) => {
    const nextKey = keys[i + 1] ?? last;
    if (o[k] === void 0) o[k] = /^\d+$/.test(nextKey) ? [] : {};
    i++;
    return o[k];
  }, obj);
  target[last] = value;
}
var init_dot_path = __esm({
  "packages/daemon/src/lib/dot-path.ts"() {
    "use strict";
  }
});

// packages/daemon/src/command-center/actions/contract.ts
var init_contract = __esm({
  "packages/daemon/src/command-center/actions/contract.ts"() {
    "use strict";
    init_src2();
  }
});

// packages/daemon/src/lib/session-monitor.ts
import { execFileSync as execFileSync8 } from "node:child_process";
function getListeningPids() {
  try {
    const raw = execFileSync8("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const pids = /* @__PURE__ */ new Set();
    let currentPid = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        const match = line.match(/:(\d+)$/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 1024 && port <= 2e4) pids.add(currentPid);
        }
      }
    }
    return pids;
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function getProcessTree() {
  try {
    const raw = execFileSync8("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const tree = /* @__PURE__ */ new Map();
    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) tree.set(parts[0], parts[1]);
    }
    return tree;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function computePortPanes(panes, { listeners, tree } = {}) {
  const resolvedListeners = listeners ?? getListeningPids();
  const resolvedTree = tree ?? getProcessTree();
  if (resolvedListeners.size === 0) return /* @__PURE__ */ new Set();
  const panePids = new Map(panes.map((p) => [p.pid, p.id]));
  const result = /* @__PURE__ */ new Set();
  for (const listenerPid of resolvedListeners) {
    let pid = listenerPid;
    while (pid && pid !== "0") {
      if (panePids.has(pid)) {
        result.add(panePids.get(pid));
        break;
      }
      pid = resolvedTree.get(pid);
    }
  }
  return result;
}
function computeAgentStates(panes) {
  const states = /* @__PURE__ */ new Map();
  for (const pane of panes) {
    const role = pane.role ?? "";
    if (role === "lead" || role === "teammate") {
      states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
      continue;
    }
    const cmd = (pane.cmd ?? "").toLowerCase();
    if (!cmd.includes("claude") && !cmd.includes("codex")) {
      states.set(pane.id, null);
      continue;
    }
    states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
  }
  return states;
}
var SPINNERS;
var init_session_monitor = __esm({
  "packages/daemon/src/lib/session-monitor.ts"() {
    "use strict";
    SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;
  }
});

// packages/daemon/src/terminal/PtyAdapter.ts
var PtySpawnError;
var init_PtyAdapter = __esm({
  "packages/daemon/src/terminal/PtyAdapter.ts"() {
    "use strict";
    PtySpawnError = class extends Error {
      adapter;
      code;
      constructor(args) {
        super(args.message, args.cause !== void 0 ? { cause: args.cause } : void 0);
        this.name = "PtySpawnError";
        this.adapter = args.adapter;
        this.code = args.code;
      }
    };
  }
});

// packages/daemon/src/terminal/NodePtyAdapter.ts
import { chmodSync as chmodSync3, existsSync as existsSync22, statSync as statSync2 } from "node:fs";
import { dirname as dirname16, join as join15 } from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
function candidateSpawnHelperPaths() {
  const requireForNodePty = createRequire(import.meta.url);
  let pkgJsonPath;
  try {
    pkgJsonPath = requireForNodePty.resolve("node-pty/package.json");
  } catch {
    return [];
  }
  const pkgDir = dirname16(pkgJsonPath);
  return [
    join15(pkgDir, "build", "Release", "spawn-helper"),
    join15(pkgDir, "build", "Debug", "spawn-helper"),
    join15(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
  ];
}
function ensureNodePtySpawnHelperExecutable(options = {}) {
  if (process.platform === "win32") return;
  if (!options.force && !options.explicitPath && helperEnsured) return;
  const candidates = options.explicitPath ? [options.explicitPath] : candidateSpawnHelperPaths();
  for (const candidate of candidates) {
    if (!existsSync22(candidate)) continue;
    try {
      chmodSync3(candidate, 493);
    } catch {
    }
  }
  if (!options.explicitPath) helperEnsured = true;
}
function assertValidCwd(cwd, statFn) {
  let stats;
  try {
    stats = statFn(cwd);
  } catch (err) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd does not exist or cannot be stat'd: ${cwd}`,
      cause: err
    });
  }
  if (!stats.isDirectory()) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd is not a directory: ${cwd}`
    });
  }
}
var ADAPTER_ID, helperEnsured, NodePtyProcess, NodePtyAdapter, defaultNodePtyAdapter;
var init_NodePtyAdapter = __esm({
  "packages/daemon/src/terminal/NodePtyAdapter.ts"() {
    "use strict";
    init_PtyAdapter();
    ADAPTER_ID = "node-pty";
    helperEnsured = false;
    NodePtyProcess = class {
      exited = false;
      child;
      dataListeners = /* @__PURE__ */ new Set();
      exitListeners = /* @__PURE__ */ new Set();
      constructor(child) {
        this.child = child;
        this.child.onData((data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
          for (const listener of this.dataListeners) listener(buf);
        });
        this.child.onExit((evt) => {
          this.exited = true;
          const event = {
            exitCode: evt.exitCode ?? 0,
            signal: typeof evt.signal === "number" ? evt.signal : null
          };
          for (const listener of this.exitListeners) listener(event);
        });
      }
      get pid() {
        return this.child.pid;
      }
      write(data) {
        if (this.exited) return;
        if (typeof data === "string") this.child.write(data);
        else this.child.write(Buffer.from(data).toString("binary"));
      }
      resize(cols, rows) {
        if (this.exited) return;
        if (!Number.isInteger(cols) || cols <= 0)
          throw new RangeError("cols must be a positive integer");
        if (!Number.isInteger(rows) || rows <= 0)
          throw new RangeError("rows must be a positive integer");
        try {
          this.child.resize(cols, rows);
        } catch {
        }
      }
      kill(signal) {
        if (this.exited) return;
        try {
          this.child.kill(typeof signal === "number" ? String(signal) : signal);
        } catch {
          this.exited = true;
          for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
        }
      }
      onData(callback) {
        this.dataListeners.add(callback);
        return () => {
          this.dataListeners.delete(callback);
        };
      }
      onExit(callback) {
        if (this.exited) {
          return () => void 0;
        }
        this.exitListeners.add(callback);
        return () => {
          this.exitListeners.delete(callback);
        };
      }
    };
    NodePtyAdapter = class {
      id = ADAPTER_ID;
      spawnPty;
      statCwd;
      skipHelperEnsure;
      constructor(options = {}) {
        this.spawnPty = options.spawnPty ?? pty.spawn;
        this.statCwd = options.statCwd ?? statSync2;
        this.skipHelperEnsure = options.skipHelperEnsure ?? false;
      }
      async spawn(input) {
        if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
        return this.spawnSyncInternal(input);
      }
      spawnSync(input) {
        if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
        return this.spawnSyncInternal(input);
      }
      spawnSyncInternal(input) {
        assertValidCwd(input.cwd, this.statCwd);
        if (!Number.isInteger(input.cols) || input.cols <= 0) {
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `cols must be a positive integer (got ${input.cols})`
          });
        }
        if (!Number.isInteger(input.rows) || input.rows <= 0) {
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `rows must be a positive integer (got ${input.rows})`
          });
        }
        const env = {};
        for (const [key, value] of Object.entries(input.env)) {
          if (typeof value === "string") env[key] = value;
        }
        let child;
        try {
          child = this.spawnPty(input.shell, [...input.args ?? []], {
            name: input.name ?? "xterm-256color",
            cols: input.cols,
            rows: input.rows,
            cwd: input.cwd,
            env,
            encoding: input.encoding === "utf8" ? "utf8" : null
          });
        } catch (err) {
          const errno = err?.code;
          if (errno === "ENOENT") {
            throw new PtySpawnError({
              adapter: ADAPTER_ID,
              code: "shell_not_found",
              message: `shell not found in PATH: ${input.shell}`,
              cause: err
            });
          }
          if (errno === "EACCES" || errno === "EPERM") {
            throw new PtySpawnError({
              adapter: ADAPTER_ID,
              code: "permission_denied",
              message: `permission denied spawning ${input.shell}`,
              cause: err
            });
          }
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `node-pty spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err
          });
        }
        return new NodePtyProcess(child);
      }
    };
    defaultNodePtyAdapter = new NodePtyAdapter();
  }
});

// packages/daemon/src/server/pty-bridge.ts
import { EventEmitter as EventEmitter2 } from "node:events";
import * as fs from "node:fs";
function assertValidCwd2(cwd, statCwd = fs.statSync) {
  let stats;
  try {
    stats = statCwd(cwd);
  } catch (err) {
    const errno = err?.code;
    if (errno === "ENOENT") {
      throw new TerminalCwdError({ cwd, reason: "notFound", cause: err });
    }
    throw new TerminalCwdError({ cwd, reason: "statFailed", cause: err });
  }
  if (!stats.isDirectory()) {
    throw new TerminalCwdError({ cwd, reason: "notDirectory" });
  }
}
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== void 0) env[key] = value;
  }
  return env;
}
function outputToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data), "utf8");
}
function assertPositiveDimension(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
var DEFAULT_RING_BUFFER_BYTES, TerminalCwdError, PtyBridge;
var init_pty_bridge = __esm({
  "packages/daemon/src/server/pty-bridge.ts"() {
    "use strict";
    init_NodePtyAdapter();
    DEFAULT_RING_BUFFER_BYTES = 256 * 1024;
    TerminalCwdError = class _TerminalCwdError extends Error {
      cwd;
      reason;
      constructor(args) {
        const message = _TerminalCwdError.formatMessage(args.cwd, args.reason);
        super(message, args.cause !== void 0 ? { cause: args.cause } : void 0);
        this.name = "TerminalCwdError";
        this.cwd = args.cwd;
        this.reason = args.reason;
      }
      static formatMessage(cwd, reason) {
        switch (reason) {
          case "notFound":
            return `cwd does not exist: ${cwd}`;
          case "notDirectory":
            return `cwd is not a directory: ${cwd}`;
          case "statFailed":
            return `cwd stat failed: ${cwd}`;
        }
      }
    };
    PtyBridge = class extends EventEmitter2 {
      ptyProcess = null;
      dataDispose = null;
      exitDispose = null;
      exitPoll = null;
      outputTimer = null;
      outputChunks = [];
      pausedOutputChunks = [];
      outputPaused = false;
      replayChunks = [];
      replayBytes = 0;
      lastCwd = null;
      options;
      adapter;
      ringBufferBytes;
      statCwd;
      constructor(options = {}) {
        super();
        this.options = options;
        if (options.ptyAdapter) {
          this.adapter = options.ptyAdapter;
        } else if (options.pty?.spawn) {
          this.adapter = new NodePtyAdapter({
            spawnPty: options.pty.spawn,
            statCwd: options.statCwd,
            skipHelperEnsure: true
          });
        } else {
          this.adapter = defaultNodePtyAdapter;
        }
        this.ringBufferBytes = options.ringBufferBytes ?? readPositiveIntEnv("TMUX_IDE_PTY_RING_BUFFER_BYTES", DEFAULT_RING_BUFFER_BYTES);
        this.statCwd = options.statCwd ?? fs.statSync;
      }
      /**
       * Returns the cwd used by the most recent spawn (or restart). `null`
       * if the bridge has never been spawned. Used by ws-route to detect
       * stale-cwd reuse and trigger a respawn.
       */
      getCwd() {
        return this.lastCwd;
      }
      get pid() {
        return this.ptyProcess?.pid ?? null;
      }
      // `cols`/`rows` aren't on the canonical PtyProcess shape — we mirror the
      // most recent value the bridge handed to the adapter so external readers
      // (status views) can still see the size without rummaging in the child.
      lastCols = null;
      lastRows = null;
      get cols() {
        return this.lastCols;
      }
      get rows() {
        return this.lastRows;
      }
      get running() {
        return this.ptyProcess !== null;
      }
      getReplayBuffer() {
        return Buffer.concat(this.replayChunks, this.replayBytes);
      }
      flushReplayBuffer() {
        this.replayChunks = [];
        this.replayBytes = 0;
      }
      spawn(cols, rows, spawnOptions = {}) {
        if (this.running) {
          throw new Error("PTY already spawned");
        }
        assertPositiveDimension("cols", cols);
        assertPositiveDimension("rows", rows);
        const defaultShell = this.options.shell ?? process.env.SHELL ?? "bash";
        let executable = spawnOptions.cmd?.[0] ?? defaultShell;
        let args = spawnOptions.cmd ? spawnOptions.cmd.slice(1) : this.options.args ?? ["-l"];
        if (executable === "__login_shell__" && args.length > 0) {
          const innerCmd = args.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
          executable = defaultShell;
          args = ["-l", "-c", `exec ${innerCmd}`];
        }
        const cwd = spawnOptions.cwd ?? this.options.cwd ?? process.env.HOME ?? "/";
        assertValidCwd2(cwd, this.statCwd);
        const env = this.options.env ?? cleanEnv();
        const spawnInput = {
          shell: executable,
          args,
          cwd,
          cols,
          rows,
          env,
          name: this.options.name ?? "xterm-256color",
          encoding: null
        };
        let child;
        try {
          child = this.adapter.spawnSync(spawnInput);
        } catch (err) {
          if (err.code === "ENOENT" && executable === "tmux-ide") {
            throw new Error("tmux-ide not found in PATH", { cause: err });
          }
          throw err;
        }
        this.ptyProcess = child;
        this.lastCwd = cwd;
        this.lastCols = cols;
        this.lastRows = rows;
        this.exitDispose = child.onExit(({ exitCode, signal }) => {
          this.emitExit({ code: exitCode, signal: signal ?? null });
        });
        this.dataDispose = child.onData((data) => {
          this.enqueueOutput(outputToBuffer(data));
        });
        this.startExitPoll(child);
      }
      /**
       * Stop the currently-running PTY process synchronously. Drops listeners
       * and clears replay so a follow-up spawn starts from a clean slate.
       * Idempotent — no-op when no process is running.
       *
       * Used by {@link restartWith} to swap out a sticky bridge whose cwd no
       * longer matches the client request.
       */
      stopProcess(signal = "SIGTERM") {
        if (!this.ptyProcess) return;
        const child = this.ptyProcess;
        this.disposeListeners();
        this.ptyProcess = null;
        this.lastCwd = null;
        this.flushReplayBuffer();
        try {
          child.kill(signal);
        } catch {
        }
      }
      /**
       * Stop the running process (if any) and spawn a new one with the
       * supplied options. Preserves bridge identity (id, registry slot) but
       * resets the replay buffer — the prior process is gone, there is no
       * meaningful output to replay. Used when a reconnect requests a new
       * cwd; modeled on t3code's `stopProcess + spawn` pattern.
       */
      restartWith(cols, rows, spawnOptions = {}) {
        this.stopProcess("SIGTERM");
        this.spawn(cols, rows, spawnOptions);
      }
      pause() {
        this.outputPaused = true;
      }
      resume() {
        if (!this.outputPaused) return;
        this.flushCoalescedOutput();
        this.outputPaused = false;
        this.flushPausedOutput();
      }
      write(bytes) {
        if (!this.ptyProcess) {
          throw new Error("PTY is not running");
        }
        this.ptyProcess.write(typeof bytes === "string" ? bytes : Buffer.from(bytes));
      }
      resize(cols, rows) {
        assertPositiveDimension("cols", cols);
        assertPositiveDimension("rows", rows);
        if (!this.ptyProcess) {
          throw new Error("PTY is not running");
        }
        this.ptyProcess.resize(cols, rows);
        this.lastCols = cols;
        this.lastRows = rows;
      }
      kill(signal = "SIGTERM") {
        if (!this.ptyProcess) return;
        try {
          this.ptyProcess.kill(signal);
        } catch {
        }
      }
      dispose() {
        this.disposeListeners();
        this.kill("SIGTERM");
        this.flushReplayBuffer();
      }
      disposeListeners() {
        this.flushAllOutput();
        this.dataDispose?.();
        this.exitDispose?.();
        if (this.exitPoll) {
          clearInterval(this.exitPoll);
          this.exitPoll = null;
        }
        this.dataDispose = null;
        this.exitDispose = null;
      }
      enqueueOutput(bytes) {
        if (bytes.byteLength === 0) return;
        const coalesceMs = this.options.coalesceMs ?? 8;
        if (coalesceMs <= 0) {
          this.deliverOutput(bytes);
          return;
        }
        this.outputChunks.push(bytes);
        if (this.outputTimer) return;
        this.outputTimer = setTimeout(() => {
          this.outputTimer = null;
          this.flushCoalescedOutput();
        }, coalesceMs);
        this.outputTimer.unref?.();
      }
      flushCoalescedOutput() {
        if (this.outputTimer) {
          clearTimeout(this.outputTimer);
          this.outputTimer = null;
        }
        if (this.outputChunks.length === 0) return;
        const chunks = this.outputChunks;
        this.outputChunks = [];
        this.deliverOutput(Buffer.concat(chunks));
      }
      deliverOutput(bytes) {
        this.appendReplay(bytes);
        if (this.outputPaused) {
          this.pausedOutputChunks.push(bytes);
          return;
        }
        this.emit("output", bytes);
      }
      flushPausedOutput() {
        if (this.pausedOutputChunks.length === 0) return;
        const chunks = this.pausedOutputChunks;
        this.pausedOutputChunks = [];
        this.emit("output", Buffer.concat(chunks));
      }
      flushAllOutput() {
        if (this.outputTimer) {
          clearTimeout(this.outputTimer);
          this.outputTimer = null;
        }
        if (this.outputChunks.length > 0) this.appendReplay(Buffer.concat(this.outputChunks));
        const chunks = [...this.pausedOutputChunks, ...this.outputChunks];
        this.pausedOutputChunks = [];
        this.outputChunks = [];
        if (chunks.length > 0) {
          const bytes = Buffer.concat(chunks);
          this.emit("output", bytes);
        }
      }
      appendReplay(bytes) {
        if (this.ringBufferBytes <= 0 || bytes.byteLength === 0) return;
        if (bytes.byteLength >= this.ringBufferBytes) {
          const tail = bytes.subarray(bytes.byteLength - this.ringBufferBytes);
          this.replayChunks = [Buffer.from(tail)];
          this.replayBytes = tail.byteLength;
          return;
        }
        this.replayChunks.push(Buffer.from(bytes));
        this.replayBytes += bytes.byteLength;
        while (this.replayBytes > this.ringBufferBytes && this.replayChunks.length > 0) {
          const first = this.replayChunks[0];
          const overflow = this.replayBytes - this.ringBufferBytes;
          if (first.byteLength <= overflow) {
            this.replayChunks.shift();
            this.replayBytes -= first.byteLength;
          } else {
            this.replayChunks[0] = first.subarray(overflow);
            this.replayBytes -= overflow;
          }
        }
      }
      startExitPoll(child) {
        this.exitPoll = setInterval(() => {
          if (this.ptyProcess !== child) {
            this.disposeListeners();
            return;
          }
          try {
            process.kill(child.pid, 0);
          } catch (err) {
            if (err.code === "ESRCH") {
              this.emitExit({ code: 0, signal: null });
            }
          }
        }, 100);
        this.exitPoll.unref?.();
      }
      emitExit(exit) {
        if (!this.ptyProcess) return;
        this.flushAllOutput();
        this.disposeListeners();
        this.ptyProcess = null;
        this.lastCwd = null;
        this.flushReplayBuffer();
        this.emit("exit", exit);
      }
    };
  }
});

// packages/daemon/src/server/ws-route.ts
function isPositiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0;
}
function rawDataToBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
function rawDataToText(data) {
  return typeof data === "string" ? data : rawDataToBuffer(data).toString("utf8");
}
function isJsonControlFrame(data, isBinary) {
  return !isBinary && rawDataToText(data).startsWith("{");
}
function parseJsonObject(data) {
  const parsed = JSON.parse(rawDataToText(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("control frame must be a JSON object");
  }
  return parsed;
}
function parseInitFrame(data) {
  const frame = parseJsonObject(data);
  if (frame.type !== "init") {
    throw new Error("first frame must be init");
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("init requires positive integer cols and rows");
  }
  if (frame.cwd !== void 0 && typeof frame.cwd !== "string") {
    throw new Error("init cwd must be a string");
  }
  if (frame.cmd !== void 0 && (!Array.isArray(frame.cmd) || frame.cmd.length === 0 || !frame.cmd.every((part) => typeof part === "string"))) {
    throw new Error("init cmd must be a non-empty string array");
  }
  return {
    type: "init",
    cols: frame.cols,
    rows: frame.rows,
    ...frame.cwd !== void 0 ? { cwd: frame.cwd } : {},
    ...frame.cmd !== void 0 ? { cmd: frame.cmd } : {}
  };
}
function parseResizeFrame(data) {
  const frame = parseJsonObject(data);
  if (frame.type !== "resize") {
    throw new Error(`unsupported control frame: ${String(frame.type)}`);
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("resize requires positive integer cols and rows");
  }
  return { type: "resize", cols: frame.cols, rows: frame.rows };
}
function sendError(ws, message, extras) {
  if (ws.readyState !== WS_OPEN) return;
  const frame = { type: "error", message };
  if (extras?.reason !== void 0) frame.reason = extras.reason;
  if (extras?.cwd !== void 0) frame.cwd = extras.cwd;
  ws.send(JSON.stringify(frame));
}
function sendCwdError(ws, err) {
  sendError(ws, err.message, {
    reason: CWD_ERROR_WIRE_REASON[err.reason],
    cwd: err.cwd
  });
}
function closeWs(ws) {
  if (ws.readyState === WS_OPEN) {
    ws.close();
  }
}
function backpressureBytes() {
  const parsed = Number.parseInt(process.env.TMUX_IDE_PTY_BACKPRESSURE_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKPRESSURE_BYTES;
}
function bridgeIdleMs(options) {
  if (options?.idleMs !== void 0) return options.idleMs;
  const parsed = Number.parseInt(process.env.TMUX_IDE_BRIDGE_IDLE_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BRIDGE_IDLE_MS;
}
function shutdownPtyBridges() {
  defaultPtyBridgeRegistry.shutdown();
}
function handlePtyWebSocket(ws, id, options = {}) {
  const socket = ws;
  let bridge = null;
  let initialized = false;
  let ptyExited = false;
  let killTimer = null;
  let drainTimer = null;
  let releaseBridge = null;
  let outputListener = null;
  let exitListener = null;
  const backpressureThreshold = backpressureBytes();
  const resumeThreshold = Math.floor(backpressureThreshold / 2);
  const clearKillTimer = () => {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = null;
  };
  const clearDrainTimer = () => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = null;
  };
  const scheduleDrainCheck = () => {
    if (drainTimer || !bridge) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (!bridge || socket.readyState !== WS_OPEN) return;
      if ((socket.bufferedAmount ?? 0) <= resumeThreshold) {
        bridge.resume();
        return;
      }
      scheduleDrainCheck();
    }, DRAIN_POLL_MS);
    drainTimer.unref?.();
  };
  const maybePauseForBackpressure = () => {
    if (!bridge || (socket.bufferedAmount ?? 0) <= backpressureThreshold) return;
    bridge.pause();
    scheduleDrainCheck();
  };
  const closeWithError = (message) => {
    sendError(socket, message);
    closeWs(socket);
  };
  const closeWithCwdError = (err) => {
    sendCwdError(socket, err);
    closeWs(socket);
  };
  const attachBridgeEvents = (ptyBridge) => {
    outputListener = (bytes) => {
      if (socket.readyState === WS_OPEN) {
        maybePauseForBackpressure();
        socket.send(bytes, { binary: true });
        maybePauseForBackpressure();
      }
    };
    exitListener = (exit) => {
      ptyExited = true;
      clearKillTimer();
      clearDrainTimer();
      if (socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ type: "exit", code: exit.code, signal: exit.signal }));
        socket.close();
      }
    };
    ptyBridge.on("output", outputListener);
    ptyBridge.on("exit", exitListener);
  };
  const detachBridgeEvents = () => {
    if (bridge && outputListener) bridge.off("output", outputListener);
    if (bridge && exitListener) bridge.off("exit", exitListener);
    outputListener = null;
    exitListener = null;
  };
  socket.on("message", (data, isBinary) => {
    if (!initialized) {
      if (!isJsonControlFrame(data, isBinary)) {
        closeWithError("init frame required before input");
        return;
      }
      let init2;
      try {
        init2 = parseInitFrame(data);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
        return;
      }
      const registry = options.registry ?? defaultPtyBridgeRegistry;
      const acquired = registry.acquire(
        id,
        options.createBridge ?? ((bridgeId) => new PtyBridge({ id: bridgeId })),
        {
          idleMs: options.idleMs
        }
      );
      bridge = acquired.bridge;
      releaseBridge = acquired.release;
      attachBridgeEvents(bridge);
      try {
        const spawnOptions = {};
        if (init2.cwd !== void 0) spawnOptions.cwd = init2.cwd;
        if (init2.cmd !== void 0) spawnOptions.cmd = init2.cmd;
        const currentCwd = bridge.getCwd?.() ?? null;
        const cwdChanged = init2.cwd !== void 0 && currentCwd !== null && currentCwd !== init2.cwd;
        if (!acquired.reused) {
          bridge.spawn(init2.cols, init2.rows, spawnOptions);
        } else if (cwdChanged && bridge.restartWith) {
          bridge.restartWith(init2.cols, init2.rows, spawnOptions);
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ type: "replay-end", bytes: 0 }));
          }
        } else {
          try {
            bridge.resize(init2.cols, init2.rows);
          } catch {
          }
          const replay = bridge.getReplayBuffer?.() ?? Buffer.alloc(0);
          if (replay.byteLength > 0 && socket.readyState === WS_OPEN) {
            socket.send(replay, { binary: true });
          }
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ type: "replay-end", bytes: replay.byteLength }));
          }
        }
        initialized = true;
      } catch (err) {
        detachBridgeEvents();
        releaseBridge?.();
        if (err instanceof TerminalCwdError) {
          closeWithCwdError(err);
        } else {
          closeWithError(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    if (isJsonControlFrame(data, isBinary)) {
      try {
        const resize = parseResizeFrame(data);
        bridge?.resize(resize.cols, resize.rows);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    try {
      bridge?.write(rawDataToBuffer(data));
    } catch (err) {
      closeWithError(err instanceof Error ? err.message : String(err));
    }
  });
  socket.on("close", () => {
    clearDrainTimer();
    detachBridgeEvents();
    if (!bridge || ptyExited) return;
    releaseBridge?.();
  });
  socket.on("error", () => {
    closeWs(socket);
  });
  return {
    getBridge: () => bridge
  };
}
var WS_OPEN, DEFAULT_BACKPRESSURE_BYTES, DRAIN_POLL_MS, DEFAULT_BRIDGE_IDLE_MS, CWD_ERROR_WIRE_REASON, PtyBridgeRegistry, defaultPtyBridgeRegistry;
var init_ws_route = __esm({
  "packages/daemon/src/server/ws-route.ts"() {
    "use strict";
    init_pty_bridge();
    WS_OPEN = 1;
    DEFAULT_BACKPRESSURE_BYTES = 1 << 20;
    DRAIN_POLL_MS = 16;
    DEFAULT_BRIDGE_IDLE_MS = 3e5;
    CWD_ERROR_WIRE_REASON = {
      notFound: "cwd-not-found",
      notDirectory: "cwd-not-directory",
      statFailed: "cwd-stat-failed"
    };
    PtyBridgeRegistry = class {
      entries = /* @__PURE__ */ new Map();
      acquire(id, createBridge, options = {}) {
        let entry = this.entries.get(id);
        const reused = !!entry && entry.bridge.running !== false;
        if (!entry || entry.bridge.running === false) {
          entry = { bridge: createBridge(id), clients: 0, idleTimer: null };
          this.entries.set(id, entry);
          entry.bridge.on("exit", () => {
            this.entries.delete(id);
          });
        }
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        entry.clients++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          const current = this.entries.get(id);
          if (!current) return;
          current.clients = Math.max(0, current.clients - 1);
          if (current.clients > 0 || current.bridge.running === false) return;
          const idleMs = bridgeIdleMs(options);
          current.idleTimer = setTimeout(() => {
            const latest = this.entries.get(id);
            if (!latest || latest.clients > 0) return;
            latest.bridge.kill("SIGTERM");
            this.entries.delete(id);
          }, idleMs);
          current.idleTimer.unref?.();
        };
        return { bridge: entry.bridge, reused, release };
      }
      /**
       * Look up a bridge by id without acquiring it. Returns `null` when no
       * bridge is registered for the id. Used by server-side action handlers
       * (terminal.respawn, terminal.stop) that need to operate on an existing
       * bridge — they should not bump the client refcount.
       */
      peek(id) {
        const entry = this.entries.get(id);
        if (!entry) return null;
        if (entry.bridge.running === false) return null;
        return entry.bridge;
      }
      /**
       * Drop the bridge for `id`, killing it synchronously. Used by the
       * terminal.stop action handler to release a sticky bridge whose owner
       * has explicitly asked to terminate it.
       */
      delete(id) {
        const entry = this.entries.get(id);
        if (!entry) return false;
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        try {
          entry.bridge.kill("SIGTERM");
        } catch {
        }
        this.entries.delete(id);
        return true;
      }
      shutdown() {
        for (const entry of this.entries.values()) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          entry.bridge.kill("SIGTERM");
        }
        this.entries.clear();
      }
      size() {
        return this.entries.size;
      }
    };
    defaultPtyBridgeRegistry = new PtyBridgeRegistry();
  }
});

// packages/daemon/src/widgets/lib/pane-comms.ts
import { execFileSync as execFileSync9 } from "node:child_process";
function tmux2(...args) {
  try {
    return _executor2("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? "";
    if (stderr.includes("no server running") || stderr.includes("can't find session")) {
      return "";
    }
    throw error;
  }
}
function listSessionPanes(session) {
  const format = [
    "#{pane_id}",
    "#{pane_index}",
    "#{pane_title}",
    "#{pane_current_command}",
    "#{pane_width}",
    "#{pane_height}",
    "#{pane_active}",
    "#{@ide_role}",
    "#{@ide_name}",
    "#{@ide_type}"
  ].join("	");
  const output = tmux2("list-panes", "-t", session, "-F", format);
  if (!output) return [];
  return output.split("\n").filter(Boolean).map((line) => {
    const [id, index, title, cmd, width, height, active2, role, name, type] = line.split("	");
    return {
      id,
      index: parseInt(index, 10),
      title,
      currentCommand: cmd,
      width: parseInt(width, 10),
      height: parseInt(height, 10),
      active: active2 === "1",
      role: role || null,
      name: name || null,
      type: type || null
    };
  });
}
function getPaneBusyStatus(session, paneId) {
  const panes = listSessionPanes(session);
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return "busy";
  const cmd = pane.currentCommand.toLowerCase();
  if (cmd.startsWith("claude") || cmd.startsWith("codex")) return "agent";
  if (SHELL_COMMANDS.has(cmd)) return "idle";
  return "busy";
}
function sendText(session, paneId, text) {
  tmux2("send-keys", "-t", paneId, "-l", "--", text);
}
function sendLiteralToPane(_session, paneId, text) {
  tmux2("send-keys", "-t", paneId, "-l", "--", text);
}
function sendEnterToPane(_session, paneId) {
  tmux2("send-keys", "-t", paneId, "Enter");
}
function sleepMs2(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sendCommand(session, paneId, command2) {
  const status2 = getPaneBusyStatus(session, paneId);
  try {
    tmux2("send-keys", "-t", paneId, "-l", "--", command2);
  } catch {
    return false;
  }
  if (status2 === "agent") {
    if (command2.length < 200) {
      sleepMs2(150);
    } else {
      sleepMs2(5e3);
      tmux2("send-keys", "-t", paneId, "Enter");
      sleepMs2(2e3);
    }
    tmux2("send-keys", "-t", paneId, "Enter");
    return true;
  }
  tmux2("send-keys", "-t", paneId, "Enter");
  return true;
}
var _executor2, SHELL_COMMANDS;
var init_pane_comms = __esm({
  "packages/daemon/src/widgets/lib/pane-comms.ts"() {
    "use strict";
    _executor2 = (cmd, args, options) => execFileSync9(cmd, args, { encoding: "utf-8", ...options }).toString();
    SHELL_COMMANDS = /* @__PURE__ */ new Set(["zsh", "bash", "sh", "fish"]);
  }
});

// packages/daemon/src/lib/workspace-registry.ts
import { EventEmitter as EventEmitter3 } from "node:events";
import { existsSync as existsSync23, mkdirSync as mkdirSync13, readFileSync as readFileSync14, renameSync as renameSync8, writeFileSync as writeFileSync13 } from "node:fs";
import { homedir as homedir14 } from "node:os";
import { dirname as dirname17, join as join16 } from "node:path";
import { z as z13 } from "zod";
function getDefaultWorkspaceRegistry() {
  if (!_default) _default = new WorkspaceRegistry();
  return _default;
}
function defaultListSessions() {
  const { execFileSync: execFileSync15 } = __require("node:child_process");
  try {
    const raw = execFileSync15("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
var REGISTRY_DIR_ENV3, RegistryFileSchemaZ2, WorkspaceAlreadyExistsError, WorkspaceNotFoundError, WorkspaceRegistry, _default;
var init_workspace_registry = __esm({
  "packages/daemon/src/lib/workspace-registry.ts"() {
    "use strict";
    init_src2();
    REGISTRY_DIR_ENV3 = "TMUX_IDE_REGISTRY_DIR";
    RegistryFileSchemaZ2 = z13.object({
      version: z13.literal(1),
      workspaces: z13.array(WorkspaceSchemaZ)
    });
    WorkspaceAlreadyExistsError = class extends Error {
      code = "ALREADY_EXISTS";
      constructor(name) {
        super(`Workspace "${name}" already exists`);
        this.name = "WorkspaceAlreadyExistsError";
      }
    };
    WorkspaceNotFoundError = class extends Error {
      code = "NOT_FOUND";
      constructor(name) {
        super(`Workspace "${name}" not found`);
        this.name = "WorkspaceNotFoundError";
      }
    };
    WorkspaceRegistry = class {
      dir;
      listSessions;
      emitter = new EventEmitter3();
      workspaces = [];
      loaded = false;
      constructor(options = {}) {
        this.dir = options.dir ?? process.env[REGISTRY_DIR_ENV3] ?? join16(homedir14(), ".tmux-ide");
        this.listSessions = options.listSessions ?? defaultListSessions;
        this.emitter.setMaxListeners(0);
      }
      /**
       * Load workspaces from disk and reconcile against live tmux sessions.
       * Drops entries whose tmux session is gone (silently — they were
       * persisted by a prior daemon invocation that may have crashed).
       *
       * Safe to call repeatedly; subsequent calls re-reconcile.
       */
      async load() {
        const fromDisk = this.readDisk();
        let live;
        try {
          live = new Set(this.listSessions());
        } catch {
          live = new Set(fromDisk.map((w) => w.sessionName));
        }
        const reconciled = fromDisk.filter((w) => live.has(w.sessionName));
        this.workspaces = reconciled;
        this.loaded = true;
        if (reconciled.length !== fromDisk.length) {
          this.writeDisk();
        }
      }
      list() {
        return [...this.workspaces];
      }
      get(name) {
        return this.workspaces.find((w) => w.name === name) ?? null;
      }
      has(name) {
        return this.workspaces.some((w) => w.name === name);
      }
      add(input) {
        if (this.has(input.name)) {
          throw new WorkspaceAlreadyExistsError(input.name);
        }
        const now = (input.now ?? (() => /* @__PURE__ */ new Date()))();
        const workspace = {
          name: input.name,
          sessionName: input.sessionName ?? input.name,
          projectDir: input.projectDir,
          ideConfigPath: input.ideConfigPath ?? null,
          addedAt: now.toISOString()
        };
        this.workspaces = [...this.workspaces, workspace];
        this.writeDisk();
        this.emitter.emit("workspace.added", workspace);
        return workspace;
      }
      remove(name) {
        if (!this.has(name)) {
          throw new WorkspaceNotFoundError(name);
        }
        this.workspaces = this.workspaces.filter((w) => w.name !== name);
        this.writeDisk();
        this.emitter.emit("workspace.removed", name);
      }
      /** Subscribe to workspace.added | workspace.removed events. */
      on(event, handler) {
        this.emitter.on(event, handler);
        return () => this.emitter.off(event, handler);
      }
      // ----------------- io -----------------
      filePath() {
        return join16(this.dir, "workspaces.json");
      }
      readDisk() {
        const path2 = this.filePath();
        if (!existsSync23(path2)) return [];
        let parsed;
        try {
          parsed = JSON.parse(readFileSync14(path2, "utf-8"));
        } catch {
          return [];
        }
        const result = RegistryFileSchemaZ2.safeParse(parsed);
        if (!result.success) return [];
        return result.data.workspaces;
      }
      writeDisk() {
        const path2 = this.filePath();
        mkdirSync13(dirname17(path2), { recursive: true });
        const file = { version: 1, workspaces: this.workspaces };
        const tmp = `${path2}.tmp`;
        writeFileSync13(tmp, JSON.stringify(file, null, 2) + "\n");
        renameSync8(tmp, path2);
      }
      /** @internal Test-only: assert the registry is loaded. */
      _isLoaded() {
        return this.loaded;
      }
    };
    _default = null;
  }
});

// packages/daemon/src/command-center/discovery.ts
import { execFileSync as execFileSync10 } from "node:child_process";
function tmuxSilent(args) {
  try {
    return _tmuxRunner(args);
  } catch {
    return "";
  }
}
function listTmuxSessions() {
  const raw = tmuxSilent(["list-sessions", "-F", "#{session_name}"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}
function getSessionCwd2(session) {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}
function discoverSessions() {
  const sessionNames = listTmuxSessions();
  const results = [];
  const registry = getDefaultWorkspaceRegistry();
  const enforceRegistry = registry._isLoaded();
  for (const name of sessionNames) {
    if (enforceRegistry && !registry.has(name)) continue;
    const dir = getSessionCwd2(name);
    if (!dir) continue;
    let panes = [];
    try {
      panes = listSessionPanes(name);
    } catch {
    }
    results.push({ name, dir, panes });
  }
  return results;
}
function buildOverviews(sessions) {
  return sessions.map((s) => ({ name: s.name, dir: s.dir }));
}
function buildProjectDetail(info) {
  return {
    session: info.name,
    dir: info.dir,
    panes: info.panes
  };
}
var _tmuxRunner;
var init_discovery = __esm({
  "packages/daemon/src/command-center/discovery.ts"() {
    "use strict";
    init_pane_comms();
    init_workspace_registry();
    _tmuxRunner = (args) => execFileSync10("tmux", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  }
});

// packages/daemon/src/command-center/ws-events.ts
function snapshotSessionsHash() {
  try {
    return JSON.stringify(
      discoverSessions().map((s) => s.name).sort()
    );
  } catch {
    return "";
  }
}
function ensureSessionsPoller() {
  if (sessionsPollTimer) return;
  lastSessionsHash = snapshotSessionsHash();
  sessionsPollTimer = setInterval(() => {
    const hash = snapshotSessionsHash();
    if (hash === lastSessionsHash) return;
    lastSessionsHash = hash;
    for (const client of allClients) client.broadcastSessionsChanged();
  }, SESSIONS_POLL_MS);
  sessionsPollTimer.unref?.();
}
function maybeStopSessionsPoller() {
  if (allClients.size > 0 || !sessionsPollTimer) return;
  clearInterval(sessionsPollTimer);
  sessionsPollTimer = null;
}
function ensureProjectRegistryListener() {
  if (projectRegistryListener) return;
  const listener = () => {
    for (const client of allClients) client.broadcastProjectsChanged();
  };
  projectRegistryListener = listener;
  projectRegistryEmitter.on("change", listener);
}
function maybeStopProjectRegistryListener() {
  if (allClients.size > 0 || !projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
}
function broadcastInitOutput(jobId, chunk, done) {
  for (const client of allClients) client.broadcastInitOutput(jobId, chunk, done);
}
function broadcastInitError(jobId, message) {
  for (const client of allClients) client.broadcastInitError(jobId, message);
}
function broadcastActionComplete(name, result) {
  for (const client of allClients) client.broadcastActionComplete(name, result);
}
function broadcastConfigChanged(sessionName) {
  for (const client of allClients) client.broadcastConfigChanged(sessionName);
}
function broadcastTerminalsChanged(sessionName) {
  for (const client of allClients) client.broadcastTerminalsChanged(sessionName);
}
function rawDataToText2(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
function buildSessionSnapshot(sessionName) {
  const session = discoverSessions().find((s) => s.name === sessionName);
  if (!session) return null;
  return { project: buildProjectDetail(session) };
}
function handleWsEventsConnection(socket) {
  const ws = socket;
  const subscriptions = /* @__PURE__ */ new Set();
  let closed = false;
  const send2 = (frame) => {
    if (closed || ws.readyState !== WS_OPEN2) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
    }
  };
  const broadcastSessionsChanged = () => {
    send2({ type: "sessions.changed" });
  };
  const broadcastProjectsChanged = () => {
    send2({ type: "projects.changed" });
  };
  const broadcastInitOutputForClient = (jobId, chunk, done) => {
    const frame = done === void 0 ? { type: "init.output", jobId, chunk } : { type: "init.output", jobId, chunk, done };
    send2(frame);
  };
  const broadcastInitErrorForClient = (jobId, message) => {
    send2({ type: "init.error", jobId, message });
  };
  const broadcastActionCompleteForClient = (name, result) => {
    send2({ type: "action.complete", name, result });
  };
  const broadcastConfigChangedForClient = (sessionName) => {
    send2({ type: "config.changed", sessionName });
  };
  const broadcastTerminalsChangedForClient = (sessionName) => {
    send2({ type: "terminals.changed", sessionName });
  };
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  const unsubWorkspaceAdded = workspaceRegistry.on(
    "workspace.added",
    (workspace) => send2({ type: "workspace.added", workspace })
  );
  const unsubWorkspaceRemoved = workspaceRegistry.on(
    "workspace.removed",
    (name) => send2({ type: "workspace.removed", name })
  );
  const clientHandle = {
    broadcastSessionsChanged,
    broadcastProjectsChanged,
    broadcastInitOutput: broadcastInitOutputForClient,
    broadcastInitError: broadcastInitErrorForClient,
    broadcastActionComplete: broadcastActionCompleteForClient,
    broadcastConfigChanged: broadcastConfigChangedForClient,
    broadcastTerminalsChanged: broadcastTerminalsChangedForClient
  };
  allClients.add(clientHandle);
  ensureSessionsPoller();
  ensureProjectRegistryListener();
  const keepalive = setInterval(() => {
    send2({ type: "pong" });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();
  const subscribe = (sessionName) => {
    if (subscriptions.has(sessionName)) return;
    const session = discoverSessions().find((s) => s.name === sessionName);
    subscriptions.add(sessionName);
    if (session) {
      const data = buildSessionSnapshot(sessionName);
      if (data) {
        send2({ type: "snapshot", sessionName, data });
      }
    }
  };
  const unsubscribe = (sessionName) => {
    subscriptions.delete(sessionName);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    allClients.delete(clientHandle);
    subscriptions.clear();
    unsubWorkspaceAdded();
    unsubWorkspaceRemoved();
    maybeStopSessionsPoller();
    maybeStopProjectRegistryListener();
  };
  ws.on("message", (data) => {
    if (closed) return;
    let parsed = null;
    try {
      const obj = JSON.parse(rawDataToText2(data));
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        parsed = obj;
      }
    } catch {
      return;
    }
    if (!parsed) return;
    if (parsed.type === "subscribe") {
      for (const name of parsed.sessions) subscribe(name);
      return;
    }
    if (parsed.type === "unsubscribe") {
      for (const name of parsed.sessions) unsubscribe(name);
      return;
    }
    if (parsed.type === "ping") {
      send2({ type: "pong" });
      return;
    }
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  try {
    const sessions = discoverSessions();
    send2({ type: "hello", sessions: buildOverviews(sessions) });
  } catch {
    send2({ type: "hello", sessions: [] });
  }
}
var WS_OPEN2, KEEPALIVE_INTERVAL_MS, SESSIONS_POLL_MS, allClients, sessionsPollTimer, lastSessionsHash, projectRegistryListener;
var init_ws_events = __esm({
  "packages/daemon/src/command-center/ws-events.ts"() {
    "use strict";
    init_discovery();
    init_project_registry();
    init_workspace_registry();
    WS_OPEN2 = 1;
    KEEPALIVE_INTERVAL_MS = 25e3;
    SESSIONS_POLL_MS = 2e3;
    allClients = /* @__PURE__ */ new Set();
    sessionsPollTimer = null;
    lastSessionsHash = "";
    projectRegistryListener = null;
  }
});

// packages/daemon/src/lib/auth-token.ts
import { randomBytes } from "node:crypto";
function generateAuthToken() {
  return randomBytes(32).toString("base64url");
}
var init_auth_token = __esm({
  "packages/daemon/src/lib/auth-token.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/app-settings.ts
import { existsSync as existsSync24, mkdirSync as mkdirSync14, readFileSync as readFileSync15, renameSync as renameSync9, writeFileSync as writeFileSync14 } from "node:fs";
import { dirname as dirname18, join as join17 } from "node:path";
import { homedir as homedir15 } from "node:os";
function settingsDir() {
  return process.env.TMUX_IDE_SETTINGS_DIR ?? join17(homedir15(), ".tmux-ide");
}
function appSettingsPath() {
  return join17(settingsDir(), "app-settings.json");
}
function normalizeSettings(value) {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const remote = value.remoteAccess;
  if (!remote || typeof remote !== "object") return structuredClone(DEFAULT_SETTINGS);
  const enabled = remote.enabled === true;
  const rawToken = remote.token;
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;
  return { remoteAccess: { enabled, token } };
}
function readAppSettings() {
  const path2 = appSettingsPath();
  if (!existsSync24(path2)) return structuredClone(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(readFileSync15(path2, "utf-8")));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
function writeAppSettings(next) {
  const path2 = appSettingsPath();
  mkdirSync14(dirname18(path2), { recursive: true });
  const tmp = `${path2}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync14(tmp, `${JSON.stringify(normalizeSettings(next), null, 2)}
`, "utf-8");
  renameSync9(tmp, path2);
}
var DEFAULT_SETTINGS;
var init_app_settings = __esm({
  "packages/daemon/src/lib/app-settings.ts"() {
    "use strict";
    DEFAULT_SETTINGS = {
      remoteAccess: {
        enabled: false,
        token: null
      }
    };
  }
});

// packages/daemon/src/command-center/actions/handlers/app-set-remote-access.ts
import { hostname, networkInterfaces } from "node:os";
function setRemoteAccessRestartBackend(backend2) {
  remoteAccessRestartBackend = backend2;
}
function currentPort(deps2) {
  const envPort = Number(process.env.TMUX_IDE_DAEMON_PORT);
  return deps2.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 6060);
}
function primaryLanHost() {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return hostname();
}
function buildUrl(host, port) {
  return `http://${host}:${port}`;
}
function defaultDeferRestart(restart2) {
  setImmediate(restart2);
}
async function appSetRemoteAccessHandler(input, deps2 = {}) {
  const readSettings2 = deps2.readSettings ?? readAppSettings;
  const writeSettings = deps2.writeSettings ?? writeAppSettings;
  const nextEnabled = input.enabled;
  const current = readSettings2();
  const token = nextEnabled ? current.remoteAccess.token ?? (deps2.generateToken ?? generateAuthToken)() : null;
  const next = {
    ...current,
    remoteAccess: { enabled: nextEnabled, token }
  };
  writeSettings(next);
  const port = currentPort(deps2);
  const request = {
    enabled: nextEnabled,
    bindHostname: nextEnabled ? "0.0.0.0" : "127.0.0.1",
    token,
    port
  };
  const restartDaemon = deps2.restartDaemon ?? remoteAccessRestartBackend;
  if (restartDaemon) {
    (deps2.deferRestart ?? defaultDeferRestart)(() => {
      void Promise.resolve(restartDaemon(request)).catch((err) => {
        console.error(
          `[actions] Failed to restart daemon for remote access: ${err.message ?? String(err)}`
        );
      });
    });
  }
  if (!nextEnabled) {
    return { enabled: false, url: null, token: null, qrPayload: null };
  }
  const host = deps2.host ?? primaryLanHost();
  const url = buildUrl(host, port);
  return {
    enabled: true,
    url,
    token,
    qrPayload: `${url}?token=${encodeURIComponent(token ?? "")}`
  };
}
var remoteAccessRestartBackend;
var init_app_set_remote_access = __esm({
  "packages/daemon/src/command-center/actions/handlers/app-set-remote-access.ts"() {
    "use strict";
    init_auth_token();
    init_app_settings();
    remoteAccessRestartBackend = null;
  }
});

// packages/daemon/src/command-center/actions/errors.ts
function actionErrorFromCwdError(err) {
  return new ActionError({
    code: CWD_REASON_TO_CODE[err.reason],
    message: err.message,
    details: { cwd: err.cwd, reason: err.reason },
    cause: err
  });
}
function wrapInternalError(err) {
  if (err instanceof ActionError) return err;
  if (err instanceof TerminalCwdError) return actionErrorFromCwdError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new ActionError({ code: "internal", message, cause: err });
}
var ActionError, CWD_REASON_TO_CODE;
var init_errors3 = __esm({
  "packages/daemon/src/command-center/actions/errors.ts"() {
    "use strict";
    init_pty_bridge();
    ActionError = class extends Error {
      code;
      details;
      constructor(args) {
        super(
          args.message,
          args.cause !== void 0 ? { cause: args.cause } : void 0
        );
        this.name = "ActionError";
        this.code = args.code;
        this.details = args.details;
      }
      toEnvelope() {
        return this.details !== void 0 ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
      }
    };
    CWD_REASON_TO_CODE = {
      notFound: "cwd_not_found",
      notDirectory: "cwd_not_directory",
      statFailed: "cwd_stat_failed"
    };
  }
});

// packages/daemon/src/command-center/actions/handlers/daemon-shutdown.ts
function setDaemonShutdownBackend(backend2) {
  shutdownBackend = backend2;
  if (!backend2) shutdownInProgress = false;
}
function daemonShutdownHandler(input, deps2 = {}) {
  if (shutdownInProgress) {
    throw new ActionError({
      code: "shutdown_already_in_progress",
      message: "Daemon shutdown is already in progress"
    });
  }
  shutdownInProgress = true;
  const shutdown = deps2.shutdown ?? shutdownBackend;
  process.nextTick(() => {
    void Promise.resolve(shutdown?.(input.reason ?? null)).catch((err) => {
      console.error("[daemon] shutdown action failed:", err);
    });
  });
  return { stopping: true };
}
var shutdownBackend, shutdownInProgress;
var init_daemon_shutdown = __esm({
  "packages/daemon/src/command-center/actions/handlers/daemon-shutdown.ts"() {
    "use strict";
    init_errors3();
    shutdownBackend = null;
    shutdownInProgress = false;
  }
});

// packages/daemon/src/lib/active-projects.ts
function setActivationBackend(next) {
  backend = next;
  active.clear();
}
async function activateProject(name, options = {}) {
  if (active.has(name) && !options.orchestrate) return;
  if (!backend) {
    throw new Error("No active-project backend is registered");
  }
  await backend.activateProject(name, options);
  active.add(name);
}
var backend, active;
var init_active_projects = __esm({
  "packages/daemon/src/lib/active-projects.ts"() {
    "use strict";
    backend = null;
    active = /* @__PURE__ */ new Set();
  }
});

// packages/daemon/src/send.ts
import { randomUUID } from "node:crypto";
import { resolve as resolve17, join as join18 } from "node:path";
import { existsSync as existsSync25, mkdirSync as mkdirSync15, writeFileSync as writeFileSync15 } from "node:fs";
function writeDispatchFile(dir, paneId, message) {
  if (message.length <= LONG_MESSAGE_THRESHOLD) return null;
  const dispatchDir = join18(dir, ".tasks", "dispatch");
  if (!existsSync25(dispatchDir)) mkdirSync15(dispatchDir, { recursive: true });
  const paneSlug = paneId.replace("%", "");
  const filename = `send-${paneSlug}-${Date.now()}-${randomUUID().slice(0, 8)}.md`;
  const filePath = join18(dispatchDir, filename);
  writeFileSync15(filePath, message);
  return { filePath, triggerCmd: `Read and execute: .tasks/dispatch/${filename}` };
}
function resolvePane(panes, target) {
  if (target.startsWith("%")) {
    return panes.find((p) => p.id === target) ?? null;
  }
  const byName = panes.find((p) => p.name === target);
  if (byName) return byName;
  const byTitle = panes.find((p) => p.title === target);
  if (byTitle) return byTitle;
  const lower = target.toLowerCase();
  if (["lead", "teammate", "planner"].includes(lower)) {
    const byRole = panes.find((p) => p.role === lower);
    if (byRole) return byRole;
  }
  const byPattern = panes.find((p) => p.title.toLowerCase().includes(lower));
  if (byPattern) return byPattern;
  return null;
}
function prepareMessage(message, busyStatus) {
  if (busyStatus === "agent") {
    return message.replace(/\n+/g, " ").trim();
  }
  return message;
}
function deliverMessage(opts) {
  const { session, target, noEnter, dir } = opts;
  const state = getSessionState(session);
  if (!state.running) {
    throw new IdeError(`Session "${session}" is not running`, {
      code: "SESSION_NOT_FOUND"
    });
  }
  const panes = listSessionPanes(session);
  const pane = resolvePane(panes, target);
  if (!pane) {
    const available = panes.map((p) => {
      const label = p.name ?? p.title;
      return `  ${p.id}  ${label}${p.role ? ` (${p.role})` : ""}`;
    }).join("\n");
    throw new IdeError(`Pane "${target}" not found.

Available panes:
${available}`, {
      code: "PANE_NOT_FOUND"
    });
  }
  const busyStatus = getPaneBusyStatus(session, pane.id);
  const message = prepareMessage(opts.message, busyStatus);
  let sentViaFile = false;
  if (noEnter) {
    sendText(session, pane.id, message);
  } else {
    const dispatch = dir ? writeDispatchFile(dir, pane.id, message) : null;
    if (dispatch) {
      sendCommand(session, pane.id, dispatch.triggerCmd);
      sentViaFile = true;
    } else {
      sendCommand(session, pane.id, message);
    }
  }
  return {
    ok: true,
    session,
    target: {
      paneId: pane.id,
      name: pane.name,
      title: pane.title,
      role: pane.role
    },
    message,
    busyStatus,
    sentViaFile,
    ...busyStatus === "agent" ? { warning: "agent_busy" } : {}
  };
}
async function send(targetDir, opts) {
  const dir = resolve17(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const { json: json2, to: target, message: rawMessage, noEnter } = opts;
  if (!target) {
    throw new IdeError("Missing target. Usage: tmux-ide send <target> <message>", {
      code: "USAGE"
    });
  }
  if (!rawMessage) {
    throw new IdeError("Missing message. Usage: tmux-ide send <target> <message>", {
      code: "USAGE"
    });
  }
  const result = deliverMessage({ session, target, message: rawMessage, noEnter, dir });
  const { message, busyStatus } = result;
  const pane = result.target;
  if (json2) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = pane.name ?? pane.title;
  const preview = message.length > 60 ? message.slice(0, 60) + "..." : message;
  console.log(`Sent to "${label}" (${pane.paneId}): ${preview}`);
  if (busyStatus === "agent") {
    console.log("Warning: agent appears busy. Message sent anyway.");
  }
}
var LONG_MESSAGE_THRESHOLD;
var init_send = __esm({
  "packages/daemon/src/send.ts"() {
    "use strict";
    init_yaml_io();
    init_src();
    init_pane_comms();
    init_errors2();
    LONG_MESSAGE_THRESHOLD = 150;
  }
});

// packages/daemon/src/lib/log.ts
function getLogBuffer() {
  return logBuffer.slice();
}
function subscribeLogs(handler) {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
function writeStructuredLog(level, component, message, data) {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    msg: message,
    ...data ? { data } : {}
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch (err) {
      process.stderr.write(
        `[log.ts] subscriber threw: ${err instanceof Error ? err.message : String(err)}
`
      );
    }
  }
  const wire = {
    ts: entry.ts,
    level: entry.level,
    component: entry.component,
    msg: entry.msg
  };
  if (data) Object.assign(wire, data);
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(wire) + "\n");
}
var LEVEL_RANK, minLevel, LOG_BUFFER_SIZE, logBuffer, subscribers, logger;
var init_log = __esm({
  "packages/daemon/src/lib/log.ts"() {
    "use strict";
    LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
    minLevel = process.env.LOG_LEVEL ?? "info";
    LOG_BUFFER_SIZE = 1e3;
    logBuffer = [];
    subscribers = /* @__PURE__ */ new Set();
    logger = {
      debug: (component, msg, data) => writeStructuredLog("debug", component, msg, data),
      info: (component, msg, data) => writeStructuredLog("info", component, msg, data),
      warn: (component, msg, data) => writeStructuredLog("warn", component, msg, data),
      error: (component, msg, data) => writeStructuredLog("error", component, msg, data)
    };
  }
});

// packages/daemon/src/command-center/schemas.ts
import { z as z14 } from "zod";
var updateTaskSchema, createTaskSchema, savePlanSchema, savePlanContentSchema, sendCommandSchema, createMilestoneSchema, updateMilestoneSchema, updateAssertionSchema, triggerResearchSchema, launchSchema, stopSchema, skillNameRegex, createSkillSchema, updateSkillSchema;
var init_schemas = __esm({
  "packages/daemon/src/command-center/schemas.ts"() {
    "use strict";
    updateTaskSchema = z14.object({
      status: z14.enum(["todo", "in-progress", "review", "done"]).optional(),
      assignee: z14.string().optional(),
      title: z14.string().optional(),
      description: z14.string().optional(),
      priority: z14.number().optional()
    });
    createTaskSchema = z14.object({
      title: z14.string().trim().min(1, "Title is required"),
      description: z14.string().optional(),
      priority: z14.number().optional(),
      goal: z14.string().optional(),
      tags: z14.array(z14.string()).optional()
    });
    savePlanSchema = z14.object({
      content: z14.string().max(1e6, "Plan content is too large")
    });
    savePlanContentSchema = z14.object({
      content: z14.string().max(1e6, "Plan content is too large")
    });
    sendCommandSchema = z14.object({
      target: z14.string().min(1, "Target pane is required"),
      message: z14.string().min(1, "Message is required"),
      noEnter: z14.boolean().optional()
    });
    createMilestoneSchema = z14.object({
      title: z14.string().trim().min(1, "Title is required"),
      sequence: z14.number().int().positive(),
      description: z14.string().optional()
    });
    updateMilestoneSchema = z14.object({
      status: z14.enum(["locked", "active", "done", "validating"]).optional(),
      title: z14.string().optional(),
      description: z14.string().optional()
    });
    updateAssertionSchema = z14.object({
      status: z14.enum(["pending", "passing", "failing", "blocked"]),
      evidence: z14.string().optional(),
      verifiedBy: z14.string().optional()
    });
    triggerResearchSchema = z14.object({
      type: z14.string().trim().min(1, "Research type is required")
    });
    launchSchema = z14.object({
      attach: z14.boolean().optional()
    }).optional();
    stopSchema = z14.object({}).optional();
    skillNameRegex = /^[A-Za-z0-9._ -]+$/;
    createSkillSchema = z14.object({
      name: z14.string().trim().min(1, "Skill name is required").regex(
        skillNameRegex,
        "Skill name may only contain letters, digits, dot, dash, underscore, or space"
      ),
      role: z14.string().trim().optional(),
      description: z14.string().optional(),
      specialties: z14.array(z14.string()).optional(),
      body: z14.string().optional()
    });
    updateSkillSchema = z14.object({
      role: z14.string().trim().optional(),
      description: z14.string().optional(),
      specialties: z14.array(z14.string()).optional(),
      body: z14.string().optional()
    });
  }
});

// packages/daemon/src/lib/terminals-store.ts
import { existsSync as existsSync26, mkdirSync as mkdirSync16, readFileSync as readFileSync16, renameSync as renameSync10, writeFileSync as writeFileSync16 } from "node:fs";
import { dirname as dirname19, join as join19 } from "node:path";
function path(dir) {
  return join19(dir, TERMINALS_FILE);
}
function ensureDir(dir) {
  mkdirSync16(dirname19(path(dir)), { recursive: true });
}
function loadTerminals(dir) {
  const file = path(dir);
  if (!existsSync26(file)) return [];
  try {
    const body = readFileSync16(file, "utf-8");
    const parsed = JSON.parse(body);
    if (!parsed.terminals || !Array.isArray(parsed.terminals)) return [];
    return parsed.terminals.filter((t) => isTerminal(t)).map((t) => ({ ...t }));
  } catch {
    return [];
  }
}
function isTerminal(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return typeof v.id === "string" && SAFE_ID.test(v.id) && typeof v.projectId === "string" && typeof v.scopeId === "string" && typeof v.name === "string" && (v.kind === "shell" || v.kind === "setup" || v.kind === "run" || v.kind === "teardown") && typeof v.createdAt === "string" && typeof v.updatedAt === "string";
}
function writeAtomic(dir, terminals) {
  ensureDir(dir);
  const file = path(dir);
  const tmp = `${file}.tmp`;
  writeFileSync16(tmp, JSON.stringify({ terminals }, null, 2) + "\n");
  renameSync10(tmp, file);
}
function upsertTerminal(dir, input) {
  if (!SAFE_ID.test(input.id)) {
    throw new Error(`invalid terminal id "${input.id}"`);
  }
  const existing = loadTerminals(dir);
  const idx = existing.findIndex((t) => t.id === input.id);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const next = {
    id: input.id,
    projectId: input.projectId,
    scopeId: input.scopeId,
    name: input.name,
    kind: input.kind,
    createdAt: existing[idx]?.createdAt ?? now,
    updatedAt: now,
    ...input.scripted ? { scripted: true } : {}
  };
  if (idx === -1) existing.push(next);
  else existing[idx] = next;
  writeAtomic(dir, existing);
  return next;
}
function renameTerminal(dir, id, name) {
  const all = loadTerminals(dir);
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  const next = {
    ...all[idx],
    name: trimmed,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  all[idx] = next;
  writeAtomic(dir, all);
  return next;
}
function deleteTerminal(dir, id) {
  const all = loadTerminals(dir);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAtomic(dir, next);
  return true;
}
var TERMINALS_FILE, SAFE_ID;
var init_terminals_store = __esm({
  "packages/daemon/src/lib/terminals-store.ts"() {
    "use strict";
    TERMINALS_FILE = ".tmux-ide/terminals.json";
    SAFE_ID = /^[A-Za-z0-9_-]+$/u;
  }
});

// packages/daemon/src/lib/auth/auth-service.ts
var auth_service_exports = {};
__export(auth_service_exports, {
  AuthService: () => AuthService
});
import * as crypto2 from "node:crypto";
import { readFileSync as readFileSync17, existsSync as existsSync27 } from "node:fs";
import { join as join20 } from "node:path";
import { homedir as homedir16 } from "node:os";
function base64url(buf) {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64url");
}
function decodeBase64url(str) {
  return Buffer.from(str, "base64url");
}
function signJwt(payload, secret, expiresInSec) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1e3);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(body))];
  const sigInput = segments.join(".");
  const sig = crypto2.createHmac("sha256", secret).update(sigInput).digest();
  segments.push(base64url(sig));
  return segments.join(".");
}
function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false };
  const sigInput = parts[0] + "." + parts[1];
  const expected = crypto2.createHmac("sha256", secret).update(sigInput).digest();
  const actual = decodeBase64url(parts[2]);
  if (expected.length !== actual.length || !crypto2.timingSafeEqual(expected, actual)) {
    return { valid: false };
  }
  try {
    const payload = JSON.parse(decodeBase64url(parts[1]).toString());
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1e3)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}
var TOKEN_EXPIRY_SEC, CHALLENGE_TIMEOUT_MS, AuthService;
var init_auth_service = __esm({
  "packages/daemon/src/lib/auth/auth-service.ts"() {
    "use strict";
    init_log();
    TOKEN_EXPIRY_SEC = 24 * 60 * 60;
    CHALLENGE_TIMEOUT_MS = 5 * 60 * 1e3;
    AuthService = class {
      challenges = /* @__PURE__ */ new Map();
      jwtSecret;
      cleanupTimer;
      constructor(secret) {
        this.jwtSecret = secret ?? process.env.JWT_SECRET ?? crypto2.randomBytes(64).toString("hex");
        this.cleanupTimer = setInterval(() => this.cleanupExpiredChallenges(), 6e4);
      }
      dispose() {
        clearInterval(this.cleanupTimer);
      }
      cleanupExpiredChallenges() {
        const now = Date.now();
        for (const [id, ch] of this.challenges) {
          if (now - ch.timestamp > CHALLENGE_TIMEOUT_MS) {
            this.challenges.delete(id);
          }
        }
      }
      // ---- JWT ----------------------------------------------------------------
      generateToken(userId) {
        return signJwt({ userId }, this.jwtSecret, TOKEN_EXPIRY_SEC);
      }
      verifyToken(token) {
        const result = verifyJwt(token, this.jwtSecret);
        if (!result.valid) return { valid: false };
        return { valid: true, userId: result.payload.userId };
      }
      // ---- SSH challenge-response --------------------------------------------
      createChallenge(userId) {
        const challengeId = crypto2.randomUUID();
        const challenge = crypto2.randomBytes(32);
        this.challenges.set(challengeId, {
          challengeId,
          challenge,
          timestamp: Date.now(),
          userId
        });
        return { challengeId, challenge: challenge.toString("base64") };
      }
      async authenticateWithSSHKey(auth) {
        const challenge = this.challenges.get(auth.challengeId);
        if (!challenge) {
          return { success: false, error: "Invalid or expired challenge" };
        }
        const sigBuf = Buffer.from(auth.signature, "base64");
        if (!this.verifySSHSignature(challenge.challenge, sigBuf, auth.publicKey)) {
          return { success: false, error: "Invalid SSH key signature" };
        }
        const authorized = this.checkSSHKeyAuthorization(challenge.userId, auth.publicKey);
        if (!authorized) {
          return { success: false, error: "SSH key not authorized for this user" };
        }
        this.challenges.delete(auth.challengeId);
        const token = this.generateToken(challenge.userId);
        return { success: true, userId: challenge.userId, token };
      }
      // ---- SSH helpers -------------------------------------------------------
      verifySSHSignature(challenge, signature, publicKeyStr) {
        try {
          const parts = publicKeyStr.trim().split(" ");
          if (parts.length < 2) return false;
          const keyType = parts[0];
          const keyData = parts[1];
          if (keyType !== "ssh-ed25519") {
            logger.warn("auth", `Unsupported key type: ${keyType}`);
            return false;
          }
          if (signature.length !== 64) return false;
          const sshBuf = Buffer.from(keyData, "base64");
          let offset = 0;
          const algLen = sshBuf.readUInt32BE(offset);
          offset += 4 + algLen;
          const keyLen = sshBuf.readUInt32BE(offset);
          offset += 4;
          if (keyLen !== 32) return false;
          const rawPub = sshBuf.subarray(offset, offset + 32);
          const pubKey = crypto2.createPublicKey({
            key: Buffer.concat([
              Buffer.from([48, 42]),
              Buffer.from([48, 5]),
              Buffer.from([6, 3, 43, 101, 112]),
              Buffer.from([3, 33, 0]),
              rawPub
            ]),
            format: "der",
            type: "spki"
          });
          return crypto2.verify(null, challenge, pubKey, signature);
        } catch (err) {
          logger.error("auth", "SSH signature verification failed", {
            error: String(err)
          });
          return false;
        }
      }
      checkSSHKeyAuthorization(userId, publicKey) {
        try {
          const home = userId === process.env.USER ? homedir16() : `/home/${userId}`;
          const authKeysPath = join20(home, ".ssh", "authorized_keys");
          if (!existsSync27(authKeysPath)) return false;
          const authorizedKeys = readFileSync17(authKeysPath, "utf-8");
          const parts = publicKey.trim().split(" ");
          const keyData = parts.length > 1 ? parts[1] : parts[0];
          return authorizedKeys.includes(keyData);
        } catch {
          return false;
        }
      }
      getCurrentUser() {
        return process.env.USER ?? process.env.USERNAME ?? "unknown";
      }
    };
  }
});

// packages/daemon/src/lib/auth/middleware.ts
function authMiddleware(authService, config2) {
  return async (c, next) => {
    if (config2.method === "none") {
      return next();
    }
    const path2 = new URL(c.req.url).pathname;
    if (path2 === "/health" || path2.startsWith("/api/auth/")) {
      return next();
    }
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = authHeader.slice(7);
    const result = authService.verifyToken(token);
    if (!result.valid) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    c.set("userId", result.userId);
    return next();
  };
}
var init_middleware = __esm({
  "packages/daemon/src/lib/auth/middleware.ts"() {
    "use strict";
  }
});

// packages/daemon/src/command-center/actions/handlers/_resolve-project.ts
function resolveProject(name, deps2 = {}) {
  const lookup = deps2.getProject ?? getProject;
  const project = lookup(name);
  if (project) {
    return {
      name: project.name,
      dir: project.dir,
      sessionName: project.name,
      fromLiveSession: false
    };
  }
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (hasSession2(name)) {
    const cwd = (deps2.getSessionCwd ?? getSessionCwd)(name);
    if (cwd) {
      return { name, dir: cwd, sessionName: name, fromLiveSession: true };
    }
  }
  throw new ActionError({
    code: "project_not_found",
    message: `Project "${name}" not found in registry or as a live tmux session`,
    details: { name }
  });
}
var init_resolve_project = __esm({
  "packages/daemon/src/command-center/actions/handlers/_resolve-project.ts"() {
    "use strict";
    init_project_registry();
    init_src();
    init_errors3();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-open-terminal.ts
function defaultTerminalTabId(sessionName) {
  return `${TERMINAL_TAB_ID_PREFIX}:${sessionName}:${TERMINAL_TAB_ID_SUFFIX}`;
}
async function projectOpenTerminalHandler(input, deps2 = {}) {
  const project = resolveProject(input.name, deps2);
  const activateProject2 = deps2.activateProject ?? activateProject;
  await activateProject2(project.name);
  try {
    assertValidCwd2(project.dir, deps2.statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }
  const hasSession2 = deps2.hasSession ?? hasSession;
  const launch2 = deps2.launch ?? launch;
  let launched = false;
  if (!hasSession2(project.sessionName)) {
    try {
      await launch2(project.dir, { json: false, attach: false });
      launched = true;
    } catch (err) {
      throw new ActionError({
        code: "launch_failed",
        message: `Failed to launch session "${project.sessionName}": ${err.message ?? String(err)}`,
        details: { sessionName: project.sessionName, dir: project.dir },
        cause: err
      });
    }
  }
  return {
    sessionName: project.sessionName,
    cwd: project.dir,
    terminalTabId: defaultTerminalTabId(project.sessionName),
    launched
  };
}
var TERMINAL_TAB_ID_PREFIX, TERMINAL_TAB_ID_SUFFIX;
var init_project_open_terminal = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-open-terminal.ts"() {
    "use strict";
    init_src();
    init_launch();
    init_active_projects();
    init_pty_bridge();
    init_errors3();
    init_resolve_project();
    TERMINAL_TAB_ID_PREFIX = "terminal";
    TERMINAL_TAB_ID_SUFFIX = "default";
  }
});

// packages/daemon/src/command-center/actions/handlers/project-activate.ts
async function projectActivateHandler(input, deps2 = {}) {
  const project = resolveProject(input.name, deps2);
  const activateProject2 = deps2.activateProject ?? activateProject;
  try {
    await activateProject2(project.name);
  } catch (err) {
    throw new ActionError({
      code: "internal",
      message: `Failed to activate project "${project.name}": ${err.message ?? String(err)}`,
      details: { projectName: project.name },
      cause: err
    });
  }
  return { active: true, projectName: project.name };
}
var init_project_activate = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-activate.ts"() {
    "use strict";
    init_active_projects();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-launch.ts
function ensureWorkspaceRegistered(name, sessionName, dir) {
  const reg = getDefaultWorkspaceRegistry();
  if (reg.has(name)) return;
  try {
    reg.add({ name, sessionName, projectDir: dir });
  } catch {
  }
}
async function projectLaunchHandler(input, deps2 = {}) {
  const project = resolveProject(input.name, deps2);
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (hasSession2(project.sessionName)) {
    ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
    return { sessionName: project.sessionName, started: false };
  }
  const launch2 = deps2.launch ?? launch;
  try {
    await launch2(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to launch session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err
    });
  }
  ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
  return { sessionName: project.sessionName, started: true };
}
var init_project_launch = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-launch.ts"() {
    "use strict";
    init_src();
    init_launch();
    init_errors3();
    init_resolve_project();
    init_workspace_registry();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-stop.ts
function defaultKillOrphanDaemons(_session) {
}
async function projectStopHandler(input, deps2 = {}) {
  const project = resolveProject(input.name, deps2);
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (!hasSession2(project.sessionName)) {
    return { sessionName: project.sessionName, stopped: false };
  }
  const stopSessionMonitor2 = deps2.stopSessionMonitor ?? stopSessionMonitor;
  const killSession2 = deps2.killSession ?? killSession;
  const killOrphanDaemons = deps2.killOrphanDaemons ?? defaultKillOrphanDaemons;
  try {
    stopSessionMonitor2(project.sessionName);
    killOrphanDaemons(project.sessionName);
    const result = killSession2(project.sessionName);
    return { sessionName: project.sessionName, stopped: result.stopped };
  } catch (err) {
    throw new ActionError({
      code: "stop_failed",
      message: `Failed to stop session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName },
      cause: err
    });
  }
}
var init_project_stop = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-stop.ts"() {
    "use strict";
    init_src();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/restart.ts
import { resolve as resolve18 } from "node:path";
async function restart(targetDir, { json: json2, attach: attach2 } = {}) {
  const dir = resolve18(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  stopSessionMonitor(session);
  const result = killSession(session);
  if (result.stopped) {
    console.log(`Stopped session "${session}"`);
  }
  await launch(dir, { json: json2, attach: attach2 });
}
var init_restart = __esm({
  "packages/daemon/src/restart.ts"() {
    "use strict";
    init_yaml_io();
    init_launch();
    init_src();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-restart.ts
async function projectRestartHandler(input, deps2 = {}) {
  const project = resolveProject(input.name, deps2);
  const restart2 = deps2.restart ?? restart;
  try {
    await restart2(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to restart session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err
    });
  }
  return { sessionName: project.sessionName, restarted: true };
}
var init_project_restart = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-restart.ts"() {
    "use strict";
    init_restart();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/command-center/actions/handlers/terminal-respawn.ts
function terminalRespawnHandler(input, deps2 = {}) {
  const registry = deps2.registry ?? defaultPtyBridgeRegistry;
  const bridge = registry.peek(input.terminalId);
  if (!bridge) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No running terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName }
    });
  }
  if (!bridge.restartWith) {
    throw new ActionError({
      code: "internal",
      message: "Bridge does not support restartWith",
      details: { terminalId: input.terminalId }
    });
  }
  const cwd = resolveRespawnCwd(input, bridge, deps2.statCwd);
  const cols = deps2.cols ?? bridge.cols ?? DEFAULT_RESPAWN_COLS;
  const rows = deps2.rows ?? bridge.rows ?? DEFAULT_RESPAWN_ROWS;
  try {
    bridge.restartWith(cols, rows, { cwd });
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw new ActionError({
      code: "internal",
      message: `Failed to respawn terminal "${input.terminalId}": ${err.message ?? String(err)}`,
      details: { terminalId: input.terminalId },
      cause: err
    });
  }
  return { respawned: true, cwd };
}
function resolveRespawnCwd(input, bridge, statCwd) {
  if (input.cwd) {
    try {
      assertValidCwd2(input.cwd, statCwd);
    } catch (err) {
      if (err instanceof TerminalCwdError) {
        throw actionErrorFromCwdError(err);
      }
      throw err;
    }
    return input.cwd;
  }
  const last = bridge.getCwd?.() ?? null;
  if (!last) {
    throw new ActionError({
      code: "internal",
      message: "Cannot respawn terminal without an explicit cwd: bridge has no recorded cwd",
      details: { terminalId: input.terminalId }
    });
  }
  try {
    assertValidCwd2(last, statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }
  return last;
}
var DEFAULT_RESPAWN_COLS, DEFAULT_RESPAWN_ROWS;
var init_terminal_respawn = __esm({
  "packages/daemon/src/command-center/actions/handlers/terminal-respawn.ts"() {
    "use strict";
    init_ws_route();
    init_pty_bridge();
    init_errors3();
    DEFAULT_RESPAWN_COLS = 80;
    DEFAULT_RESPAWN_ROWS = 24;
  }
});

// packages/daemon/src/command-center/actions/handlers/terminal-stop.ts
function terminalStopHandler(input, deps2 = {}) {
  const registry = deps2.registry ?? defaultPtyBridgeRegistry;
  const ok2 = registry.delete(input.terminalId);
  if (!ok2) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName }
    });
  }
  return { stopped: true };
}
var init_terminal_stop = __esm({
  "packages/daemon/src/command-center/actions/handlers/terminal-stop.ts"() {
    "use strict";
    init_ws_route();
    init_errors3();
  }
});

// packages/daemon/src/command-center/actions/handlers/_project-context.ts
import { basename as basename7 } from "node:path";
function resolveProjectContext(input, deps2 = {}) {
  if (input.projectName) {
    const project = resolveProject(input.projectName, deps2);
    return { dir: project.dir, sessionName: project.sessionName };
  }
  const dir = deps2.cwd ?? process.cwd();
  const sessionName = getSessionName(dir).name || basename7(dir);
  return { dir, sessionName };
}
var init_project_context = __esm({
  "packages/daemon/src/command-center/actions/handlers/_project-context.ts"() {
    "use strict";
    init_yaml_io();
    init_resolve_project();
  }
});

// packages/daemon/src/command-center/actions/handlers/config-actions.ts
import { existsSync as existsSync28 } from "node:fs";
import { join as join21 } from "node:path";
function mutateConfigAction(input, deps2, fn) {
  const context = resolveProjectContext(input, deps2);
  if (!existsSync28(join21(context.dir, "ide.yml"))) {
    throw new ActionError({
      code: "ide_yml_missing",
      message: "ide.yml was not found",
      details: { dir: context.dir }
    });
  }
  try {
    const result = fn(context.dir);
    (deps2.broadcastConfigChanged ?? broadcastConfigChanged)(context.sessionName);
    return result;
  } catch (err) {
    const message = err.message ?? String(err);
    throw new ActionError({
      code: message.toLowerCase().includes("path") ? "config_path_invalid" : "config_validation_failed",
      message,
      cause: err
    });
  }
}
function configSetHandler(input, deps2 = {}) {
  const config2 = mutateConfigAction(
    input,
    deps2,
    (dir) => configSetValue(dir, input.path, input.value)
  );
  return { config: config2 };
}
function configAddPaneHandler(input, deps2 = {}) {
  const pane = {
    title: input.title,
    command: input.command,
    type: input.type,
    target: input.target,
    dir: input.dir,
    size: input.size,
    focus: input.focus,
    env: input.env,
    role: input.role,
    task: input.task,
    specialty: input.specialty,
    skill: input.skill
  };
  const config2 = mutateConfigAction(input, deps2, (dir) => configAddPane(dir, input.rowIndex, pane));
  return { config: config2 };
}
function configRemovePaneHandler(input, deps2 = {}) {
  const config2 = mutateConfigAction(
    input,
    deps2,
    (dir) => configRemovePane(dir, input.rowIndex, input.paneIndex)
  ).config;
  return { config: config2 };
}
function configAddRowHandler(input, deps2 = {}) {
  const config2 = mutateConfigAction(input, deps2, (dir) => configAddRow(dir, input.size));
  return { config: config2 };
}
function configEnableTeamHandler(input, deps2 = {}) {
  const config2 = mutateConfigAction(input, deps2, (dir) => configEnableTeam(dir, input.name));
  return { config: config2 };
}
function configDisableTeamHandler(input, deps2 = {}) {
  const config2 = mutateConfigAction(input, deps2, (dir) => configDisableTeam(dir));
  return { config: config2 };
}
var init_config_actions = __esm({
  "packages/daemon/src/command-center/actions/handlers/config-actions.ts"() {
    "use strict";
    init_config();
    init_ws_events();
    init_errors3();
    init_project_context();
  }
});

// packages/daemon/src/command-center/actions/registry.ts
function getLooseActionEntry(name) {
  return actionRegistry[name];
}
var actionRegistry;
var init_registry2 = __esm({
  "packages/daemon/src/command-center/actions/registry.ts"() {
    "use strict";
    init_contract();
    init_project_open_terminal();
    init_project_activate();
    init_project_launch();
    init_project_stop();
    init_project_restart();
    init_terminal_respawn();
    init_terminal_stop();
    init_config_actions();
    init_app_set_remote_access();
    init_daemon_shutdown();
    actionRegistry = {
      "project.openTerminal": {
        inputSchema: ActionContractsZ["project.openTerminal"].input,
        resultSchema: ActionContractsZ["project.openTerminal"].result,
        handler: projectOpenTerminalHandler
      },
      "project.launch": {
        inputSchema: ActionContractsZ["project.launch"].input,
        resultSchema: ActionContractsZ["project.launch"].result,
        handler: projectLaunchHandler
      },
      "project.stop": {
        inputSchema: ActionContractsZ["project.stop"].input,
        resultSchema: ActionContractsZ["project.stop"].result,
        handler: projectStopHandler
      },
      "project.restart": {
        inputSchema: ActionContractsZ["project.restart"].input,
        resultSchema: ActionContractsZ["project.restart"].result,
        handler: projectRestartHandler
      },
      "project.activate": {
        inputSchema: ActionContractsZ["project.activate"].input,
        resultSchema: ActionContractsZ["project.activate"].result,
        handler: projectActivateHandler
      },
      "terminal.respawn": {
        inputSchema: ActionContractsZ["terminal.respawn"].input,
        resultSchema: ActionContractsZ["terminal.respawn"].result,
        handler: terminalRespawnHandler
      },
      "terminal.stop": {
        inputSchema: ActionContractsZ["terminal.stop"].input,
        resultSchema: ActionContractsZ["terminal.stop"].result,
        handler: terminalStopHandler
      },
      "config.set": {
        inputSchema: ActionContractsZ["config.set"].input,
        resultSchema: ActionContractsZ["config.set"].result,
        handler: configSetHandler
      },
      "config.addPane": {
        inputSchema: ActionContractsZ["config.addPane"].input,
        resultSchema: ActionContractsZ["config.addPane"].result,
        handler: configAddPaneHandler
      },
      "config.removePane": {
        inputSchema: ActionContractsZ["config.removePane"].input,
        resultSchema: ActionContractsZ["config.removePane"].result,
        handler: configRemovePaneHandler
      },
      "config.addRow": {
        inputSchema: ActionContractsZ["config.addRow"].input,
        resultSchema: ActionContractsZ["config.addRow"].result,
        handler: configAddRowHandler
      },
      "config.enableTeam": {
        inputSchema: ActionContractsZ["config.enableTeam"].input,
        resultSchema: ActionContractsZ["config.enableTeam"].result,
        handler: configEnableTeamHandler
      },
      "config.disableTeam": {
        inputSchema: ActionContractsZ["config.disableTeam"].input,
        resultSchema: ActionContractsZ["config.disableTeam"].result,
        handler: configDisableTeamHandler
      },
      "app.setRemoteAccess": {
        inputSchema: ActionContractsZ["app.setRemoteAccess"].input,
        resultSchema: ActionContractsZ["app.setRemoteAccess"].result,
        handler: appSetRemoteAccessHandler
      },
      "daemon.shutdown": {
        inputSchema: ActionContractsZ["daemon.shutdown"].input,
        resultSchema: ActionContractsZ["daemon.shutdown"].result,
        handler: daemonShutdownHandler
      }
    };
  }
});

// packages/daemon/src/command-center/actions/dispatcher.ts
function errorEnvelope(err) {
  return { ok: false, error: err.toEnvelope() };
}
function zodErrorEnvelope(err) {
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message: "Input failed schema validation",
      details: { issues: err.issues }
    }
  };
}
function outputZodErrorEnvelope(err) {
  console.error("[actions] handler output failed schema validation", err.issues);
  return {
    ok: false,
    error: {
      code: "internal",
      message: "Handler returned an invalid result",
      details: { issues: err.issues }
    }
  };
}
function createActionDispatcher(deps2 = {}) {
  const broadcast = deps2.broadcast ?? broadcastActionComplete;
  return async function dispatcher(c) {
    const name = c.req.param("name");
    if (!name || !isActionName(name)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Unknown action: ${name}`,
            details: { name }
          }
        },
        404
      );
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Invalid JSON body: ${err.message ?? String(err)}`
          }
        },
        400
      );
    }
    const actionName = name;
    const entry = getLooseActionEntry(actionName);
    const inputParsed = entry.inputSchema.safeParse(body);
    if (!inputParsed.success) {
      return c.json(zodErrorEnvelope(inputParsed.error), 200);
    }
    let result;
    try {
      result = await entry.handler(inputParsed.data);
    } catch (err) {
      const wrapped = wrapInternalError(err);
      return c.json(errorEnvelope(wrapped), 200);
    }
    const outputParsed = entry.resultSchema.safeParse(result);
    if (!outputParsed.success) {
      return c.json(outputZodErrorEnvelope(outputParsed.error), 200);
    }
    try {
      broadcast(actionName, outputParsed.data);
    } catch (err) {
      console.error("[actions] broadcast failed:", err);
    }
    return c.json({ ok: true, result: outputParsed.data }, 200);
  };
}
var init_dispatcher = __esm({
  "packages/daemon/src/command-center/actions/dispatcher.ts"() {
    "use strict";
    init_contract();
    init_errors3();
    init_registry2();
    init_ws_events();
  }
});

// packages/daemon/src/lib/project-init-runner.ts
import { spawn as spawn5 } from "node:child_process";
function lineStreamer(onChunk) {
  let pending = "";
  return {
    push(text) {
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        onChunk(line);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length === 0) return;
      onChunk(pending.replace(/\r$/, ""));
      pending = "";
    }
  };
}
async function runInit(options) {
  const spawnFn = options.spawnFn ?? spawn5;
  const command2 = options.command ?? "tmux-ide";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["init"];
  if (options.template) args.push("--template", options.template);
  const child = spawnFn(command2, args, { cwd: options.cwd });
  const stderrStreamer = lineStreamer(options.onChunk);
  const stdoutStreamer = lineStreamer(options.onChunk);
  let stderrBuffer = "";
  child.stdout.setEncoding?.("utf-8");
  child.stderr.setEncoding?.("utf-8");
  child.stdout.on("data", (data) => {
    stdoutStreamer.push(typeof data === "string" ? data : data.toString("utf-8"));
  });
  child.stderr.on("data", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    stderrBuffer += text;
    stderrStreamer.push(text);
  });
  return new Promise((resolveResult, reject) => {
    let timer = null;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStreamer.flush();
      stderrStreamer.flush();
      fn();
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      settle(() => reject(new ProjectInitTimeoutError(timeoutMs)));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolveResult({ ok: true }));
      } else {
        settle(() => reject(new ProjectInitFailedError(code, stderrBuffer.trim())));
      }
    });
  });
}
var DEFAULT_TIMEOUT_MS, ProjectInitTimeoutError, ProjectInitFailedError;
var init_project_init_runner = __esm({
  "packages/daemon/src/lib/project-init-runner.ts"() {
    "use strict";
    DEFAULT_TIMEOUT_MS = 3e4;
    ProjectInitTimeoutError = class extends Error {
      timeoutMs;
      constructor(timeoutMs) {
        super(`tmux-ide init timed out after ${timeoutMs}ms`);
        this.name = "ProjectInitTimeoutError";
        this.timeoutMs = timeoutMs;
      }
    };
    ProjectInitFailedError = class extends Error {
      exitCode;
      stderr;
      constructor(exitCode, stderr) {
        super(`tmux-ide init exited with code ${exitCode ?? "(killed)"}: ${stderr || "no stderr"}`);
        this.name = "ProjectInitFailedError";
        this.exitCode = exitCode;
        this.stderr = stderr;
      }
    };
  }
});

// packages/daemon/src/schemas/inspect.ts
import { z as z15 } from "zod";
var ProjectInspectDetectedSchemaZ, ProjectInspectSchemaZ, InspectFilesystemRequestSchemaZ, OnboardProjectRequestSchemaZ;
var init_inspect = __esm({
  "packages/daemon/src/schemas/inspect.ts"() {
    "use strict";
    ProjectInspectDetectedSchemaZ = z15.object({
      /** Detected package manager from lockfile, or `null`. */
      packageManager: z15.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
      /** Detected frameworks (e.g. `["next", "convex"]`). Empty array when none. */
      frameworks: z15.array(z15.string()),
      /** Suggested dev command (e.g. `pnpm dev`). `null` if no dev script found. */
      devCommand: z15.string().nullable(),
      /** Suggested test command (e.g. `pnpm test`). `null` if no test script found. */
      testCommand: z15.string().nullable()
    });
    ProjectInspectSchemaZ = z15.object({
      /** Sanitized basename of the directory — safe to use as a tmux session name. */
      name: z15.string(),
      /** Absolute, canonical path to the directory. */
      dir: z15.string(),
      /** Whether `<dir>/ide.yml` exists. */
      hasIdeYml: z15.boolean(),
      /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
      gitOrigin: z15.string().nullable(),
      /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
      gitBranch: z15.string().nullable(),
      /** Detected stack signals (reuses `tmux-ide detect` logic). */
      detected: ProjectInspectDetectedSchemaZ
    });
    InspectFilesystemRequestSchemaZ = z15.object({
      dir: z15.string().min(1)
    });
    OnboardProjectRequestSchemaZ = z15.object({
      dir: z15.string().min(1),
      /** Optional override for the project name — defaults to inspect.name. */
      name: z15.string().min(1).optional(),
      /** 1, 2, or 3 — how many Claude panes to scaffold in the top row. */
      agents: z15.number().int().min(1).max(3),
      /**
       * Optional per-agent pane titles. When provided, length must equal
       * `agents`; the server uses these as `title:` for the Claude panes
       * instead of the canonical `Lead`/`Teammate N`/`Claude N` defaults.
       */
      agentNames: z15.array(z15.string().min(1)).optional(),
      /** Dev server command (e.g. `pnpm dev`). Omit / null to skip the dev pane. */
      devCommand: z15.string().min(1).nullable().optional(),
      /** Test command (e.g. `pnpm test`). Currently informational; stored for later. */
      testCommand: z15.string().min(1).nullable().optional(),
      /** Lint command (e.g. `pnpm lint`). Currently informational; stored for later. */
      lintCommand: z15.string().min(1).nullable().optional()
    });
  }
});

// packages/daemon/src/lib/filesystem-browser.ts
import { realpathSync, readdirSync as readdirSync3, statSync as statSync4 } from "node:fs";
import { homedir as homedir17 } from "node:os";
import { isAbsolute as isAbsolute3, join as join22, resolve as resolve19, sep } from "node:path";
function isUnderRoot(canonical, root) {
  if (canonical === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return canonical.startsWith(prefix);
}
function assertInsideSandbox(canonical, home) {
  if (isUnderRoot(canonical, home)) return;
  for (const root of ALLOWED_PLATFORM_ROOTS) {
    if (isUnderRoot(canonical, root)) return;
  }
  throw new SandboxViolationError(canonical);
}
var ALLOWED_PLATFORM_ROOTS, SandboxViolationError;
var init_filesystem_browser = __esm({
  "packages/daemon/src/lib/filesystem-browser.ts"() {
    "use strict";
    ALLOWED_PLATFORM_ROOTS = ["/Users", "/home", "/Volumes"];
    SandboxViolationError = class extends Error {
      code = "outside-sandbox";
      constructor(path2) {
        super(`Path "${path2}" is outside the allowed sandbox`);
        this.name = "SandboxViolationError";
      }
    };
  }
});

// packages/daemon/src/lib/project-inspect.ts
import { existsSync as existsSync29 } from "node:fs";
import { isAbsolute as isAbsolute4, resolve as resolve20 } from "node:path";
function narrowPackageManager(raw) {
  if (!raw) return null;
  return KNOWN_PACKAGE_MANAGERS.has(raw) ? raw : null;
}
function inferTestCommand(packageManager) {
  if (!packageManager) return null;
  return packageManager === "npm" ? "npm test" : `${packageManager} test`;
}
async function inspectProject(dir, io = {}) {
  const exists = io.exists ?? existsSync29;
  const absoluteDir = isAbsolute4(dir) ? dir : resolve20(dir);
  if (!exists(absoluteDir)) {
    throw new InspectDirNotFoundError(absoluteDir);
  }
  const probe = await probeProject(absoluteDir, io.probeIo);
  const stack = detectStack(absoluteDir);
  const detected = {
    packageManager: narrowPackageManager(stack.packageManager),
    frameworks: stack.frameworks,
    devCommand: stack.devCommand,
    testCommand: inferTestCommand(stack.packageManager)
  };
  return {
    name: probe.name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    detected
  };
}
var InspectDirNotFoundError, KNOWN_PACKAGE_MANAGERS;
var init_project_inspect = __esm({
  "packages/daemon/src/lib/project-inspect.ts"() {
    "use strict";
    init_detect();
    init_project_probe();
    InspectDirNotFoundError = class extends Error {
      code = "DIR_NOT_FOUND";
      constructor(dir) {
        super(`Directory "${dir}" does not exist`);
        this.name = "InspectDirNotFoundError";
      }
    };
    KNOWN_PACKAGE_MANAGERS = /* @__PURE__ */ new Set(["pnpm", "npm", "yarn", "bun"]);
  }
});

// packages/daemon/src/lib/project-onboard.ts
import yaml2 from "js-yaml";
import { existsSync as existsSync30 } from "node:fs";
import { join as join23 } from "node:path";
function composeIdeYmlConfig(input) {
  if (!Number.isInteger(input.agents) || input.agents < 1 || input.agents > 3) {
    throw new OnboardInvalidInputError(
      `agents must be an integer between 1 and 3 (got ${input.agents})`
    );
  }
  const cleanName = input.name.trim();
  if (!cleanName) {
    throw new OnboardInvalidInputError("name must be a non-empty string");
  }
  const agentsCount = input.agents;
  const useTeam = agentsCount > 1;
  const customNames = input.agentNames;
  if (customNames !== void 0) {
    if (customNames.length !== agentsCount) {
      throw new OnboardInvalidInputError(
        `agentNames length (${customNames.length}) must equal agents (${agentsCount})`
      );
    }
    for (const name of customNames) {
      if (typeof name !== "string" || name.trim() === "") {
        throw new OnboardInvalidInputError("agentNames entries must be non-empty strings");
      }
    }
  }
  const topPanes = [];
  for (let i = 0; i < agentsCount; i++) {
    const fallback = useTeam ? i === 0 ? "Lead" : `Teammate ${i}` : `Claude ${i + 1}`;
    const customTitle = customNames?.[i]?.trim();
    const pane = {
      title: customTitle && customTitle.length > 0 ? customTitle : fallback,
      command: "claude"
    };
    if (useTeam) {
      pane.role = i === 0 ? "lead" : "teammate";
    }
    if (i === 0) {
      pane.focus = true;
    }
    topPanes.push(pane);
  }
  const bottomPanes = [];
  const devCommand = input.devCommand?.trim();
  if (devCommand) {
    bottomPanes.push({ title: "Dev", command: devCommand });
  }
  bottomPanes.push({ title: "Shell" });
  const rows = [{ size: "70%", panes: topPanes }, { panes: bottomPanes }];
  const config2 = {
    name: cleanName,
    rows
  };
  if (useTeam) {
    config2.team = { name: cleanName };
  }
  return config2;
}
function assertNoExistingIdeYml(dir, exists = existsSync30) {
  const path2 = join23(dir, "ide.yml");
  if (exists(path2)) {
    throw new OnboardConflictError(path2);
  }
}
var OnboardConflictError, OnboardInvalidInputError;
var init_project_onboard = __esm({
  "packages/daemon/src/lib/project-onboard.ts"() {
    "use strict";
    OnboardConflictError = class extends Error {
      code = "IDE_YML_EXISTS";
      constructor(path2) {
        super(`ide.yml already exists at ${path2}`);
        this.name = "OnboardConflictError";
      }
    };
    OnboardInvalidInputError = class extends Error {
      code = "INVALID_INPUT";
      constructor(message) {
        super(message);
        this.name = "OnboardInvalidInputError";
      }
    };
  }
});

// packages/daemon/src/command-center/server.ts
var server_exports = {};
__export(server_exports, {
  attachWsEvents: () => attachWsEvents,
  createApp: () => createApp,
  getSseMetrics: () => getSseMetrics
});
import { execFile as execFile2 } from "node:child_process";
import { promisify } from "node:util";
import { existsSync as existsSync31, readFileSync as readFileSync18, readdirSync as readdirSync4 } from "node:fs";
import { join as join24, dirname as dirname20, basename as basename8 } from "node:path";
import { fileURLToPath as fileURLToPath8 } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir18 } from "node:os";
import { isAbsolute as isAbsolute5, resolve as pathResolve } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
import { WebSocketServer } from "ws";
function resolvePackageVersion() {
  const candidates = [join24(__dirname5, "../../package.json"), join24(__dirname5, "../package.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync18(candidate, "utf-8"));
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
    }
  }
  return "0.0.0";
}
function bearerToken(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}
function requireAuth(token, localBypassToken) {
  return async (c, next) => {
    if (!token) return next();
    const url = new URL(c.req.url);
    const suppliedToken = bearerToken(c.req.header("Authorization")) ?? url.searchParams.get("token");
    if (suppliedToken === token || localBypassToken && suppliedToken === localBypassToken) {
      return next();
    }
    return c.json({ error: "Remote access token required" }, 401);
  };
}
function remoteAccessAuth(options) {
  const bindHostname = options.remoteAccess?.bindHostname ?? "127.0.0.1";
  return {
    token: bindHostname === "127.0.0.1" ? null : options.remoteAccess?.token ?? null,
    localBypassToken: options.remoteAccess?.localBypassToken ?? null
  };
}
function getSseMetrics() {
  return { ...sseMetrics };
}
function matchLogChannel(channel) {
  switch (channel) {
    case "daemon":
      return () => true;
    case "hq":
      return (entry) => entry.component.startsWith("hq") || entry.component.startsWith("remote");
    case "watchdog":
      return (entry) => entry.component.startsWith("watchdog");
    default:
      return null;
  }
}
function freezePayload(payload) {
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      freezePayload(value);
    }
    Object.freeze(payload);
  }
  return payload;
}
function buildProjectStreamSnapshot(session) {
  return {
    project: buildProjectDetail(session)
  };
}
function sandboxResolveDir(rawDir) {
  const trimmed = rawDir.trim();
  if (!trimmed) return { error: "invalid-path", message: "Path must not be empty", status: 400 };
  if (trimmed.includes("\0")) {
    return { error: "invalid-path", message: "Path contains a null byte", status: 400 };
  }
  const home = process.env.TMUX_IDE_HOME_OVERRIDE && process.env.TMUX_IDE_HOME_OVERRIDE.trim().length > 0 ? process.env.TMUX_IDE_HOME_OVERRIDE : homedir18();
  let candidate = trimmed;
  if (candidate === "~") {
    candidate = home;
  } else if (candidate.startsWith("~/")) {
    candidate = `${home.replace(/\/+$/, "")}/${candidate.slice(2)}`;
  }
  if (!isAbsolute5(candidate)) {
    return { error: "invalid-path", message: "Path must be absolute", status: 400 };
  }
  const resolved2 = pathResolve(candidate);
  let canonical;
  try {
    canonical = realpathSync2(resolved2);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        error: "not-found",
        message: `Path "${resolved2}" does not exist`,
        status: 404
      };
    }
    throw err;
  }
  try {
    assertInsideSandbox(canonical, home);
  } catch (err) {
    if (err instanceof SandboxViolationError) {
      return { error: "outside-sandbox", message: err.message, status: 403 };
    }
    throw err;
  }
  return { canonical };
}
function createApp(options = {}) {
  const authConfig = options.authConfig ?? { method: "none", token_expiry: 86400 };
  const authService = options.authService ?? new AuthService();
  const app = new Hono();
  app.use("/*", cors());
  const remoteAuth = remoteAccessAuth(options);
  app.use("/api/*", requireAuth(remoteAuth.token, remoteAuth.localBypassToken));
  app.use("/*", authMiddleware(authService, authConfig));
  app.onError((err, c) => {
    console.error("[command-center]", err.message);
    return c.json({ error: err.message }, 500);
  });
  app.post("/api/auth/challenge", async (c) => {
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const challenge = authService.createChallenge(userId);
    return c.json(challenge);
  });
  app.post("/api/auth/verify", async (c) => {
    const body = await c.req.json();
    const result = await authService.authenticateWithSSHKey({
      publicKey: body.publicKey,
      signature: body.signature,
      challengeId: body.challengeId
    });
    if (!result.success) {
      return c.json({ error: result.error }, 401);
    }
    return c.json({ token: result.token, userId: result.userId });
  });
  app.post("/api/auth/token", async (c) => {
    if (authConfig.method !== "none") {
      return c.json({ error: "Direct token generation requires auth method 'none'" }, 403);
    }
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const token = authService.generateToken(userId);
    return c.json({ token, userId });
  });
  app.post("/api/v2/action/:name", createActionDispatcher());
  app.get("/api/widget/:name/spawn", async (c) => {
    const { resolveWidgetSpawn: resolveWidgetSpawn2, WIDGET_TYPES: WIDGET_TYPES2 } = await Promise.resolve().then(() => (init_resolve(), resolve_exports));
    const name = c.req.param("name");
    if (!WIDGET_TYPES2.includes(name)) {
      return c.json({ error: `unknown widget: ${name}`, available: WIDGET_TYPES2 }, 404);
    }
    const session = c.req.query("session");
    const dir = c.req.query("dir");
    if (!session || !dir) {
      return c.json({ error: "session and dir query params are required" }, 400);
    }
    const target = c.req.query("target") ?? null;
    const themeRaw = c.req.query("theme");
    let theme = null;
    if (themeRaw) {
      try {
        theme = JSON.parse(themeRaw);
      } catch {
        return c.json({ error: "theme must be valid JSON" }, 400);
      }
    }
    try {
      const spec = resolveWidgetSpawn2(name, {
        session,
        dir,
        target,
        theme
      });
      return c.json(spec);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  const HEALTHZ_BOOTED_AT = Date.now();
  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      version: process.env.npm_package_version ?? "dev",
      uptimeMs: Date.now() - HEALTHZ_BOOTED_AT
    });
  });
  app.get("/api/sessions", (c) => {
    const sessions = discoverSessions();
    const overviews = buildOverviews(sessions);
    return c.json({ sessions: overviews });
  });
  app.get("/api/workspaces", (c) => {
    const registry = getDefaultWorkspaceRegistry();
    return c.json({ workspaces: registry.list() });
  });
  app.get("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    const workspace = registry.get(name);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    return c.json({ workspace });
  });
  app.post("/api/workspaces", zValidator("json", AddWorkspaceRequestSchemaZ), (c) => {
    const body = c.req.valid("json");
    const registry = getDefaultWorkspaceRegistry();
    const name = body.name ?? basename8(body.projectDir);
    if (!name || name.length === 0) {
      return c.json({ error: "Cannot derive workspace name from projectDir" }, 400);
    }
    try {
      const workspace = registry.add({
        name,
        sessionName: body.sessionName,
        projectDir: body.projectDir,
        ideConfigPath: body.ideConfigPath ?? null
      });
      return c.json({ workspace }, 201);
    } catch (err) {
      if (err instanceof WorkspaceAlreadyExistsError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });
  app.delete("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    try {
      registry.remove(name);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.get("/api/project/:name", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const detail = buildProjectDetail(session);
    return c.json({ ...detail });
  });
  app.get("/api/project/:name/panes", (c) => {
    const name = c.req.param("name");
    let panes;
    try {
      panes = listSessionPanes(name);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
    if (panes.length === 0) {
      const sessions = discoverSessions();
      if (!sessions.find((s) => s.name === name)) {
        return c.json({ error: "Session not found" }, 404);
      }
    }
    return c.json({
      panes: panes.map((p) => ({
        id: p.id,
        index: p.index,
        title: p.title,
        currentCommand: p.currentCommand,
        width: p.width,
        height: p.height,
        active: p.active,
        role: p.role,
        name: p.name,
        type: p.type
      }))
    });
  });
  app.get("/api/project/:name/terminals", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const records = loadTerminals(session.dir);
    const terminals = records.map((t) => {
      const bridge = defaultPtyBridgeRegistry.peek(t.id);
      let runtime = { running: false };
      if (bridge) {
        const cols = typeof bridge.cols === "number" ? bridge.cols : void 0;
        const rows = typeof bridge.rows === "number" ? bridge.rows : void 0;
        const replay = typeof bridge.getReplayBuffer === "function" ? bridge.getReplayBuffer().byteLength : void 0;
        runtime = {
          running: bridge.running !== false,
          ...cols !== void 0 ? { cols } : {},
          ...rows !== void 0 ? { rows } : {},
          ...replay !== void 0 ? { replayBytes: replay } : {}
        };
      }
      return { ...t, runtime };
    });
    return c.json({ terminals });
  });
  app.post(
    "/api/project/:name/terminals",
    zValidator("json", terminalCreateRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      let id = body.id;
      let scripted = false;
      const kind = body.kind ?? "shell";
      if (!id && body.script) {
        id = await createScriptTerminalId({
          projectId: name,
          scopeId: body.scopeId,
          kind,
          script: body.script
        });
        scripted = true;
      }
      if (!id) id = randomUUID3();
      try {
        const upsertInput = {
          id,
          projectId: name,
          scopeId: body.scopeId,
          name: body.name,
          kind
        };
        if (scripted) upsertInput.scripted = true;
        const record = upsertTerminal(session.dir, upsertInput);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record });
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
    }
  );
  app.post(
    "/api/project/:name/terminals/:id/rename",
    zValidator("json", terminalRenameRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const id = c.req.param("id");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      try {
        const record = renameTerminal(session.dir, id, c.req.valid("json").name);
        if (!record) return c.json({ error: "Terminal not found" }, 404);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record });
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
    }
  );
  app.delete("/api/project/:name/terminals/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const removedRecord = deleteTerminal(session.dir, id);
    const killed = defaultPtyBridgeRegistry.delete(id);
    if (!removedRecord && !killed) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    broadcastTerminalsChanged(name);
    return c.json({ ok: true });
  });
  app.get("/api/project/:name/events", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ events: [] });
  });
  app.get("/api/project/:name/stream", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return streamSSE(c, async (stream) => {
      projectStreamConnections += 1;
      sseMetrics.connections = projectStreamConnections;
      let closed = false;
      let previousSnapshotHash = "";
      let lastPing = Date.now();
      function writeSse(event, payload) {
        sseMetrics.messagesSent += 1;
        void stream.writeSSE({ event, data: JSON.stringify(freezePayload(payload)) });
      }
      function writeChanges(currentSession) {
        const snapshot = buildProjectStreamSnapshot(currentSession);
        const snapshotHash = JSON.stringify(snapshot);
        if (snapshotHash !== previousSnapshotHash) {
          writeSse("snapshot", snapshot);
          previousSnapshotHash = snapshotHash;
        }
      }
      try {
        stream.onAbort(() => {
          closed = true;
        });
        writeChanges(session);
        while (!closed) {
          await stream.sleep(250);
          const current = discoverSessions().find((candidate) => candidate.name === name);
          if (!current) break;
          writeChanges(current);
          const now = Date.now();
          if (now - lastPing >= 25e3) {
            writeSse("ping", { at: (/* @__PURE__ */ new Date()).toISOString() });
            lastPing = now;
          }
        }
      } finally {
        projectStreamConnections = Math.max(0, projectStreamConnections - 1);
        sseMetrics.connections = projectStreamConnections;
      }
    });
  });
  app.post("/api/project/:name/inject", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const text = body.text;
    const paneId = body.paneId;
    const sendEnter = body.sendEnter;
    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (paneId !== void 0 && (typeof paneId !== "string" || !/^%\d+$/.test(paneId))) {
      return c.json({ error: "paneId must match /^%\\d+$/" }, 400);
    }
    if (sendEnter !== void 0 && typeof sendEnter !== "boolean") {
      return c.json({ error: "sendEnter must be a boolean" }, 400);
    }
    const panes = listSessionPanes(name);
    const pane = paneId ? panes.find((candidate) => candidate.id === paneId) : panes.find((p) => p.active);
    if (!pane) {
      return c.json({ error: "Pane not found" }, 404);
    }
    sendLiteralToPane(name, pane.id, text);
    if (sendEnter) sendEnterToPane(name, pane.id);
    return c.json({ ok: true });
  });
  app.post("/api/project/:name/send", zValidator("json", sendCommandSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const { target, message, noEnter } = c.req.valid("json");
    const panes = listSessionPanes(name);
    const pane = resolvePane(panes, target);
    if (!pane) {
      const available = panes.map((p) => ({
        id: p.id,
        title: p.title,
        name: p.name,
        role: p.role
      }));
      return c.json({ error: "Pane not found", target, available }, 404);
    }
    const busyStatus = getPaneBusyStatus(name, pane.id);
    const prepared = busyStatus === "agent" ? message.replace(/\n+/g, " ").trim() : message;
    if (noEnter) {
      sendText(name, pane.id, prepared);
    } else {
      sendCommand(name, pane.id, prepared);
    }
    return c.json({
      ok: true,
      session: name,
      target: {
        paneId: pane.id,
        name: pane.name,
        title: pane.title,
        role: pane.role
      },
      busyStatus
    });
  });
  app.get("/api/project/:name/config", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const { config: config2, configPath } = readConfig(session.dir);
      return c.json({ ok: true, config: config2, configPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to read ide.yml", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/config", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = IdeConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid config", details: parsed.error.issues }, 400);
    }
    try {
      const configPath = writeConfig(session.dir, parsed.data);
      return c.json({ ok: true, config: parsed.data, configPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to write ide.yml", detail: message }, 500);
    }
  });
  const execFileAsync = promisify(execFile2);
  app.post("/api/project/:name/restart", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      await execFileAsync("tmux-ide", ["restart", "--json"], {
        cwd: session.dir,
        timeout: 3e4,
        env: { ...process.env, TMUX: "" }
      });
      return c.json({ ok: true, session: name, status: "restarted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Restart failed", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/launch", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const state = getSessionState(name);
    if (state.running) {
      return c.json({ ok: true, session: name, status: "already_running" });
    }
    try {
      await execFileAsync("tmux-ide", ["--json"], {
        cwd: session.dir,
        timeout: 3e4,
        env: { ...process.env, TMUX: "" }
        // Clear TMUX to avoid nesting
      });
      return c.json({ ok: true, session: name, status: "launched" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Launch failed", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/stop", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const state = getSessionState(name);
    if (!state.running) {
      return c.json({ ok: true, session: name, status: "not_running" });
    }
    stopSessionMonitor(name);
    const result = killSession(name);
    if (result.stopped) {
      return c.json({ ok: true, session: name, status: "stopped" });
    }
    return c.json({ error: "Stop failed", reason: result.reason }, 500);
  });
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let prevOverviews = [];
      const poll = () => {
        const sessions = discoverSessions();
        const overviews = buildOverviews(sessions);
        const prevNames = new Set(prevOverviews.map((s) => s.name));
        const currNames = new Set(overviews.map((s) => s.name));
        for (const overview of overviews) {
          if (!prevNames.has(overview.name)) {
            stream.writeSSE({ event: "session_added", data: JSON.stringify(overview) });
          }
        }
        for (const prev of prevOverviews) {
          if (!currNames.has(prev.name)) {
            stream.writeSSE({
              event: "session_removed",
              data: JSON.stringify({ name: prev.name })
            });
          }
        }
        prevOverviews = overviews;
      };
      poll();
      while (true) {
        await stream.sleep(2e3);
        poll();
      }
    });
  });
  app.get("/api/logs/:channel", (c) => {
    const channel = c.req.param("channel");
    const match = matchLogChannel(channel);
    if (!match) {
      return c.json({ error: `Unknown log channel: ${channel}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      const backfill = getLogBuffer().filter(match);
      for (const entry of backfill) {
        await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
      }
      await stream.writeSSE({ event: "bookmark", data: String(backfill.length) });
      const queue = [];
      let cancelled = false;
      const unsub = subscribeLogs((entry) => {
        if (cancelled) return;
        if (match(entry)) queue.push(entry);
      });
      try {
        while (!cancelled) {
          if (queue.length === 0) {
            await stream.sleep(500);
            continue;
          }
          const drained = queue.splice(0, queue.length);
          for (const entry of drained) {
            await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
          }
        }
      } finally {
        cancelled = true;
        unsub();
      }
    });
  });
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      version: pkgVersion
    });
  });
  app.get("/api/projects", (c) => {
    return c.json({ projects: listProjects() });
  });
  app.get("/api/projects/templates", (c) => {
    return c.json({ templates: listAvailableTemplates() });
  });
  app.post("/api/projects", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RegisterProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    try {
      const project = await registerProject({
        dir: parsed.data.dir,
        name: parsed.data.name
      });
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      throw err;
    }
  });
  app.delete("/api/projects/:name", (c) => {
    const name = c.req.param("name");
    try {
      unregisterProject(name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.post("/api/projects/:name/probe", async (c) => {
    const name = c.req.param("name");
    if (!getProject(name)) {
      return c.json({ error: `Project "${name}" not found in registry`, code: "NOT_FOUND" }, 404);
    }
    try {
      const project = await refreshProject(name);
      return c.json({ project });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.post("/api/projects/init", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = InitProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    if (!existsSync31(parsed.data.dir)) {
      return c.json({ error: `Directory "${parsed.data.dir}" does not exist` }, 400);
    }
    const jobId = randomUUID3();
    const command2 = process.env.TMUX_IDE_INIT_COMMAND ?? "tmux-ide";
    void (async () => {
      try {
        await runInit({
          cwd: parsed.data.dir,
          template: parsed.data.template,
          command: command2,
          onChunk: (chunk) => {
            broadcastInitOutput(jobId, chunk);
          }
        });
        broadcastInitOutput(jobId, "", true);
        try {
          await registerProject({ dir: parsed.data.dir });
        } catch (err) {
          if (!(err instanceof ProjectAlreadyRegisteredError) && !(err instanceof ProjectDirNotFoundError)) {
            broadcastInitError(jobId, err.message);
          }
        }
      } catch (err) {
        if (err instanceof ProjectInitTimeoutError) {
          broadcastInitError(jobId, err.message);
        } else if (err instanceof ProjectInitFailedError) {
          broadcastInitError(jobId, err.message);
        } else {
          broadcastInitError(jobId, err.message);
        }
      }
    })();
    return c.json({ jobId }, 202);
  });
  app.post("/api/projects/onboard", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = OnboardProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const sandboxResult = sandboxResolveDir(parsed.data.dir);
    if ("error" in sandboxResult) {
      return c.json(
        { error: sandboxResult.error, message: sandboxResult.message },
        sandboxResult.status
      );
    }
    const dir = sandboxResult.canonical;
    let inspect2;
    try {
      inspect2 = await inspectProject(dir);
    } catch (err) {
      if (err instanceof InspectDirNotFoundError) {
        return c.json({ error: "not-found", message: err.message }, 404);
      }
      throw err;
    }
    try {
      assertNoExistingIdeYml(dir);
    } catch (err) {
      if (err instanceof OnboardConflictError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
    const finalName = parsed.data.name?.trim() || inspect2.name;
    let config2;
    try {
      config2 = composeIdeYmlConfig({
        name: finalName,
        agents: parsed.data.agents,
        agentNames: parsed.data.agentNames,
        devCommand: parsed.data.devCommand ?? null,
        testCommand: parsed.data.testCommand ?? null,
        lintCommand: parsed.data.lintCommand ?? null
      });
    } catch (err) {
      if (err instanceof OnboardInvalidInputError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
    writeConfig(dir, config2);
    try {
      const project = await registerProject({ dir, name: finalName });
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
  });
  return app;
}
function listAvailableTemplates() {
  const __filename = fileURLToPath8(import.meta.url);
  const __dir = dirname20(__filename);
  const templatesDir = join24(__dir, "..", "..", "..", "..", "templates");
  if (!existsSync31(templatesDir)) return [];
  const labels = {
    default: { label: "Default", description: "Single Claude pane + dev/shell row" },
    nextjs: {
      label: "Next.js",
      description: "Two Claude panes + Next.js dev server + shell"
    },
    vite: { label: "Vite", description: "Vite dev server + Claude + shell" },
    convex: {
      label: "Convex",
      description: "Convex dev + Next.js + Claude pane"
    },
    python: { label: "Python", description: "Python project with Claude + tests" },
    go: { label: "Go", description: "Go project with Claude + tests + shell" },
    "agent-team": {
      label: "Agent Team",
      description: "Lead + teammate Claude panes for coordinated multi-agent work"
    },
    "agent-team-nextjs": {
      label: "Agent Team \u2014 Next.js",
      description: "Agent team layout tuned for a Next.js app"
    },
    "agent-team-monorepo": {
      label: "Agent Team \u2014 Monorepo",
      description: "Agent team layout for monorepos with multiple apps"
    },
    missions: {
      label: "Missions",
      description: "Mission-driven layout with planner, validator, and researcher"
    }
  };
  const entries = readdirSync4(templatesDir).filter((f) => f.endsWith(".yml"));
  return entries.map((file) => {
    const id = file.replace(/\.yml$/, "");
    const meta = labels[id];
    return {
      id,
      label: meta?.label ?? id,
      description: meta?.description ?? `Template: ${id}`
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function attachWsEvents(server) {
  const wss = new WebSocketServer({ noServer: true });
  const upgradeListener = (req, socket, head3) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (pathname !== "/ws/events") return;
    wss.handleUpgrade(req, socket, head3, (ws) => {
      handleWsEventsConnection(ws);
    });
  };
  server.on("upgrade", upgradeListener);
  return {
    close: () => {
      server.off("upgrade", upgradeListener);
      wss.close();
    }
  };
}
var __dirname5, pkgVersion, projectStreamConnections, sseMetrics;
var init_server = __esm({
  "packages/daemon/src/command-center/server.ts"() {
    "use strict";
    init_discovery();
    init_pane_comms();
    init_send();
    init_src();
    init_yaml_io();
    init_ide_config2();
    init_log();
    init_workspace_registry();
    init_src2();
    init_schemas();
    init_src2();
    init_terminals_store();
    init_ws_route();
    init_ws_events();
    init_auth_service();
    init_middleware();
    init_ws_events();
    init_dispatcher();
    init_project_registry();
    init_project_init_runner();
    init_registry();
    init_inspect();
    init_filesystem_browser();
    init_project_inspect();
    init_project_onboard();
    __dirname5 = dirname20(fileURLToPath8(import.meta.url));
    pkgVersion = resolvePackageVersion();
    projectStreamConnections = 0;
    sseMetrics = {
      connections: 0,
      messagesSent: 0
    };
  }
});

// packages/daemon/src/lib/auth/types.ts
var types_exports = {};
__export(types_exports, {
  AuthConfigSchema: () => AuthConfigSchema
});
var init_types = __esm({
  "packages/daemon/src/lib/auth/types.ts"() {
    "use strict";
    init_src2();
  }
});

// packages/daemon/src/lib/daemon-embed.ts
import { execFileSync as execFileSync11 } from "node:child_process";
import { randomBytes as randomBytes3 } from "node:crypto";
import { createServer } from "node:http";
import { createRequire as createRequire2 } from "node:module";
import { WebSocket, WebSocketServer as WebSocketServer2 } from "ws";
function tmux3(...args) {
  return execFileSync11("tmux", args, {
    encoding: "utf-8",
    // Pipe stdio explicitly. Inheriting (the default) inherits the parent's
    // file descriptors; when the daemon is launched detached (nohup, disown,
    // launchd, etc.) the controlling terminal's fds can be invalid, and the
    // child spawn fails with EBADF. The visible symptom is sessionExists()
    // returning false → stopSelf → ghost daemon.
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function tmuxSilent2(...args) {
  try {
    return tmux3(...args);
  } catch {
    return "";
  }
}
function assertTmuxSession(sessionName) {
  try {
    tmux3("has-session", "-t", sessionName);
  } catch (err) {
    throw new DaemonStartupError(
      `tmux session "${sessionName}" does not exist`,
      "tmux_session_missing",
      { cause: err }
    );
  }
}
function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DaemonStartupError(`Invalid daemon port: ${port}`, "port_invalid");
  }
}
async function pickFreePort(hostname2) {
  const probe = createServer();
  return await new Promise((resolve24, reject) => {
    probe.once("error", reject);
    probe.listen(0, hostname2, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => {
        if (port) resolve24(port);
        else reject(new DaemonStartupError("Could not allocate daemon port", "bind_failed"));
      });
    });
  });
}
function sessionExists(sessionName) {
  try {
    tmux3("has-session", "-t", sessionName);
    return "yes";
  } catch (err) {
    const msg = err.message ?? "";
    const code = err.code;
    if (code === "EBADF" || code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || msg.includes("EBADF") || msg.includes("EAGAIN")) {
      console.error("[daemon] sessionExists transient spawn error:", msg);
      return "unknown";
    }
    return "no";
  }
}
function hasClients() {
  return tmuxSilent2("list-clients").length > 0;
}
function listPanes2(sessionName) {
  const raw = tmuxSilent2(
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_id}	#{pane_pid}	#{pane_current_command}	#{pane_title}	#{@ide_role}	#{@ide_type}	#{@ide_name}"
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [id, pid, cmd, title, role, type, name] = line.split("	");
    return {
      id,
      pid,
      cmd,
      title,
      role: role || void 0,
      type: type || void 0,
      name: name || void 0
    };
  });
}
function bearerToken2(authHeader) {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}
function requestToken(req) {
  const headerToken = bearerToken2(req.headers.authorization);
  if (headerToken) return headerToken;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
function isLoopbackRequest(req) {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" || remote.startsWith("127.");
}
function isLoopbackBind(bindHostname) {
  return bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
}
function isUpgradeAuthorized(req, token, localBypassToken, bindHostname) {
  if (!token) return true;
  if (isLoopbackBind(bindHostname) && isLoopbackRequest(req)) return true;
  const supplied = requestToken(req);
  return supplied === token || localBypassToken != null && supplied === localBypassToken;
}
function rejectUpgradeWithPolicy(wss, req, socket, head3) {
  wss.handleUpgrade(req, socket, head3, (ws) => {
    ws.close(1008, "Remote access token required");
  });
}
function attachWebSockets(server, opts = {}) {
  const eventsWss = new WebSocketServer2({ noServer: true });
  const ptyWss = new WebSocketServer2({ noServer: true });
  const clients = /* @__PURE__ */ new Set();
  const track = (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  };
  const upgradeListener = (req, socket, head3) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if ((pathname === "/ws/events" || pathname.startsWith("/ws/pty/")) && !isUpgradeAuthorized(req, opts.authToken, opts.localBypassToken, opts.bindHostname)) {
      rejectUpgradeWithPolicy(pathname === "/ws/events" ? eventsWss : ptyWss, req, socket, head3);
      return;
    }
    if (pathname === "/ws/events") {
      eventsWss.handleUpgrade(req, socket, head3, (ws) => {
        track(ws);
        handleWsEventsConnection(ws);
      });
      return;
    }
    const ptyMatch = pathname.match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      const id = decodeURIComponent(ptyMatch[1]);
      ptyWss.handleUpgrade(req, socket, head3, (ws) => {
        track(ws);
        handlePtyWebSocket(ws, id);
      });
      return;
    }
  };
  server.on("upgrade", upgradeListener);
  return {
    closeClients: () => {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          closeWsGoingAway(ws);
        }
      }
    },
    closeServers: async () => {
      server.off("upgrade", upgradeListener);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
          ws.terminate();
        }
      }
      const closeWss = (wss) => Promise.race([new Promise((resolve24) => wss.close(() => resolve24())), delay(100)]);
      await Promise.all([closeWss(eventsWss), closeWss(ptyWss)]);
    }
  };
}
function waitForServerClose(server) {
  return new Promise((resolve24, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve24();
    });
  });
}
function delay(ms) {
  return new Promise((resolve24) => setTimeout(resolve24, ms));
}
function generateLocalBypassToken() {
  return randomBytes3(32).toString("base64url");
}
function probeHostname2(bindHostname) {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}
function timeoutSignal2(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
async function healthGone(port, bindHostname) {
  try {
    const res = await fetch(`http://${probeHostname2(bindHostname)}:${port}/health`, {
      signal: timeoutSignal2(500)
    });
    return !res.ok;
  } catch {
    return true;
  }
}
async function requestDaemonShutdown(port, bindHostname) {
  try {
    await fetch(`http://${probeHostname2(bindHostname)}:${port}/api/v2/action/daemon.shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "takeover" }),
      signal: timeoutSignal2(1e3)
    });
  } catch {
  }
}
async function takeoverCanonicalDaemon(info) {
  await requestDaemonShutdown(info.port, info.bindHostname);
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    const current = readCanonicalDaemonInfo();
    const fileGone = !current || current.pid !== info.pid || current.port !== info.port;
    const serverGone = await healthGone(info.port, info.bindHostname);
    if (fileGone && serverGone) return;
    await delay(150);
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
  }
  await delay(500);
  try {
    process.kill(info.pid, "SIGKILL");
  } catch {
  }
  clearCanonicalDaemonInfo();
}
function closeWsGoingAway(ws) {
  const reason = Buffer.from("going away");
  const payload = Buffer.allocUnsafe(2 + reason.length);
  payload.writeUInt16BE(1001, 0);
  reason.copy(payload, 2);
  const frame = Buffer.concat([Buffer.from([136, payload.length]), payload]);
  const socket = ws._socket;
  if (socket && !socket.destroyed && socket.writable) {
    socket.end(frame);
    return;
  }
  ws.close(1001, reason);
}
async function startHttpServer({
  sessionName,
  requestedPort,
  bindHostname,
  dir,
  authToken,
  localBypassToken,
  silent
}) {
  const { createApp: createApp3 } = await Promise.resolve().then(() => (init_server(), server_exports));
  const { getRequestListener: getRequestListener3 } = await import(requireFromHere.resolve("@hono/node-server"));
  const { AuthService: AuthService2 } = await Promise.resolve().then(() => (init_auth_service(), auth_service_exports));
  const { AuthConfigSchema: AuthConfigSchema2 } = await Promise.resolve().then(() => (init_types(), types_exports));
  let authConfig = AuthConfigSchema2.parse({});
  try {
    const { readConfig: readConfig2 } = await Promise.resolve().then(() => (init_yaml_io(), yaml_io_exports));
    const { config: config2 } = readConfig2(dir);
    if (config2.auth) authConfig = AuthConfigSchema2.parse(config2.auth);
  } catch {
  }
  const authService = new AuthService2(authConfig.secret);
  const app = createApp3({
    authService,
    authConfig,
    remoteAccess: {
      bindHostname,
      token: authToken ?? null,
      localBypassToken: localBypassToken ?? null
    }
  });
  app.get("/api/daemon/health", (c) => {
    return c.json({ ok: true, session: sessionName });
  });
  const server = createServer(getRequestListener3(app.fetch));
  const sockets = /* @__PURE__ */ new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const { closeClients, closeServers: closeWsServers } = attachWebSockets(server, {
    authToken,
    localBypassToken,
    bindHostname
  });
  await new Promise((resolve24, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new DaemonStartupError(`Port ${requestedPort} is already in use`, "port_in_use", {
            cause: err
          })
        );
      } else {
        reject(
          new DaemonStartupError(`Failed to bind daemon on port ${requestedPort}`, "bind_failed", {
            cause: err
          })
        );
      }
    };
    const onListening = () => {
      server.off("error", onError);
      if (!silent) {
        console.log(
          `[daemon] Command Center on http://${bindHostname}:${requestedPort} (session: ${sessionName})`
        );
      }
      resolve24();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, bindHostname);
  });
  return {
    server,
    sockets,
    closeClients,
    closeWsServers
  };
}
async function startEmbeddedDaemon(opts) {
  const sessionName = opts.sessionName ?? EMBEDDED_SESSION_NAME;
  const sessionless = opts.sessionName == null;
  const appSettings = readAppSettings();
  const persistedRemoteAccess = appSettings.remoteAccess.enabled && appSettings.remoteAccess.token ? appSettings.remoteAccess : null;
  const bindHostname = opts.bindHostname ?? opts.hostname ?? (persistedRemoteAccess ? "0.0.0.0" : DEFAULT_HOSTNAME);
  const authToken = opts.authToken ?? persistedRemoteAccess?.token ?? null;
  const localBypassToken = opts.localBypassToken ?? generateLocalBypassToken();
  const existingCanonical = readCanonicalDaemonInfo();
  if (existingCanonical) {
    if (await isCanonicalDaemonAlive(existingCanonical)) {
      if (opts.takeoverIfRunning) {
        await takeoverCanonicalDaemon(existingCanonical);
      } else {
        throw new DaemonStartupError(
          `Canonical daemon is already running on port ${existingCanonical.port}`,
          "canonical_already_running"
        );
      }
    } else {
      clearCanonicalDaemonInfo();
    }
  }
  if (!sessionless) assertTmuxSession(sessionName);
  const port = opts.port ?? await pickFreePort(bindHostname);
  validatePort(port);
  const dir = process.cwd();
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  await workspaceRegistry.load();
  const legacySession = process.env.TMUX_IDE_SESSION;
  if (legacySession && !workspaceRegistry.has(legacySession)) {
    try {
      workspaceRegistry.add({
        name: legacySession,
        sessionName: legacySession,
        projectDir: dir
      });
    } catch {
    }
  }
  if (!sessionless && sessionName !== EMBEDDED_SESSION_NAME && !workspaceRegistry.has(sessionName)) {
    try {
      workspaceRegistry.add({
        name: sessionName,
        sessionName,
        projectDir: dir
      });
    } catch {
    }
  }
  const { server, sockets, closeClients, closeWsServers } = await startHttpServer({
    sessionName,
    requestedPort: port,
    bindHostname,
    dir,
    authToken,
    localBypassToken,
    silent: opts.silent
  });
  const pkg = requireFromHere("../../package.json");
  writeCanonicalDaemonInfo({
    pid: process.pid,
    port,
    version: pkg.version ?? "0.0.0",
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    bindHostname,
    authToken
  });
  let lastState = "";
  let stopped = false;
  let stopping = null;
  let stopSelf = null;
  const activeProjectStops = /* @__PURE__ */ new Map();
  const activateProjectOnDaemon = async (projectName, _options = {}) => {
    if (!activeProjectStops.has(projectName)) {
      activeProjectStops.set(projectName, { stop: () => void 0 });
    }
    return {
      stop: async () => {
        const current = activeProjectStops.get(projectName);
        if (!current) return;
        activeProjectStops.delete(projectName);
        current.stop();
      }
    };
  };
  setActivationBackend({
    activateProject: async (name, options) => {
      await activateProjectOnDaemon(name, options);
    },
    deactivateProject: async (name) => {
      const stop2 = activeProjectStops.get(name);
      if (!stop2) return;
      activeProjectStops.delete(name);
      stop2.stop();
    }
  });
  const tick = () => {
    if (sessionless) return;
    const session = sessionExists(sessionName);
    if (session === "no") {
      stopSelf?.();
      return;
    }
    if (session === "unknown") {
      return;
    }
    if (!hasClients()) return;
    const panes = listPanes2(sessionName);
    if (panes.length === 0) return;
    const portPanes = computePortPanes(panes);
    const agentStates = computeAgentStates(panes);
    const stateKey = panes.map((pane) => {
      const portState = portPanes.has(pane.id) ? "1" : "0";
      const agent = agentStates.get(pane.id) ?? "-";
      const titleDrift = pane.name && pane.title !== pane.name ? "d" : "ok";
      return `${pane.id}:${portState}:${agent}:${titleDrift}`;
    }).join("|");
    if (stateKey === lastState) return;
    for (const pane of panes) {
      const hasPort = portPanes.has(pane.id) ? "1" : "0";
      const agent = agentStates.get(pane.id);
      tmuxSilent2("set-option", "-pqt", pane.id, "@has_port", hasPort);
      tmuxSilent2("set-option", "-pqt", pane.id, "@agent_busy", agent === "busy" ? "1" : "0");
      tmuxSilent2("set-option", "-pqt", pane.id, "@agent_idle", agent === "idle" ? "1" : "0");
      if (pane.name && pane.title !== pane.name) {
        tmuxSilent2("select-pane", "-t", pane.id, "-T", pane.name);
      }
    }
    tmuxSilent2("refresh-client", "-S");
    lastState = stateKey;
  };
  const monitorInterval = setInterval(tick, MONITOR_INTERVAL_MS);
  const apiBaseUrl = `http://${bindHostname}:${port}`;
  const wsUrl = `ws://${bindHostname}:${port}/ws/events`;
  const handle = {
    port,
    apiBaseUrl,
    wsUrl,
    localBypassToken,
    stop: async ({ gracefulMs = DEFAULT_GRACEFUL_MS } = {}) => {
      if (stopped) return;
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          stopped = true;
          setActivationBackend(null);
          clearInterval(monitorInterval);
          const closePromise = waitForServerClose(server);
          closeClients();
          for (const stop2 of activeProjectStops.values()) {
            stop2.stop();
          }
          activeProjectStops.clear();
          shutdownPtyBridges();
          await Promise.race([closePromise, delay(gracefulMs)]);
          for (const socket of sockets) socket.destroy();
          await Promise.race([closePromise.catch(() => void 0), delay(100)]);
          await closeWsServers();
          setRemoteAccessRestartBackend(null);
          setDaemonShutdownBackend(null);
        } catch (err) {
          throw new DaemonShutdownError("Daemon shutdown failed", { cause: err });
        } finally {
          clearCanonicalDaemonInfo();
        }
      })();
      return stopping;
    },
    activateProject: activateProjectOnDaemon
  };
  setDaemonShutdownBackend(async () => {
    await handle.stop({ gracefulMs: 500 });
  });
  setRemoteAccessRestartBackend((request) => {
    setTimeout(() => {
      void (async () => {
        const restartPort = request.port ?? port;
        try {
          await handle.stop({ gracefulMs: 500 });
        } catch (err) {
          console.error("[daemon] Remote access stop before restart failed:", err);
        } finally {
          clearCanonicalDaemonInfo();
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const nextHandle = await startEmbeddedDaemon({
              sessionName: sessionless ? void 0 : sessionName,
              port: restartPort,
              bindHostname: request.bindHostname,
              authToken: request.token,
              localBypassToken
            });
            const mutableHandle = handle;
            mutableHandle.stop = nextHandle.stop;
            mutableHandle.activateProject = nextHandle.activateProject;
            return;
          } catch (err) {
            if (err instanceof DaemonStartupError && err.reason === "port_in_use" && attempt === 0) {
              await delay(150);
              continue;
            }
            throw err;
          }
        }
      })().catch((err) => {
        console.error("[daemon] Remote access restart failed:", err);
        clearCanonicalDaemonInfo();
      });
    }, 50).unref?.();
    return { port };
  });
  stopSelf = () => void handle.stop();
  tick();
  return handle;
}
var requireFromHere, DEFAULT_HOSTNAME, DEFAULT_GRACEFUL_MS, MONITOR_INTERVAL_MS, EMBEDDED_SESSION_NAME;
var init_daemon_embed = __esm({
  "packages/daemon/src/lib/daemon-embed.ts"() {
    "use strict";
    init_session_monitor();
    init_errors2();
    init_ws_route();
    init_ws_events();
    init_app_set_remote_access();
    init_daemon_shutdown();
    init_app_settings();
    init_workspace_registry();
    init_active_projects();
    init_canonical_daemon();
    requireFromHere = createRequire2(import.meta.url);
    DEFAULT_HOSTNAME = "127.0.0.1";
    DEFAULT_GRACEFUL_MS = 2e3;
    MONITOR_INTERVAL_MS = 1e3;
    EMBEDDED_SESSION_NAME = "__embedded__";
  }
});

// packages/daemon/src/lib/cli-action-bridge.ts
import { createRequire as createRequire3 } from "node:module";
import { z as z16 } from "zod";
function timeoutSignal3(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
async function isDaemonAlive(port) {
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/health`, {
      signal: timeoutSignal3(500)
    });
    return res.ok;
  } catch {
    return false;
  }
}
function hostnameForClient(bindHostname) {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}
function daemonBaseUrl(info) {
  return `http://${hostnameForClient(info.bindHostname)}:${info.port}`;
}
function expectedDaemonVersion() {
  try {
    const pkg = requireFromHere2("../../package.json");
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
async function resolveCanonicalDaemon() {
  const existing = deps.readCanonicalDaemonInfo();
  if (existing) {
    if (await deps.isCanonicalDaemonAlive(existing)) {
      warnOnDaemonVersionSkew(existing, expectedDaemonVersion());
      return { baseUrl: daemonBaseUrl(existing), transientHandle: null, restoreCwd: null };
    }
    deps.clearCanonicalDaemonInfo();
  }
  if (process.env.TMUX_IDE_CLI_NO_AUTOSTART) {
    return null;
  }
  const dir = deps.cwd();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const handle = await deps.startEmbeddedDaemon({
      sessionName: void 0,
      bindHostname: "127.0.0.1",
      silent: true
    });
    if (!await isDaemonAlive(handle.port)) {
      await handle.stop();
      process.chdir(previousCwd);
      return null;
    }
    return { baseUrl: handle.apiBaseUrl, transientHandle: handle, restoreCwd: previousCwd };
  } catch {
    process.chdir(previousCwd);
    return null;
  }
}
async function stopTransientDaemon(daemon) {
  if (daemon.transientHandle) await daemon.transientHandle.stop().catch(() => void 0);
  if (daemon.restoreCwd) process.chdir(daemon.restoreCwd);
}
async function tryDispatchAction(name, input, options = {}) {
  const dir = options.cwd ?? deps.cwd();
  const previousDeps = deps;
  deps = { ...deps, cwd: () => dir };
  const daemon = await resolveCanonicalDaemon();
  deps = previousDeps;
  if (!daemon) return null;
  const contract = ActionContractsZ[name];
  const parsedInput = contract.input.parse(input);
  let response;
  try {
    response = await deps.fetch(`${daemon.baseUrl}/api/v2/action/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedInput),
      signal: timeoutSignal3(2e3)
    });
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }
  await stopTransientDaemon(daemon);
  const failure = FailureEnvelopeZ.safeParse(body);
  if (failure.success) {
    throw new CliActionInvocationError({
      code: failure.data.error.code,
      message: failure.data.error.message,
      details: failure.data.error.details
    });
  }
  const success = z16.object({ ok: z16.literal(true), result: contract.result }).safeParse(body);
  if (!success.success) return null;
  return success.data.result;
}
var FailureEnvelopeZ, deps, CliActionInvocationError, requireFromHere2;
var init_cli_action_bridge = __esm({
  "packages/daemon/src/lib/cli-action-bridge.ts"() {
    "use strict";
    init_contract();
    init_canonical_daemon();
    init_daemon_embed();
    FailureEnvelopeZ = z16.object({
      ok: z16.literal(false),
      error: z16.object({
        code: z16.string(),
        message: z16.string(),
        details: z16.unknown().optional()
      })
    });
    deps = {
      fetch,
      cwd: () => process.cwd(),
      readCanonicalDaemonInfo,
      clearCanonicalDaemonInfo,
      isCanonicalDaemonAlive,
      startEmbeddedDaemon
    };
    CliActionInvocationError = class extends Error {
      code;
      details;
      constructor(error) {
        super(error.message);
        this.name = "CliActionInvocationError";
        this.code = error.code;
        this.details = error.details ?? null;
      }
    };
    requireFromHere2 = createRequire3(import.meta.url);
  }
});

// packages/daemon/src/config.ts
import { resolve as resolve21 } from "node:path";
function readConfigSafe(dir) {
  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read ide.yml: ${e.message}`, "READ_ERROR");
    return;
  }
  return cfg;
}
function withConfig(dir, mutator) {
  const cfg = readConfigSafe(dir);
  if (cfg === void 0) return;
  if (!isConfigObject(cfg)) {
    outputError("Invalid ide.yml: config root must be an object", "INVALID_CONFIG");
    return;
  }
  const result = mutator(cfg);
  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues = validation.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    outputError(`Invalid config after mutation:
${issues}`, "INVALID_CONFIG");
    return;
  }
  writeConfig(dir, cfg);
  return result;
}
function mutateConfig(dir, mutator) {
  const { config: cfg } = readConfig(dir);
  if (!isConfigObject(cfg)) {
    throw new Error("Invalid ide.yml: config root must be an object");
  }
  const result = mutator(cfg);
  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues = validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config after mutation: ${issues}`);
  }
  writeConfig(dir, cfg);
  return { config: cfg, result };
}
function assertDotPath(path2) {
  const parts = path2.split(".");
  if (!path2.trim() || parts.some((part) => !part) || parts.some((part) => part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error(`Invalid config path "${path2}"`);
  }
}
function configSetValue(dir, path2, value) {
  assertDotPath(path2);
  return mutateConfig(dir, (cfg) => {
    setByPath(cfg, path2, value);
  }).config;
}
function configAddPane(dir, rowIndex, pane) {
  return mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    if (!cfg.rows[rowIndex]) {
      throw new Error(`Row ${rowIndex} does not exist`);
    }
    if (!Array.isArray(cfg.rows[rowIndex].panes)) {
      throw new Error(`Invalid ide.yml: row ${rowIndex} panes must be an array`);
    }
    cfg.rows[rowIndex].panes.push(pane);
  }).config;
}
function configRemovePane(dir, rowIndex, paneIndex) {
  const updated = mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    if (!Array.isArray(cfg.rows[rowIndex]?.panes)) {
      throw new Error(`Invalid ide.yml: row ${rowIndex} panes must be an array`);
    }
    const removed = cfg.rows[rowIndex].panes[paneIndex];
    if (!removed) {
      throw new Error(`Pane ${paneIndex} in row ${rowIndex} does not exist`);
    }
    cfg.rows[rowIndex].panes.splice(paneIndex, 1);
    return removed;
  });
  return { config: updated.config, removed: updated.result };
}
function configAddRow(dir, size) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    const row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
  }).config;
}
function configEnableTeam(dir, name) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    cfg.team = { name: name ?? cfg.name ?? "my-team" };
    let leadAssigned = false;
    for (const row of cfg.rows ?? []) {
      for (const pane of row.panes ?? []) {
        if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
          pane.role = leadAssigned ? "teammate" : "lead";
          leadAssigned = true;
        }
      }
    }
    if (!leadAssigned) {
      delete cfg.team;
      throw new Error("Cannot enable agent team: no Claude panes found");
    }
  }).config;
}
function configDisableTeam(dir) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid ide.yml: 'rows' must be an array");
    }
    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  }).config;
}
async function config(targetDir, { json: json2, action, args } = {}) {
  const dir = resolve21(targetDir ?? ".");
  if (await tryDispatchConfigAction(dir, { json: json2, action, args: args ?? [] })) return;
  switch (action) {
    case "dump":
      return dumpConfig(dir, { json: json2 });
    case "set":
      return setConfig(dir, args ?? [], { json: json2 });
    case "add-pane":
      return addPane(dir, args ?? [], { json: json2 });
    case "remove-pane":
      return removePane(dir, args ?? [], { json: json2 });
    case "add-row":
      return addRow(dir, args ?? [], { json: json2 });
    case "enable-team":
      return enableTeam(dir, args ?? [], { json: json2 });
    case "disable-team":
      return disableTeam(dir, { json: json2 });
    default:
      return dumpConfig(dir, { json: json2 });
  }
}
function dumpConfig(dir, { json: json2 }) {
  const cfg = readConfigSafe(dir);
  if (cfg === void 0) return;
  if (json2) {
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    console.log(JSON.stringify(cfg, null, 2));
  }
}
function printConfigActionError(err) {
  if (err instanceof CliActionInvocationError) {
    outputError(err.message, err.code.toUpperCase());
  }
  throw err;
}
function coerceConfigValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return parseInt(raw);
  return raw;
}
async function tryDispatchConfigAction(dir, { json: json2, action, args }) {
  try {
    if (action === "set") {
      const [dotpath, ...rest] = args;
      if (!dotpath || rest.length === 0) return false;
      const value = coerceConfigValue(rest.join(" "));
      const result = await tryDispatchAction("config.set", { path: dotpath, value }, { cwd: dir });
      if (!result) return false;
      if (json2) console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
      else console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
      return true;
    }
    if (action === "add-pane") {
      const { row, title, command: command2, size } = parseNamedArgs(args);
      if (row === void 0) return false;
      const rowIndex = parseIndex(row);
      if (rowIndex == null) return false;
      const result = await tryDispatchAction(
        "config.addPane",
        { rowIndex, title, command: command2, size },
        { cwd: dir }
      );
      if (!result) return false;
      const pane = { title, command: command2, size };
      if (json2) console.log(JSON.stringify({ ok: true, row: rowIndex, pane }, null, 2));
      else console.log(`Added pane "${title ?? "untitled"}" to row ${rowIndex}`);
      return true;
    }
    if (action === "remove-pane") {
      const { row, pane } = parseNamedArgs(args);
      if (row === void 0 || pane === void 0) return false;
      const rowIndex = parseIndex(row);
      const paneIndex = parseIndex(pane);
      if (rowIndex == null || paneIndex == null) return false;
      const before = readConfigSafe(dir);
      const removed = before?.rows[rowIndex]?.panes[paneIndex] ?? null;
      const result = await tryDispatchAction(
        "config.removePane",
        { rowIndex, paneIndex },
        { cwd: dir }
      );
      if (!result) return false;
      if (json2) {
        console.log(JSON.stringify({ ok: true, row: rowIndex, pane: paneIndex, removed }, null, 2));
      } else {
        console.log(`Removed pane ${paneIndex} from row ${rowIndex}`);
      }
      return true;
    }
    if (action === "add-row") {
      const { size } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.addRow", { size }, { cwd: dir });
      if (!result) return false;
      const row = result.config.rows.length - 1;
      if (json2) console.log(JSON.stringify({ ok: true, row, size: size ?? null }, null, 2));
      else console.log(`Added row ${row}${size ? ` (${size})` : ""}`);
      return true;
    }
    if (action === "enable-team") {
      const { name } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.enableTeam", { name }, { cwd: dir });
      if (!result) return false;
      const teamName = result.config.team?.name ?? name ?? result.config.name ?? "my-team";
      if (json2) console.log(JSON.stringify({ ok: true, team: result.config.team }, null, 2));
      else console.log(`Enabled agent team "${teamName}"`);
      return true;
    }
    if (action === "disable-team") {
      const result = await tryDispatchAction("config.disableTeam", {}, { cwd: dir });
      if (!result) return false;
      if (json2) console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
      else console.log("Disabled agent team");
      return true;
    }
  } catch (err) {
    printConfigActionError(err);
  }
  return false;
}
function setConfig(dir, args, { json: json2 }) {
  const [dotpath, ...rest] = args;
  if (!dotpath || rest.length === 0) {
    outputError("Usage: tmux-ide config set <dotpath> <value>", "USAGE");
    return;
  }
  const value = coerceConfigValue(rest.join(" "));
  withConfig(dir, (cfg) => {
    setByPath(cfg, dotpath, value);
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
  } else {
    console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
  }
}
function addPane(dir, args, { json: json2 }) {
  const { row, title, command: command2, size } = parseNamedArgs(args);
  if (row === void 0) {
    outputError(
      "Usage: tmux-ide config add-pane --row <N> --title <T> [--command <C>] [--size <S>]",
      "USAGE"
    );
    return;
  }
  const rowIdx = parseIndex(row);
  if (rowIdx == null) {
    outputError(`Invalid row index "${row}"`, "USAGE");
    return;
  }
  const pane = {};
  if (title) pane.title = title;
  if (command2) pane.command = command2;
  if (size) pane.size = size;
  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }
    if (!cfg.rows[rowIdx]) {
      outputError(`Row ${rowIdx} does not exist`, "INVALID_ROW");
    }
    if (!Array.isArray(cfg.rows[rowIdx].panes)) {
      outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }
    cfg.rows[rowIdx].panes.push(pane);
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane }, null, 2));
  } else {
    console.log(`Added pane "${title ?? "untitled"}" to row ${rowIdx}`);
  }
}
function removePane(dir, args, { json: json2 }) {
  const { row, pane } = parseNamedArgs(args);
  if (row === void 0 || pane === void 0) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }
  const rowIdx = parseIndex(row);
  const paneIdx = parseIndex(pane);
  if (rowIdx == null || paneIdx == null) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }
  let removed;
  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }
    if (!Array.isArray(cfg.rows[rowIdx]?.panes)) {
      outputError(`Invalid ide.yml: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }
    if (!cfg.rows[rowIdx].panes[paneIdx]) {
      outputError(`Pane ${paneIdx} in row ${rowIdx} does not exist`, "INVALID_PANE");
    }
    removed = cfg.rows[rowIdx].panes.splice(paneIdx, 1)[0];
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane: paneIdx, removed }, null, 2));
  } else {
    console.log(`Removed pane ${paneIdx} ("${removed?.title ?? "untitled"}") from row ${rowIdx}`);
  }
}
function addRow(dir, args, { json: json2 }) {
  const { size } = parseNamedArgs(args);
  let rowIdx;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }
    const row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
    rowIdx = cfg.rows.length - 1;
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, size: size ?? null }, null, 2));
  } else {
    console.log(`Added row ${rowIdx}${size ? ` (${size})` : ""}`);
  }
}
function enableTeam(dir, args, { json: json2 }) {
  const { name } = parseNamedArgs(args);
  let teamName;
  let result;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }
    teamName = name ?? cfg.name ?? "my-team";
    cfg.team = { name: teamName };
    let leadAssigned = false;
    for (const row of cfg.rows ?? []) {
      for (const pane of row.panes ?? []) {
        if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
          if (!leadAssigned) {
            pane.role = "lead";
            leadAssigned = true;
          } else {
            pane.role = "teammate";
          }
        }
      }
    }
    if (!leadAssigned) {
      delete cfg.team;
      outputError("Cannot enable agent team: no Claude panes found", "INVALID_CONFIG");
    }
    result = { team: cfg.team, roles: summarizeRoles(cfg) };
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`Enabled agent team "${teamName}"`);
  }
}
function disableTeam(dir, { json: json2 }) {
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid ide.yml: 'rows' must be an array", "INVALID_CONFIG");
    }
    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
  } else {
    console.log("Disabled agent team");
  }
}
function summarizeRoles(cfg) {
  const roles = [];
  for (let i = 0; i < (cfg.rows ?? []).length; i++) {
    for (let j = 0; j < (cfg.rows[i].panes ?? []).length; j++) {
      const p = cfg.rows[i].panes[j];
      if (p.role) {
        roles.push({ row: i, pane: j, title: p.title ?? null, role: p.role });
      }
    }
  }
  return roles;
}
function parseNamedArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      const key = args[i].slice(2);
      result[key] = args[i + 1];
      i++;
    }
  }
  return result;
}
function isConfigObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function parseIndex(value) {
  if (!/^\d+$/.test(String(value))) return null;
  return Number.parseInt(value, 10);
}
var init_config = __esm({
  "packages/daemon/src/config.ts"() {
    "use strict";
    init_yaml_io();
    init_dot_path();
    init_output();
    init_ide_config2();
    init_cli_action_bridge();
  }
});

// package.json
var require_package = __commonJS({
  "package.json"(exports, module) {
    module.exports = {
      name: "tmux-ide",
      version: "2.7.0",
      description: "Turn any project into a tmux-powered terminal IDE with a simple ide.yml",
      type: "module",
      bin: {
        "tmux-ide": "bin/cli.js"
      },
      files: [
        "bin",
        "scripts",
        "skill",
        "templates",
        "packages/daemon/dist",
        "!packages/daemon/dist/tui",
        "packages/daemon/src",
        "bunfig.toml",
        "packages/contracts/src",
        "packages/tmux-bridge/src",
        "packages/tmux-bridge/package.json",
        "packages/contracts/package.json"
      ],
      scripts: {
        build: "pnpm build:cli",
        "build:cli": "node scripts/build-cli.mjs",
        "build:tui": "bun scripts/build-tui.mjs",
        prepublishOnly: "pnpm build:cli && pnpm check && node scripts/prepublish-check.mjs",
        typecheck: 'echo "root typecheck deferred to per-package turbo run"',
        dev: "node bin/cli.js",
        test: "pnpm -r --filter @tmux-ide/daemon --filter @tmux-ide/contracts run test",
        "test:unit": "pnpm -r --filter @tmux-ide/daemon --filter @tmux-ide/contracts run test",
        lint: "eslint bin scripts packages/contracts/src packages/tmux-bridge/src packages/daemon/src",
        "lint:workspace": "turbo run lint",
        format: "prettier --write .",
        "format:check": "prettier --check .",
        "build:workspace": "turbo run build",
        "typecheck:workspace": "turbo run typecheck",
        "docs:build": "turbo run build --filter=@tmux-ide/docs",
        "pack:check": "npm pack --dry-run --cache /tmp/tmux-ide-npm-cache > /dev/null",
        "check:native-deps": "node packages/daemon/scripts/check-native-deps.mjs",
        check: "pnpm run lint:workspace && pnpm run format:check && pnpm run typecheck:workspace && pnpm run test:unit && pnpm run docs:build && pnpm run pack:check && pnpm run check:native-deps",
        postinstall: "node scripts/postinstall.js",
        docs: "turbo run dev --filter=@tmux-ide/docs"
      },
      keywords: [
        "tmux",
        "ide",
        "terminal",
        "workspace",
        "developer-tools"
      ],
      engines: {
        node: ">=20"
      },
      repository: {
        type: "git",
        url: "git+https://github.com/wavyrai/tmux-ide.git"
      },
      homepage: "https://github.com/wavyrai/tmux-ide#readme",
      bugs: {
        url: "https://github.com/wavyrai/tmux-ide/issues"
      },
      license: "MIT",
      packageManager: "pnpm@10.21.0",
      dependencies: {
        "@hono/node-server": "^1.19.11",
        "@hono/zod-validator": "^0.7.6",
        "@opentui/core": "^0.4.3",
        "@opentui/solid": "^0.4.3",
        "@parcel/watcher": "^2.5.6",
        "@types/ws": "^8.18.1",
        hono: "^4.12.8",
        ignore: "^7.0.5",
        "js-yaml": "^4.1.1",
        "node-pty": "1.2.0-beta.12",
        "solid-js": "1.9.12",
        ws: "^8.20.0",
        zod: "^4.3.6"
      },
      pnpm: {
        onlyBuiltDependencies: [
          "@parcel/watcher",
          "esbuild",
          "node-pty"
        ],
        overrides: {
          zod: "^4.3.6"
        }
      },
      devDependencies: {
        "@eslint/js": "^10.0.1",
        "@tsconfig/bun": "^1.0.10",
        "@types/node": "^25.5.0",
        "@typescript-eslint/eslint-plugin": "^8.57.1",
        "@typescript-eslint/parser": "^8.57.1",
        "@vitest/coverage-v8": "^4.1.6",
        esbuild: "0.27.4",
        eslint: "^10.0.3",
        globals: "^17.4.0",
        prettier: "^3.8.1",
        turbo: "^2.3.3",
        typescript: "^5.9.3",
        vitest: "^4.1.0"
      },
      optionalDependencies: {
        "@opentui/core-darwin-arm64": "^0.4.3"
      }
    };
  }
});

// packages/daemon/src/tui/team/report.ts
var report_exports = {};
__export(report_exports, {
  findSessionStatus: () => findSessionStatus,
  toFleetJson: () => toFleetJson
});
function toFleetJson(projects) {
  return {
    projects: projects.map((p) => ({
      name: p.name,
      dir: p.dir,
      registered: p.registered,
      running: p.running,
      status: p.status,
      sessions: p.sessions.map((s) => ({
        name: s.name,
        status: s.status,
        panes: s.panes,
        attached: s.attached,
        windows: (s.windowList ?? []).map((w) => ({
          index: w.index,
          name: w.name,
          active: w.active,
          panes: w.panes,
          status: w.status
        })),
        // A pre-agents TeamSession (older constructor/test) yields `[]` — the
        // contract always exposes the array.
        agents: s.agents ?? []
      }))
    }))
  };
}
function findSessionStatus(sessions, name) {
  const match = sessions.find((s) => s.name === name);
  return match ? match.status : null;
}
var init_report = __esm({
  "packages/daemon/src/tui/team/report.ts"() {
    "use strict";
  }
});

// packages/daemon/src/control/frames.ts
function encodeFrame(message) {
  return `${JSON.stringify(message)}
`;
}
function createFrameSplitter() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = "";
      throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes without a newline`);
    }
    return parts.filter((line) => line.trim().length > 0);
  };
}
var MAX_FRAME_BYTES;
var init_frames = __esm({
  "packages/daemon/src/control/frames.ts"() {
    "use strict";
    MAX_FRAME_BYTES = 4 * 1024 * 1024;
  }
});

// packages/daemon/src/control/dispatch.ts
function extractId(value) {
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = value.id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}
async function dispatchLine(line, handlers, ctx) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(null, "bad-request", "frame is not valid JSON");
  }
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      extractId(raw),
      "bad-request",
      `invalid request envelope (need {v:${CONTROL_PROTOCOL_VERSION}, id, verb})`
    );
  }
  const { id, verb, params } = parsed.data;
  const handler = handlers[verb];
  if (!handler) {
    return fail(id, "unknown-verb", `unknown verb "${verb}"`);
  }
  try {
    return ok(id, await handler(params ?? {}, ctx));
  } catch (err) {
    if (err instanceof ControlVerbError) return fail(id, err.code, err.message);
    if (err instanceof IdeError) {
      const code = err.code === "USAGE" ? "bad-request" : "not-found";
      return fail(id, code, err.message);
    }
    return fail(id, "internal", err?.message ?? "internal error");
  }
}
var ControlVerbError, ok, fail;
var init_dispatch = __esm({
  "packages/daemon/src/control/dispatch.ts"() {
    "use strict";
    init_src2();
    init_errors2();
    ControlVerbError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
    ok = (id, data) => ({
      v: CONTROL_PROTOCOL_VERSION,
      id,
      ok: true,
      data
    });
    fail = (id, code, message) => ({
      v: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message }
    });
  }
});

// packages/daemon/src/control/fanout.ts
function createFanout(edges = {}) {
  const sinks = /* @__PURE__ */ new Set();
  const remove = (sink) => {
    if (!sinks.delete(sink)) return;
    if (sinks.size === 0) edges.onLast?.();
  };
  return {
    add(sink) {
      sinks.add(sink);
      if (sinks.size === 1) edges.onFirst?.();
      return () => remove(sink);
    },
    emit(event) {
      for (const sink of [...sinks]) {
        try {
          sink(event);
        } catch {
          remove(sink);
        }
      }
    },
    size: () => sinks.size
  };
}
var init_fanout = __esm({
  "packages/daemon/src/control/fanout.ts"() {
    "use strict";
  }
});

// packages/daemon/src/agent-explain.ts
var agent_explain_exports = {};
__export(agent_explain_exports, {
  agentExplain: () => agentExplain,
  buildReport: () => buildReport,
  renderReport: () => renderReport
});
import { execFileSync as execFileSync12 } from "node:child_process";
function tmux4(args) {
  try {
    return execFileSync12("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function readPaneInfo(target) {
  const fmt = "#{pane_id}	#{pane_pid}	#{pane_current_command}	#{@agent_state}	#{@agent_hint}	#{pane_title}";
  const raw = tmux4(["display-message", "-p", "-t", target, "-F", fmt]);
  if (!raw) return null;
  const [id = "", pid = "", cmd = "", authorityRaw = "", hintRaw = "", ...titleParts] = raw.split("	");
  if (!id) return null;
  return {
    id,
    pid: Number(pid) || 0,
    cmd,
    authorityRaw,
    hintRaw,
    title: titleParts.join("	")
  };
}
function buildReport(target) {
  const info = readPaneInfo(target);
  if (!info) {
    throw new IdeError(
      `No pane found for "${target}". Pass a pane id (%N) or a live session name.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const nowSec = Math.floor(Date.now() / 1e3);
  const authRaw = info.authorityRaw || null;
  let authState = null;
  let authEpoch = null;
  let ageSeconds = null;
  let stale = false;
  if (authRaw) {
    const sep2 = authRaw.lastIndexOf(":");
    if (sep2 !== -1) {
      authState = authRaw.slice(0, sep2);
      const epoch = Number(authRaw.slice(sep2 + 1));
      if (Number.isFinite(epoch)) {
        authEpoch = epoch;
        ageSeconds = nowSec - epoch;
        stale = (authState === "working" || authState === "blocked") && ageSeconds > AUTHORITY_STALE_SECONDS2;
      }
    }
  }
  const verdict = parseAuthority(info.authorityRaw, nowSec);
  const manifests = getManifests();
  const table = readProcessTable();
  const resolved2 = resolveAgentCommand(info.cmd, info.pid, table, {
    manifests,
    hint: info.hintRaw
  });
  const manifest = resolved2.manifest;
  const subtree = manifest ? [] : describeSubtree(table, info.pid);
  const snapshot = { ...readPaneSnapshot(info.id), title: info.title };
  const explained = manifest ? explain(snapshot, manifest) : {
    state: null,
    checked: []
  };
  const instant = classifyInstant(snapshot, manifest);
  const classification = verdict ?? instant;
  return {
    pane: { id: info.id, cmd: info.cmd, pid: info.pid, title: info.title },
    authority: {
      raw: authRaw,
      state: authState,
      epoch: authEpoch,
      ageSeconds,
      stale,
      verdict
    },
    hint: { raw: info.hintRaw || null, applied: resolved2.source === "hint" },
    resolution: {
      manifestId: manifest?.id ?? null,
      matchedCommand: resolved2.matchedCommand,
      source: resolved2.source,
      confidence: manifest ? manifest.confidence ?? "conservative" : null,
      subtree
    },
    states: explained.checked,
    winner: explained.state,
    instant,
    classification,
    bottomLines: snapshot.bottomNonEmpty.slice(-5)
  };
}
function renderReport(r, opts = {}) {
  const color2 = opts.color ?? !("NO_COLOR" in process.env);
  const c = (code, s) => color2 ? `${code}${s}\x1B[0m` : s;
  const bold4 = (s) => c("\x1B[1m", s);
  const dim4 = (s) => c("\x1B[2m", s);
  const label = (s) => c("\x1B[36m", s);
  const status2 = (s) => c(STATUS_COLOR[s] ?? "", s);
  const yesno = (v) => v ? c("\x1B[32m", "yes") : dim4("no");
  const out = [];
  out.push(bold4(`agent explain \u2014 ${r.pane.id}`));
  out.push(`  ${label("command")}   ${r.pane.cmd}  ${dim4(`(pid ${r.pane.pid})`)}`);
  if (r.pane.title) out.push(`  ${label("title")}     ${r.pane.title}`);
  if (r.authority.raw) {
    const age = r.authority.ageSeconds !== null ? ` ${dim4(`(${r.authority.ageSeconds}s ago)`)}` : "";
    const staleTag = r.authority.stale ? " " + c("\x1B[31m", "[STALE \u2192 ignored]") : "";
    const verdict = r.authority.verdict ? status2(r.authority.verdict) : dim4("none (stale/malformed)");
    out.push(`  ${label("authority")} ${r.authority.raw}${age}${staleTag} \u2192 ${verdict}`);
  } else {
    out.push(`  ${label("authority")} ${dim4("(unset \u2014 falling back to scraping)")}`);
  }
  if (r.hint.raw) {
    out.push(
      `  ${label("hint")}      @agent_hint=${r.hint.raw} \u2192 ${yesno(r.hint.applied)} applied`
    );
  } else {
    out.push(`  ${label("hint")}      ${dim4("(unset)")}`);
  }
  if (r.resolution.manifestId) {
    const conf = r.resolution.confidence === "tuned" ? c("\x1B[32m", "tuned") : dim4(r.resolution.confidence ?? "conservative");
    out.push(
      `  ${label("manifest")}  ${r.resolution.manifestId}  ${dim4(`via ${r.resolution.source}` + (r.resolution.matchedCommand ? ` "${r.resolution.matchedCommand}"` : ""))}  [${conf}]`
    );
  } else {
    const saw = r.resolution.subtree.length > 0 ? r.resolution.subtree.join(", ") : r.pane.cmd || "(nothing)";
    out.push(`  ${label("manifest")}  ${dim4("none matched")} \u2014 ${dim4(`process-tree saw: ${saw}`)}`);
    out.push(`            ${dim4("set `tmux set-option -p @agent_hint <agent>` to force one")}`);
  }
  out.push("");
  out.push(bold4("  state rules"));
  if (r.states.length === 0) {
    out.push(`    ${dim4("(no manifest resolved \u2014 nothing to evaluate)")}`);
  } else {
    for (const s of r.states) {
      const mark = s.matched ? c("\x1B[32m", "\u2713 matched") : dim4("\xB7 no match");
      const win = r.winner === s.state ? "  " + c("\x1B[1m", "\u2190 winner") : "";
      out.push(`    ${s.state.padEnd(8)} ${mark}${win}`);
    }
  }
  out.push("");
  out.push(
    `  ${bold4("classification")}  ${status2(r.classification)}  ${dim4(`(instant: ${r.instant})`)}`
  );
  out.push("");
  out.push(bold4("  bottom 5 lines judged"));
  if (r.bottomLines.length === 0) {
    out.push(`    ${dim4("(empty capture)")}`);
  } else {
    for (const line of r.bottomLines) out.push(`    ${dim4("\u2502")} ${line}`);
  }
  return out.join("\n");
}
function agentExplain(target, opts = {}) {
  const report = buildReport(target);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
}
var AUTHORITY_STALE_SECONDS2, STATUS_COLOR;
var init_agent_explain = __esm({
  "packages/daemon/src/agent-explain.ts"() {
    "use strict";
    init_manifest();
    init_classify();
    init_manifest_loader();
    init_process_tree();
    init_snapshot();
    init_errors2();
    AUTHORITY_STALE_SECONDS2 = 600;
    STATUS_COLOR = {
      blocked: "\x1B[31m",
      // red
      working: "\x1B[33m",
      // yellow
      done: "\x1B[32m",
      // green
      idle: "\x1B[36m",
      // cyan
      unknown: "\x1B[90m"
      // grey
    };
  }
});

// packages/daemon/src/tui/team/wait.ts
var wait_exports = {};
__export(wait_exports, {
  WAIT_DEFAULT_TIMEOUT_MS: () => WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_OUTPUT_POLL_MS: () => WAIT_OUTPUT_POLL_MS,
  WAIT_STATUS_POLL_MS: () => WAIT_STATUS_POLL_MS,
  matchOutput: () => matchOutput,
  waitForAgentStatus: () => waitForAgentStatus,
  waitForOutputMatch: () => waitForOutputMatch
});
function matchOutput(text, pattern) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (new RegExp(pattern).test(line)) return line;
  }
  if (new RegExp(pattern).test(text)) return lines[lines.length - 1] ?? "";
  return null;
}
async function waitForAgentStatus(session, want, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_STATUS_POLL_MS;
  const tracker = opts.tracker ?? createStatusTracker();
  const list = opts.listSessions ?? listTeamSessions;
  const now = opts.now ?? Date.now;
  const sleep2 = opts.sleep ?? sleepMs3;
  const started = now();
  for (; ; ) {
    const status2 = findSessionStatus(list(tracker), session);
    if (status2 === want) return { ok: true, session, want, status: status2 };
    if (now() - started >= timeoutMs) {
      return { ok: false, session, want, status: status2, timedOutAfterMs: timeoutMs };
    }
    await sleep2(pollMs);
  }
}
async function waitForOutputMatch(target, pattern, opts = {}) {
  new RegExp(pattern);
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_OUTPUT_POLL_MS;
  const capture = opts.capture ?? defaultCapture;
  const now = opts.now ?? Date.now;
  const sleep2 = opts.sleep ?? sleepMs3;
  const started = now();
  for (; ; ) {
    let text = "";
    try {
      text = capture(target);
    } catch {
    }
    const matched = matchOutput(text, pattern);
    if (matched !== null) return { ok: true, target, pattern, matched };
    if (now() - started >= timeoutMs) {
      return { ok: false, target, pattern, matched: null, timedOutAfterMs: timeoutMs };
    }
    await sleep2(pollMs);
  }
}
function defaultCapture(target) {
  return capturePane(target, { lines: 200 });
}
var WAIT_DEFAULT_TIMEOUT_MS, WAIT_STATUS_POLL_MS, WAIT_OUTPUT_POLL_MS, sleepMs3;
var init_wait = __esm({
  "packages/daemon/src/tui/team/wait.ts"() {
    "use strict";
    init_src();
    init_classify();
    init_report();
    init_sessions2();
    WAIT_DEFAULT_TIMEOUT_MS = 6e4;
    WAIT_STATUS_POLL_MS = 750;
    WAIT_OUTPUT_POLL_MS = 500;
    sleepMs3 = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// packages/daemon/src/tui/team/home.ts
var ROLLUP_ORDER;
var init_home = __esm({
  "packages/daemon/src/tui/team/home.ts"() {
    "use strict";
    init_grammar();
    init_panels();
    ROLLUP_ORDER = ["blocked", "working", "done", "idle"];
  }
});

// packages/daemon/src/tui/mirror/agent-rows.ts
var STATE_RANK;
var init_agent_rows = __esm({
  "packages/daemon/src/tui/mirror/agent-rows.ts"() {
    "use strict";
    init_home();
    STATE_RANK = (() => {
      const rank = {};
      ROLLUP_ORDER.forEach((s, i) => rank[s] = i);
      rank.unknown = ROLLUP_ORDER.length;
      return rank;
    })();
  }
});

// packages/daemon/src/tui/mirror/agent-lifecycle.ts
function launchCommandFor(kind, manifests) {
  const mapped = AGENT_LAUNCH_COMMANDS[kind];
  if (mapped) return mapped;
  const m = manifests.find((x) => x.id === kind);
  return m?.commands[0] ?? kind;
}
function spawnAgentArgs(placement, target, dir, command2) {
  const cd = dir ? ["-c", dir] : [];
  if (placement === "window") {
    return ["new-window", "-t", `${target.session}:`, ...PRINT_PANE_ID, ...cd, command2];
  }
  const flag = placement === "split-h" ? "-h" : "-v";
  return [
    "split-window",
    flag,
    "-t",
    target.paneId ?? `${target.session}:`,
    ...PRINT_PANE_ID,
    ...cd,
    command2
  ];
}
function spawnSessionArgs(name, dir, command2) {
  return ["new-session", "-d", "-s", name, ...PRINT_PANE_ID, ...dir ? ["-c", dir] : [], command2];
}
function isShellCommand(command2, manifests) {
  const name = command2.replace(/^-/, "").split("/").pop() ?? command2;
  const shell = manifests.find((m) => m.id === "shell");
  return [...shell?.commands ?? [], ...EXTRA_SHELLS].includes(name);
}
function paneHostsShell(startCommand, manifests) {
  const first = startCommand.trim().split(/\s+/)[0] ?? "";
  if (first.length === 0) return true;
  return isShellCommand(first, manifests);
}
function respawnArgs(paneId, command2, dir) {
  return ["respawn-pane", "-k", "-t", paneId, ...dir ? ["-c", dir] : [], command2];
}
function interruptArgs(paneId) {
  return ["send-keys", "-t", paneId, "C-c"];
}
function relaunchArgs(paneId, command2) {
  return [
    ["send-keys", "-t", paneId, "-l", command2],
    ["send-keys", "-t", paneId, "Enter"]
  ];
}
function clearAuthorityArgs(paneId) {
  return [
    ["set-option", "-p", "-t", paneId, "-u", "@agent_state"],
    ["set-option", "-p", "-t", paneId, "-u", "@agent_session_id"]
  ];
}
var AGENT_LAUNCH_COMMANDS, PRINT_PANE_ID, EXTRA_SHELLS, INTERRUPT_TAP_GAP_MS, RESTART_GRACE_MS;
var init_agent_lifecycle = __esm({
  "packages/daemon/src/tui/mirror/agent-lifecycle.ts"() {
    "use strict";
    init_agent_rows();
    AGENT_LAUNCH_COMMANDS = {
      claude: "claude",
      codex: "codex",
      opencode: "opencode",
      gemini: "gemini",
      aider: "aider",
      copilot: "copilot",
      cursor: "cursor-agent",
      goose: "goose",
      amp: "amp"
    };
    PRINT_PANE_ID = ["-P", "-F", "#{pane_id}"];
    EXTRA_SHELLS = ["dash", "ksh", "tcsh", "csh"];
    INTERRUPT_TAP_GAP_MS = 250;
    RESTART_GRACE_MS = 1e3;
  }
});

// packages/daemon/src/control/lifecycle.ts
import { execFile as execFile3 } from "node:child_process";
function tmuxRun(args) {
  return new Promise((resolve24, reject) => {
    execFile3("tmux", args, (err, stdout) => err ? reject(err) : resolve24(stdout.trimEnd()));
  });
}
async function tmuxTry(args) {
  await tmuxRun(args).catch(() => {
  });
}
function resolveLaunchCommand(params) {
  if (params.command) return params.command;
  return launchCommandFor(params.kind, getManifests());
}
async function spawnAgent(params) {
  const dir = params.dir ?? null;
  const argv = params.session ? spawnAgentArgs(
    params.placement ?? "window",
    { session: params.session, paneId: params.paneId },
    dir,
    params.command
  ) : spawnSessionArgs(params.sessionName, dir, params.command);
  const [subcommand, ...rest] = argv;
  let paneId;
  try {
    paneId = await tmuxRun([subcommand, "-P", "-F", "#{pane_id}", ...rest]);
  } catch (err) {
    throw new ControlVerbError("not-found", `tmux refused to spawn: ${err.message}`);
  }
  const session = params.session ?? params.sessionName;
  if (!params.session) await tmuxTry(["set-environment", "-t", session, "TMUX_IDE", "1"]);
  return {
    paneId,
    session,
    command: params.command,
    placement: params.session ? params.placement ?? "window" : "new-session"
  };
}
async function interruptAgent(paneId) {
  await tmuxTry(interruptArgs(paneId));
  await sleep(INTERRUPT_TAP_GAP_MS);
  await tmuxTry(interruptArgs(paneId));
}
async function clearAgentAuthority(paneId) {
  for (const args of clearAuthorityArgs(paneId)) await tmuxTry(args);
}
function paneStartAndPath(paneId) {
  return tmuxRun(["display", "-p", "-t", paneId, "#{pane_start_command}	#{pane_current_path}"]).then((out) => {
    const [start2 = "", path2 = ""] = out.split("	");
    return { start: start2, path: path2 };
  }).catch(() => null);
}
async function stopAgent(paneId) {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  await interruptAgent(paneId);
  await clearAgentAuthority(paneId);
  return { paneId, stopped: true };
}
async function restartAgent(paneId, command2) {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  if (paneHostsShell(live.start, getManifests())) {
    await interruptAgent(paneId);
    await clearAgentAuthority(paneId);
    await sleep(RESTART_GRACE_MS);
    for (const args of relaunchArgs(paneId, command2)) await tmuxTry(args);
    return { paneId, command: command2, strategy: "relaunch" };
  }
  await clearAgentAuthority(paneId);
  await tmuxTry(respawnArgs(paneId, command2, live.path || null));
  return { paneId, command: command2, strategy: "respawn" };
}
var sleep;
var init_lifecycle = __esm({
  "packages/daemon/src/control/lifecycle.ts"() {
    "use strict";
    init_agent_lifecycle();
    init_manifest_loader();
    init_dispatch();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// packages/daemon/src/control/verbs.ts
function parse(schema, params) {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    throw new ControlVerbError("bad-request", `invalid params${at}: ${issue?.message ?? "?"}`);
  }
  return result.data;
}
function createVerbHandlers(ctx) {
  return {
    fleet: () => toFleetJson(listTeamProjects(ctx.tracker)),
    agents: (params) => {
      const p = parse(agentsParamsSchema, params);
      const sessions = listTeamSessions(ctx.tracker);
      const scoped = p.session ? sessions.filter((s) => s.name === p.session) : sessions;
      if (p.session && scoped.length === 0) {
        throw new ControlVerbError("not-found", `no session "${p.session}"`);
      }
      return { agents: scoped.flatMap((s) => s.agents ?? []) };
    },
    send: (params) => {
      const p = parse(sendParamsSchema, params);
      return deliverMessage(p);
    },
    wait: async (params) => {
      const p = parse(waitParamsSchema, params);
      if (p.kind === "output") {
        try {
          new RegExp(p.match);
        } catch (err) {
          throw new ControlVerbError(
            "bad-request",
            `invalid match regex: ${err.message}`
          );
        }
      }
      const result = p.kind === "agent-status" ? await waitForAgentStatus(p.session, p.status, { timeoutMs: p.timeoutMs }) : await waitForOutputMatch(p.target, p.match, { timeoutMs: p.timeoutMs });
      if (!result.ok) {
        const what = p.kind === "agent-status" ? `"${p.session}" to reach status "${p.status}"` : `${p.target} output to match /${p.match}/`;
        throw new ControlVerbError(
          "timeout",
          `timed out after ${result.timedOutAfterMs}ms waiting for ${what}`
        );
      }
      return result;
    },
    spawn: (params) => {
      const p = parse(spawnParamsSchema, params);
      return spawnAgent({ ...p, command: resolveLaunchCommand(p) });
    },
    "restart-agent": (params) => {
      const p = parse(restartAgentParamsSchema, params);
      return restartAgent(p.paneId, resolveLaunchCommand(p));
    },
    "stop-agent": (params) => {
      const p = parse(stopAgentParamsSchema, params);
      return stopAgent(p.paneId);
    },
    explain: (params) => {
      const p = parse(explainParamsSchema, params);
      return buildReport(p.target);
    },
    subscribe: (_params, verbCtx) => {
      verbCtx.subscribe();
      return { subscribed: true, events: ["agent-status"] };
    }
  };
}
var init_verbs = __esm({
  "packages/daemon/src/control/verbs.ts"() {
    "use strict";
    init_src2();
    init_agent_explain();
    init_send();
    init_report();
    init_projects();
    init_sessions2();
    init_wait();
    init_dispatch();
    init_lifecycle();
  }
});

// packages/daemon/src/control/server.ts
var server_exports2 = {};
__export(server_exports2, {
  defaultControlSocketPath: () => defaultControlSocketPath,
  startControlServer: () => startControlServer
});
import { chmodSync as chmodSync4, existsSync as existsSync32, mkdirSync as mkdirSync17, statSync as statSync5, unlinkSync } from "node:fs";
import { createServer as createServer2, connect } from "node:net";
import { dirname as dirname21, join as join25 } from "node:path";
function defaultControlSocketPath() {
  return join25(tuiStateHome(), "control.sock");
}
async function claimSocketPath(path2) {
  if (!existsSync32(path2)) return;
  if (!statSync5(path2).isSocket()) {
    throw new IdeError(
      `${path2} exists and is not a socket \u2014 refusing to remove it. Pass a different --socket path.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const alive = await new Promise((resolve24) => {
    const probe = connect(path2);
    const done = (result) => {
      probe.destroy();
      resolve24(result);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(500, () => done(false));
  });
  if (alive) {
    throw new IdeError(`another server is already listening on ${path2}`, {
      code: "USAGE",
      exitCode: 1
    });
  }
  unlinkSync(path2);
}
async function startControlServer(opts = {}) {
  const socketPath = opts.socketPath ?? defaultControlSocketPath();
  const log = opts.log ?? (() => {
  });
  const tickMs = opts.tickMs ?? TICK_MS;
  mkdirSync17(dirname21(socketPath), { recursive: true });
  await claimSocketPath(socketPath);
  const tracker = createStatusTracker();
  const handlers = createVerbHandlers({ tracker });
  const prevState = /* @__PURE__ */ new Map();
  let timer = null;
  const tick = () => {
    try {
      const { events, state } = diffFleet(prevState, fleetStatuses(listTeamProjects(tracker)));
      prevState.clear();
      for (const [name, status2] of state) prevState.set(name, status2);
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      for (const ev of events) fanout.emit({ ts, ...ev });
    } catch (err) {
      log(`event tick failed: ${err.message}`);
    }
  };
  const fanout = createFanout({
    onFirst: () => {
      tick();
      timer = setInterval(tick, tickMs);
    },
    onLast: () => {
      if (timer) clearInterval(timer);
      timer = null;
      prevState.clear();
    }
  });
  const connections = /* @__PURE__ */ new Set();
  const server = createServer2((conn) => {
    connections.add(conn);
    conn.setEncoding("utf8");
    const split = createFrameSplitter();
    let unsubscribe = null;
    const push = (ev) => {
      conn.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, event: "agent-status", data: ev }));
    };
    const ctx = {
      subscribe: () => {
        unsubscribe ??= fanout.add(push);
      }
    };
    conn.on("data", (chunk) => {
      let lines;
      try {
        lines = split(chunk);
      } catch {
        conn.destroy();
        return;
      }
      for (const line of lines) {
        void dispatchLine(line, handlers, ctx).then((response) => {
          if (!conn.destroyed) conn.write(encodeFrame(response));
        });
      }
    });
    conn.on("close", () => {
      unsubscribe?.();
      connections.delete(conn);
    });
    conn.on("error", () => {
    });
  });
  await new Promise((resolve24, reject) => {
    server.once("error", (err) => {
      if ((err.code === "EINVAL" || err.code === "ENAMETOOLONG") && socketPath.length > 100) {
        reject(
          new IdeError(
            `socket path is too long for a Unix socket (${socketPath.length} chars; the OS caps it around 104): ${socketPath}
Pass a shorter path: tmux-ide serve --socket /tmp/tmux-ide-control.sock`,
            { code: "USAGE", exitCode: 1 }
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(socketPath, () => {
      server.removeAllListeners("error");
      resolve24();
    });
  });
  chmodSync4(socketPath, 384);
  log(`listening on ${socketPath}`);
  return {
    socketPath,
    close: () => new Promise((resolve24) => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const conn of connections) conn.destroy();
      server.close(() => {
        try {
          unlinkSync(socketPath);
        } catch {
        }
        resolve24();
      });
    })
  };
}
var init_server2 = __esm({
  "packages/daemon/src/control/server.ts"() {
    "use strict";
    init_src2();
    init_errors2();
    init_tui_binary();
    init_classify();
    init_events();
    init_updater();
    init_projects();
    init_dispatch();
    init_fanout();
    init_frames();
    init_verbs();
  }
});

// packages/daemon/src/control/client.ts
var client_exports = {};
__export(client_exports, {
  ControlRequestError: () => ControlRequestError,
  connectControl: () => connectControl
});
import { connect as connect2 } from "node:net";
function connectControl(opts = {}) {
  const path2 = opts.socketPath ?? defaultControlSocketPath();
  return new Promise((resolve24, reject) => {
    const socket = connect2(path2);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve24(wrap(socket));
    });
  });
}
function wrap(socket) {
  socket.setEncoding("utf8");
  const split = createFrameSplitter();
  const pending = /* @__PURE__ */ new Map();
  const eventSinks = [];
  let nextId = 1;
  let markDone;
  const done = new Promise((r) => {
    markDone = r;
  });
  socket.on("data", (chunk) => {
    for (const line of split(chunk)) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const event = controlEventSchema.safeParse(raw);
      if (event.success) {
        for (const sink of eventSinks) sink(event.data);
        continue;
      }
      const response = controlResponseSchema.safeParse(raw);
      if (!response.success || response.data.id === null) continue;
      const waiter = pending.get(response.data.id);
      if (!waiter) continue;
      pending.delete(response.data.id);
      if (response.data.ok) waiter.resolve(response.data.data);
      else {
        waiter.reject(
          new ControlRequestError(response.data.error.code, response.data.error.message)
        );
      }
    }
  });
  const teardown = () => {
    for (const { reject } of pending.values()) {
      reject(new ControlRequestError("disconnected", "control socket closed"));
    }
    pending.clear();
    markDone();
  };
  socket.on("close", teardown);
  socket.on("error", () => {
  });
  const request = (verb, params) => {
    const id = nextId++;
    return new Promise((resolve24, reject) => {
      if (socket.destroyed) {
        reject(new ControlRequestError("disconnected", "control socket closed"));
        return;
      }
      pending.set(id, { resolve: resolve24, reject });
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, verb, params }));
    });
  };
  return {
    request,
    subscribe: async (onEvent) => {
      eventSinks.push(onEvent);
      await request("subscribe");
    },
    close: () => socket.destroy(),
    done
  };
}
var ControlRequestError;
var init_client = __esm({
  "packages/daemon/src/control/client.ts"() {
    "use strict";
    init_src2();
    init_frames();
    init_server2();
    ControlRequestError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
  }
});

// packages/daemon/src/lib/worktree.ts
var worktree_exports = {};
__export(worktree_exports, {
  WorktreeError: () => WorktreeError,
  _setGitRunnerForTests: () => _setGitRunnerForTests,
  createWorktree: () => createWorktree,
  defaultWorktreeBaseDir: () => defaultWorktreeBaseDir,
  listWorktrees: () => listWorktrees,
  mapWorktreeError: () => mapWorktreeError,
  parseWorktreeList: () => parseWorktreeList,
  removeWorktree: () => removeWorktree,
  worktreePath: () => worktreePath,
  worktreeSessionName: () => worktreeSessionName
});
import { execFileSync as execFileSync13 } from "node:child_process";
import { basename as basename9, dirname as dirname22, isAbsolute as isAbsolute6, join as join26, resolve as resolve22 } from "node:path";
function sanitizeForTmux(part) {
  return part.replace(/[.:/\s]+/g, "-");
}
function worktreeSessionName(project, branch) {
  return `${sanitizeForTmux(project)}@${sanitizeForTmux(branch)}`;
}
function defaultWorktreeBaseDir(repoDir) {
  const abs = resolve22(repoDir);
  return join26(dirname22(abs), `${basename9(abs)}-worktrees`);
}
function worktreePath(repoDir, branch, configuredDir) {
  const base = configuredDir && configuredDir.length > 0 ? isAbsolute6(configuredDir) ? configuredDir : resolve22(repoDir, configuredDir) : defaultWorktreeBaseDir(repoDir);
  return join26(base, branch);
}
function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}
function mapWorktreeError(stderr, fallbackMessage) {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  if (lower.includes("not a git repository")) {
    return new WorktreeError(
      "Not a git repository. Run `tmux-ide worktree` from inside a git repo.",
      "NOT_A_GIT_REPO"
    );
  }
  if (lower.includes("already exists") && lower.includes("branch")) {
    return new WorktreeError(
      `${text}
Use \`tmux-ide worktree create <branch>\` without --from to check out the existing branch, or pick a new name.`,
      "BRANCH_EXISTS"
    );
  }
  if (lower.includes("is already checked out") || lower.includes("already used by worktree")) {
    return new WorktreeError(text, "ALREADY_CHECKED_OUT");
  }
  if (lower.includes("already exists")) {
    return new WorktreeError(text, "WORKTREE_EXISTS");
  }
  if ((lower.includes("invalid reference") || lower.includes("not a valid ref")) && !lower.includes("already")) {
    return new WorktreeError(text, "BRANCH_NOT_FOUND");
  }
  if (lower.includes("contains modified or untracked files") || lower.includes("use --force") || lower.includes("use 'remove -f'")) {
    return new WorktreeError(
      `${text}
Re-run with --force to discard those changes.`,
      "WORKTREE_DIRTY"
    );
  }
  if (lower.includes("is not a working tree") || lower.includes("not a working tree")) {
    return new WorktreeError(text, "WORKTREE_NOT_FOUND");
  }
  return new WorktreeError(text.length > 0 ? text : fallbackMessage, "GIT_FAILED");
}
function _setGitRunnerForTests(fn) {
  const prev = gitRunner;
  gitRunner = fn;
  return () => {
    gitRunner = prev;
  };
}
function runGit(repoDir, args, fallbackMessage) {
  try {
    return gitRunner(repoDir, args);
  } catch (error) {
    const stderr = error.stderr;
    const text = stderr ? stderr.toString() : "";
    throw mapWorktreeError(text, fallbackMessage);
  }
}
function createWorktree(repoDir, branch, worktreeAbsPath, options = {}) {
  const args = ["worktree", "add"];
  if (options.newBranch) {
    args.push("-b", branch, worktreeAbsPath);
    if (options.from && options.from.length > 0) args.push(options.from);
  } else {
    args.push(worktreeAbsPath, branch);
  }
  runGit(repoDir, args, `Failed to create worktree for ${branch}`);
  return worktreeAbsPath;
}
function removeWorktree(repoDir, worktreeAbsPath, options = {}) {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreeAbsPath);
  runGit(repoDir, args, `Failed to remove worktree ${worktreeAbsPath}`);
}
function listWorktrees(repoDir) {
  const out = runGit(repoDir, ["worktree", "list", "--porcelain"], "Failed to list worktrees");
  return parseWorktreeList(out);
}
var WorktreeError, gitRunner;
var init_worktree = __esm({
  "packages/daemon/src/lib/worktree.ts"() {
    "use strict";
    init_errors2();
    WorktreeError = class extends IdeError {
      constructor(message, code) {
        super(message, { code, exitCode: 1 });
        this.name = "WorktreeError";
      }
    };
    gitRunner = (repoDir, args) => execFileSync13("git", args, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
});

// packages/daemon/src/lib/update.ts
var update_exports = {};
__export(update_exports, {
  UPDATE_COMMANDS: () => UPDATE_COMMANDS,
  detectPackageManager: () => detectPackageManager,
  findGitCheckoutRoot: () => findGitCheckoutRoot,
  planUpdate: () => planUpdate,
  renderPlan: () => renderPlan,
  runUpdate: () => runUpdate
});
import { execSync as execSync4 } from "node:child_process";
import { existsSync as existsSync33 } from "node:fs";
import { dirname as dirname23, join as join27 } from "node:path";
function detectPackageManager(cliPath) {
  const p = cliPath.toLowerCase();
  if (/(^|\/)\.?bun(\/|$)/.test(p)) return "bun";
  if (p.includes("pnpm")) return "pnpm";
  return "npm";
}
function planUpdate(input) {
  if (input.gitRoot) {
    return { method: "dev", command: null, reason: `git checkout at ${input.gitRoot}` };
  }
  const pm = detectPackageManager(input.cliPath);
  return {
    method: pm,
    command: UPDATE_COMMANDS[pm],
    reason: `global ${pm} install (${input.cliPath})`
  };
}
function renderPlan(plan, { current, latest, dryRun }) {
  const lines = [];
  if (latest && isNewer(latest, current)) {
    lines.push(`tmux-ide v${current} \u2192 v${latest} available`);
  } else if (latest) {
    lines.push(`tmux-ide v${current} is up to date (registry: v${latest})`);
  } else {
    lines.push(`tmux-ide v${current} (latest version unknown \u2014 run \`tmux-ide doctor\`)`);
  }
  lines.push("");
  if (plan.method === "dev") {
    lines.push("Detected a cloned checkout \u2014 update with git:");
    lines.push("  git pull");
    lines.push(`  (${plan.reason})`);
  } else {
    const verb = dryRun ? "Would run" : "Running";
    lines.push(`Detected a global ${plan.method} install \u2014 ${verb}:`);
    lines.push(`  ${plan.command}`);
  }
  lines.push("");
  lines.push("After updating, refresh the dock so it runs the new code:");
  lines.push("  tmux kill-session -t _tmux-ide-chrome   # stop the old updater");
  lines.push("  tmux-ide adopt <session>                # re-adopt to relaunch it");
  return lines.join("\n");
}
function findGitCheckoutRoot(startDir) {
  let dir = startDir;
  for (; ; ) {
    if (existsSync33(join27(dir, ".git"))) return dir;
    const parent = dirname23(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function runUpdate({ cliDir, dryRun }) {
  const current = getCurrentVersion();
  const { latest } = getUpdateStatus({ currentVersion: current });
  const gitRoot = findGitCheckoutRoot(cliDir);
  const plan = planUpdate({ cliPath: cliDir, gitRoot });
  console.log(renderPlan(plan, { current, latest, dryRun }));
  if (!dryRun && plan.command) {
    console.log("");
    execSync4(plan.command, { stdio: "inherit" });
  }
  return plan;
}
var UPDATE_COMMANDS;
var init_update = __esm({
  "packages/daemon/src/lib/update.ts"() {
    "use strict";
    init_update_check();
    UPDATE_COMMANDS = {
      npm: "npm install -g tmux-ide@latest",
      pnpm: "pnpm add -g tmux-ide@latest",
      bun: "bun add -g tmux-ide@latest"
    };
  }
});

// packages/daemon/src/command-center/index.ts
var command_center_exports = {};
__export(command_center_exports, {
  startCommandCenter: () => startCommandCenter
});
import { createServer as createServer3 } from "node:http";
import { getRequestListener } from "@hono/node-server";
async function startCommandCenter(options = {}) {
  const port = options.port ?? 6060;
  const hostname2 = options.hostname ?? "0.0.0.0";
  const appOpts = {};
  if (options.authService) appOpts.authService = options.authService;
  if (options.authConfig) appOpts.authConfig = options.authConfig;
  const app = createApp(appOpts);
  const listener = getRequestListener(app.fetch);
  const server = createServer3(listener);
  return new Promise((resolve24) => {
    server.listen(port, hostname2, () => {
      console.log(`Command Center API on http://${hostname2}:${port}`);
      resolve24(server);
    });
  });
}
var init_command_center = __esm({
  "packages/daemon/src/command-center/index.ts"() {
    "use strict";
    init_server();
  }
});

// packages/daemon/src/server/index.ts
var server_exports3 = {};
__export(server_exports3, {
  createApp: () => createApp2,
  resolvePort: () => resolvePort,
  start: () => start
});
import { createServer as createServer4 } from "node:http";
import { parse as parse2 } from "node:url";
import { Hono as Hono2 } from "hono";
import { getRequestListener as getRequestListener2 } from "@hono/node-server";
import { WebSocketServer as WebSocketServer3 } from "ws";
function resolvePort(port) {
  const raw = port ?? Number.parseInt(process.env.TMUX_IDE_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`Invalid server port: ${String(port ?? process.env.TMUX_IDE_PORT)}`);
  }
  return raw;
}
function createApp2() {
  const app = new Hono2();
  app.get("/", (c) => c.text("tmux-ide server"));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}
async function start(port) {
  const resolvedPort = resolvePort(port);
  const app = createApp2();
  const server = createServer4(getRequestListener2(app.fetch));
  const ptyWss = new WebSocketServer3({ noServer: true });
  server.on("upgrade", (req, socket, head3) => {
    const { pathname } = parse2(req.url ?? "/", true);
    const match = pathname?.match(/^\/ws\/pty\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    ptyWss.handleUpgrade(req, socket, head3, (ws) => {
      handlePtyWebSocket(ws, id);
    });
  });
  await new Promise((resolve24, reject) => {
    server.once("error", reject);
    server.listen(resolvedPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolve24();
    });
  });
  console.log(`tmux-ide server listening on http://0.0.0.0:${resolvedPort}`);
  return {
    port: resolvedPort,
    server,
    close: () => new Promise((resolve24, reject) => {
      shutdownPtyBridges();
      ptyWss.close();
      server.close((err) => err ? reject(err) : resolve24());
    })
  };
}
var DEFAULT_PORT;
var init_server3 = __esm({
  "packages/daemon/src/server/index.ts"() {
    "use strict";
    init_ws_route();
    DEFAULT_PORT = 6070;
  }
});

// bin/cli.ts
init_launch();
import { parseArgs } from "node:util";
import { resolve as resolve23, dirname as dirname24, join as join28 } from "node:path";
import { execFileSync as execFileSync14 } from "node:child_process";
import { existsSync as existsSync34 } from "node:fs";
import { fileURLToPath as fileURLToPath9 } from "node:url";

// packages/daemon/src/tui/team/entry.ts
function resolveEntry(opts) {
  if (opts.teamFlag) return "cockpit";
  if (opts.hasIdeYml) return "project";
  return opts.frontDoor ? "app" : "cockpit";
}

// bin/cli.ts
init_app_config();
init_compiled();

// packages/daemon/src/init.ts
init_detect();
init_output();
import {
  existsSync as existsSync18,
  readFileSync as readFileSync12,
  writeFileSync as writeFileSync11,
  renameSync as renameSync7,
  mkdirSync as mkdirSync11,
  readdirSync as readdirSync2,
  copyFileSync as copyFileSync2
} from "node:fs";
import { resolve as resolve11, join as join13, basename as basename5, dirname as dirname13 } from "node:path";
import { fileURLToPath as fileURLToPath5 } from "node:url";
var __dirname4 = dirname13(fileURLToPath5(import.meta.url));
function copyTemplateSkills(targetDir) {
  const created = [];
  const templateSkillsDir = resolve11(__dirname4, "..", "..", "..", "templates", "skills");
  if (!existsSync18(templateSkillsDir)) return created;
  mkdirSync11(targetDir, { recursive: true });
  for (const file of readdirSync2(templateSkillsDir)) {
    if (!file.endsWith(".md")) continue;
    const destination = join13(targetDir, file);
    copyFileSync2(join13(templateSkillsDir, file), destination);
    created.push(destination);
  }
  return created;
}
function scaffoldLibraryStubs(dir) {
  const created = [];
  const libraryDir = join13(dir, ".tmux-ide", "library");
  if (!existsSync18(libraryDir)) {
    mkdirSync11(libraryDir, { recursive: true });
    created.push(libraryDir);
  }
  const archPath = join13(libraryDir, "architecture.md");
  if (!existsSync18(archPath)) {
    writeFileSync11(
      archPath,
      "# Architecture\n\n<!-- Describe your project's architecture here. This context is injected into agent dispatch prompts. -->\n"
    );
    created.push(archPath);
  }
  const learningsPath = join13(libraryDir, "learnings.md");
  if (!existsSync18(learningsPath)) {
    writeFileSync11(
      learningsPath,
      "# Learnings\n\n<!-- Task summaries are automatically appended here by the orchestrator. -->\n"
    );
    created.push(learningsPath);
  }
  return created;
}
function scaffoldValidationContract(dir) {
  const created = [];
  const tasksDir = join13(dir, ".tasks");
  if (!existsSync18(tasksDir)) {
    mkdirSync11(tasksDir, { recursive: true });
  }
  const contractPath = join13(tasksDir, "validation-contract.md");
  if (!existsSync18(contractPath)) {
    writeFileSync11(
      contractPath,
      "# Validation Contract\n\n<!-- Define assertions that the validator agent will verify. Example: -->\n<!-- - VAL-001: All tests pass -->\n<!-- - VAL-002: No TypeScript errors -->\n<!-- - VAL-003: Lint passes with zero warnings -->\n"
    );
    created.push(contractPath);
  }
  return created;
}
function scaffoldAgentsMd(dir, name) {
  const created = [];
  const agentsTemplatePath = resolve11(__dirname4, "..", "..", "..", "templates", "AGENTS.md");
  if (existsSync18(agentsTemplatePath)) {
    const agentsPath = join13(dir, "AGENTS.md");
    if (!existsSync18(agentsPath)) {
      const content = readFileSync12(agentsTemplatePath, "utf-8").replace(/{{name}}/g, name);
      writeFileSync11(agentsPath, content);
      created.push(agentsPath);
    }
  }
  return created;
}
function isTeamTemplate(templateName) {
  return templateName === "missions" || templateName.startsWith("agent-team");
}
function scaffoldTeamWorkspace(dir, name) {
  const created = [];
  created.push(...scaffoldLibraryStubs(dir));
  created.push(...scaffoldValidationContract(dir));
  created.push(...scaffoldAgentsMd(dir, name));
  return created;
}
function scaffoldMissionsWorkspace(dir, name) {
  const created = [];
  const skillsDir = join13(dir, ".tmux-ide", "skills");
  created.push(...copyTemplateSkills(skillsDir));
  created.push(...scaffoldTeamWorkspace(dir, name));
  return created;
}
async function init({
  template,
  json: json2
} = {}) {
  const dir = process.cwd();
  const configPath = resolve11(dir, "ide.yml");
  if (existsSync18(configPath)) {
    outputError("ide.yml already exists in this directory", "EXISTS");
  }
  if (template) {
    const templatePath = resolve11(__dirname4, "..", "..", "..", "templates", `${template}.yml`);
    if (!existsSync18(templatePath)) {
      outputError(`Template "${template}" not found`, "NOT_FOUND");
    }
    let content = readFileSync12(templatePath, "utf-8");
    const name2 = basename5(dir);
    content = content.replace(/^name: .+/m, `name: ${name2}`);
    const tmpPath = configPath + ".tmp";
    writeFileSync11(tmpPath, content);
    renameSync7(tmpPath, configPath);
    let created;
    if (template === "missions") {
      created = scaffoldMissionsWorkspace(dir, name2);
    } else if (isTeamTemplate(template)) {
      created = [
        ...copyTemplateSkills(join13(dir, ".tmux-ide", "skills")),
        ...scaffoldTeamWorkspace(dir, name2)
      ];
    } else {
      created = copyTemplateSkills(join13(dir, ".tmux-ide", "skills"));
    }
    if (json2) {
      console.log(JSON.stringify({ created: true, template, name: name2, paths: created }));
    } else {
      console.log(`Created ide.yml from "${template}" template for "${name2}"`);
      const yaml3 = (await import("js-yaml")).default;
      printLayout(yaml3.load(content));
      for (const createdPath of created) {
        console.log(`Created ${createdPath.replace(dir + "/", "")}`);
      }
    }
    return;
  }
  const detected = detectStack(dir);
  const name = basename5(dir);
  if (detected.frameworks.length > 0) {
    const config2 = suggestConfig(dir, detected);
    const yaml3 = (await import("js-yaml")).default;
    const tmpPath2 = configPath + ".tmp";
    writeFileSync11(tmpPath2, yaml3.dump(config2, { lineWidth: -1, noRefs: true, quotingType: '"' }));
    renameSync7(tmpPath2, configPath);
    const desc = detected.frameworks.join(" + ");
    if (json2) {
      console.log(JSON.stringify({ created: true, detected: detected.frameworks, name }));
    } else {
      console.log(`Detected ${desc}. Created ide.yml for "${name}".`);
      printLayout(config2);
      console.log("Edit it to customize, then run: tmux-ide");
    }
  } else {
    const templatePath = resolve11(__dirname4, "..", "..", "..", "templates", "default.yml");
    let content = readFileSync12(templatePath, "utf-8");
    content = content.replace(/^name: .+/m, `name: ${name}`);
    const tmpPath3 = configPath + ".tmp";
    writeFileSync11(tmpPath3, content);
    renameSync7(tmpPath3, configPath);
    if (json2) {
      console.log(JSON.stringify({ created: true, template: "default", name }));
    } else {
      console.log(`Created ide.yml for "${name}"`);
      const yaml3 = (await import("js-yaml")).default;
      printLayout(yaml3.load(content));
      console.log("Edit it to configure your workspace, then run: tmux-ide");
    }
  }
  const skillsDir = join13(dir, ".tmux-ide", "skills");
  if (!existsSync18(skillsDir)) {
    const created = copyTemplateSkills(skillsDir);
    if (created.length > 0 && !json2) {
      console.log("Copied built-in skill templates to .tmux-ide/skills/");
    }
  }
}

// packages/daemon/src/stop.ts
init_yaml_io();
init_output();
init_src();
import { resolve as resolve12 } from "node:path";
async function stop(targetDir, { json: json2 } = {}) {
  const dir = resolve12(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  stopSessionMonitor(session);
  const result = killSession(session);
  if (result.stopped) {
    if (json2) {
      console.log(JSON.stringify({ stopped: session }));
    } else {
      console.log(`Stopped session "${session}"`);
    }
    return;
  }
  outputError(`No active session "${session}" found`, "NOT_RUNNING");
}

// packages/daemon/src/attach.ts
init_yaml_io();
init_output();
init_src();
import { resolve as resolve13 } from "node:path";
async function attach(targetDir, { json: _json } = {}) {
  const dir = resolve13(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const state = getSessionState(session);
  if (!state.running) {
    outputError(`Session "${session}" is not running. Start it with: tmux-ide`, "NOT_RUNNING");
    return;
  }
  attachSession(session);
}

// packages/daemon/src/ls.ts
import { execSync as execSync2 } from "node:child_process";
async function ls({ json: json2 } = {}) {
  let raw;
  try {
    raw = execSync2(
      'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}"',
      { encoding: "utf-8" }
    ).trim();
  } catch {
    if (json2) {
      console.log(JSON.stringify({ sessions: [] }));
    } else {
      console.log("No tmux sessions running.");
    }
    return;
  }
  const sessions = raw.split("\n").map((line) => {
    const [name, created, attached] = line.split("|");
    return {
      name,
      created: new Date(parseInt(created) * 1e3).toISOString(),
      attached: attached !== "0"
    };
  });
  if (json2) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return;
  }
  console.log("SESSION".padEnd(24) + "CREATED".padEnd(22) + "ATTACHED");
  console.log("\u2500".repeat(54));
  for (const s of sessions) {
    const date = new Date(s.created).toLocaleString();
    console.log(s.name.padEnd(24) + date.padEnd(22) + (s.attached ? "yes" : "no"));
  }
}

// packages/daemon/src/doctor.ts
init_update_check();
init_skill_sync();
init_agent_discovery();
init_compiled();
init_claude();
import { execSync as execSync3 } from "node:child_process";
import { accessSync, constants, existsSync as existsSync20 } from "node:fs";
import { resolve as resolve14, dirname as dirname15 } from "node:path";
import { fileURLToPath as fileURLToPath7 } from "node:url";
function agentIntegrationRows(agents) {
  return presentAgents(agents).map((agent) => {
    const label = `agent: ${agent.id}`;
    if (agent.integration) {
      return agent.installed ? { label, pass: true, detail: "integration installed \u2713", optional: true } : {
        label,
        pass: false,
        detail: `found on PATH \u2014 run \`tmux-ide integration install ${agent.id}\` for ground-truth status`,
        optional: true
      };
    }
    return {
      label,
      pass: true,
      detail: "found \u2014 screen-manifest detection active (no lifecycle integration yet)",
      optional: true
    };
  });
}
function hooksTargetRow(facts) {
  const label = "Claude hooks target writable";
  if (facts.writable) {
    return {
      label,
      pass: true,
      detail: facts.fileExists ? facts.settingsPath : `${facts.settingsPath} (will be created)`,
      optional: true
    };
  }
  return {
    label,
    pass: false,
    detail: `cannot write ${facts.settingsPath} \u2014 fix its permissions (chown/chmod), or point TMUX_IDE_CLAUDE_SETTINGS at a writable path`,
    optional: true
  };
}
function check(label, fn, { optional = false } = {}) {
  try {
    const result = fn();
    return { label, pass: true, detail: result, optional };
  } catch (e) {
    return { label, pass: false, detail: e.message, optional };
  }
}
async function doctor({
  json: json2
} = {}) {
  const checks = [];
  checks.push(
    check("tmux installed", () => {
      try {
        execSync3("which tmux", { stdio: "ignore" });
      } catch {
        throw new Error(
          "not found on PATH \u2014 install it (macOS: `brew install tmux`; Debian/Ubuntu: `sudo apt install tmux`)"
        );
      }
      return "found";
    })
  );
  checks.push(
    check("tmux version \u2265 3.0", () => {
      const version = execSync3("tmux -V", { encoding: "utf-8" }).trim();
      const num = parseFloat(version.replace(/[^0-9.]/g, ""));
      if (num < 3) throw new Error(`${version} (need \u2265 3.0)`);
      return version;
    })
  );
  checks.push(
    check("Node.js \u2265 18", () => {
      const major = parseInt(process.versions.node.split(".")[0]);
      if (major < 18) throw new Error(`Node ${process.versions.node} (need \u2265 18)`);
      return `v${process.versions.node}`;
    })
  );
  checks.push(
    check(
      "256-color terminal",
      () => {
        const term = process.env.TERM ?? "";
        if (!term.includes("256color") && !term.includes("ghostty") && !term.includes("kitty") && term !== "tmux-256color") {
          throw new Error(`$TERM is "${term}"`);
        }
        return term;
      },
      { optional: true }
    )
  );
  checks.push(
    check("ide.yml exists", () => {
      const path2 = resolve14(".", "ide.yml");
      if (!existsSync20(path2)) throw new Error("not found in current directory");
      return "found";
    })
  );
  checks.push(
    check(
      "TUI surfaces (cockpit / widgets)",
      () => {
        const here = dirname15(fileURLToPath7(import.meta.url));
        const checkoutEntry = [
          resolve14(here, "../packages/daemon/src/tui/team/index.tsx"),
          resolve14(here, "tui/team/index.tsx")
        ].find(existsSync20);
        const binary = findCompiledTui();
        if (checkoutEntry && isBunAvailable()) return "dev checkout (bun)";
        if (binary) return `compiled binary (${binary})`;
        throw new Error(
          "no dev checkout+bun and no compiled binary \u2014 build one with `pnpm build:tui` or install a release that ships it"
        );
      },
      { optional: true }
    )
  );
  checks.push(
    check(
      "Claude Code agent teams",
      () => {
        if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
          throw new Error("not set (enable with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)");
        }
        return "enabled";
      },
      { optional: true }
    )
  );
  const tunnelCli = (label, cmd) => check(
    label,
    () => {
      try {
        return execSync3(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0];
      } catch {
        throw new Error("not found (optional \u2014 used for remote access tunnels)");
      }
    },
    { optional: true }
  );
  checks.push(tunnelCli("tailscale CLI", "tailscale version"));
  checks.push(tunnelCli("ngrok CLI", "ngrok version"));
  checks.push(tunnelCli("cloudflared CLI", "cloudflared --version"));
  checks.push(
    (() => {
      const settingsPath = claudeSettingsPath();
      const fileExists2 = existsSync20(settingsPath);
      let probe = fileExists2 ? settingsPath : dirname15(settingsPath);
      while (!existsSync20(probe)) {
        const parent = dirname15(probe);
        if (parent === probe) break;
        probe = parent;
      }
      let writable = false;
      try {
        accessSync(probe, constants.W_OK);
        writable = true;
      } catch {
      }
      return hooksTargetRow({ settingsPath, fileExists: fileExists2, writable });
    })()
  );
  checks.push(
    check(
      "tmux-ide up to date",
      () => {
        const current = getCurrentVersion();
        const { latest, updateAvailable } = getUpdateStatus({ currentVersion: current });
        if (updateAvailable) {
          throw new Error(`v${current} \u2014 v${latest} available (run \`tmux-ide update\`)`);
        }
        return latest ? `v${current} (latest)` : `v${current} (latest unknown)`;
      },
      { optional: true }
    )
  );
  checks.push(
    check(
      "Claude Code skill",
      () => {
        const installed = installedSkillVersion();
        const current = getCurrentVersion();
        if (installed === null) {
          throw new Error("not installed \u2014 run `tmux-ide skill-sync`");
        }
        if (installed !== current) {
          throw new Error(`v${installed} (CLI v${current}) \u2014 run \`tmux-ide skill-sync\``);
        }
        return `in sync (v${installed})`;
      },
      { optional: true }
    )
  );
  checks.push(...agentIntegrationRows(discoverAgents()));
  const allPass = checks.every((c) => c.pass || c.optional);
  if (json2) {
    console.log(JSON.stringify({ ok: allPass, checks }, null, 2));
    return;
  }
  for (const c of checks) {
    const icon = c.pass ? "\u2713" : c.optional ? "\u25CB" : "\u2717";
    const color2 = c.pass ? "\x1B[32m" : c.optional ? "\x1B[33m" : "\x1B[31m";
    console.log(`${color2}${icon}\x1B[0m ${c.label} \u2014 ${c.detail}`);
  }
  if (!allPass) process.exitCode = 1;
}

// packages/daemon/src/status.ts
init_yaml_io();
init_src();
init_canonical_daemon();
import { resolve as resolve15 } from "node:path";
import { existsSync as existsSync21 } from "node:fs";
async function status(targetDir, { json: json2 } = {}) {
  const dir = resolve15(targetDir ?? ".");
  const { name: session } = getSessionName(dir);
  const configExists = existsSync21(resolve15(dir, "ide.yml"));
  const state = getSessionState(session);
  const running = state.running;
  let panes = [];
  if (running) panes = listPanes(session);
  const daemonInfo = readCanonicalDaemonInfo();
  const healthy = daemonInfo ? await isCanonicalDaemonAlive(daemonInfo) : false;
  const data = {
    session,
    running,
    configExists,
    panes,
    daemon: {
      pid: daemonInfo?.pid ?? null,
      alive: daemonInfo ? isProcessAlive(daemonInfo.pid) : false,
      port: daemonInfo?.port ?? null,
      healthy
    }
  };
  if (json2) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Session: ${session}`);
  console.log(`Running: ${running ? "yes" : "no"}`);
  console.log(`Config:  ${configExists ? "ide.yml found" : "no ide.yml"}`);
  if (running) {
    console.log(
      `Daemon:  ${data.daemon.alive ? "running" : "not running"}${data.daemon.port ? ` (port ${data.daemon.port})` : ""}`
    );
  }
  if (panes.length > 0) {
    console.log(`
Panes:`);
    for (const p of panes) {
      const active2 = p.active ? " (active)" : "";
      console.log(`  ${p.index}: ${p.title} [${p.width}x${p.height}]${active2}`);
    }
  }
}

// packages/daemon/src/inspect.ts
init_yaml_io();
init_validate();
init_output();
init_src();
import { resolve as resolve16, basename as basename6 } from "node:path";
function buildInspection(dir, {
  config: config2,
  configPath,
  running,
  panes
}) {
  const errors = validateConfig(config2);
  const rows = Array.isArray(config2?.rows) ? config2.rows : [];
  const resolvedRows = rows.map((row, rowIndex) => ({
    index: rowIndex,
    size: row.size ?? null,
    panes: (Array.isArray(row?.panes) ? row.panes : []).map((pane, paneIndex) => ({
      index: paneIndex,
      title: pane.title ?? null,
      command: pane.command ?? null,
      dir: pane.dir ?? ".",
      size: pane.size ?? null,
      focus: pane.focus === true,
      role: pane.role ?? null,
      task: pane.task ?? null,
      env: pane.env ?? {}
    }))
  }));
  const focusPane = resolvedRows.flatMap((row) => row.panes.map((pane) => ({ row: row.index, pane }))).find(({ pane }) => pane.focus) ?? null;
  const session = config2?.name ?? basename6(dir);
  return {
    dir,
    configPath,
    valid: errors.length === 0,
    errors,
    session,
    before: config2?.before ?? null,
    summary: {
      rows: resolvedRows.length,
      panes: resolvedRows.reduce((sum, row) => sum + row.panes.length, 0),
      focus: focusPane ? `rows.${focusPane.row}.panes.${focusPane.pane.index}` : null
    },
    team: config2?.team ?? null,
    theme: config2?.theme ?? null,
    focus: focusPane ? {
      row: focusPane.row,
      pane: focusPane.pane.index,
      title: focusPane.pane.title
    } : null,
    rows: resolvedRows,
    rawConfig: config2,
    tmux: {
      running,
      panes
    }
  };
}
async function inspect(targetDir, { json: json2 } = {}) {
  const dir = resolve16(targetDir ?? ".");
  let config2;
  let configPath;
  try {
    ({ config: config2, configPath } = readConfig(dir));
  } catch (error) {
    outputError(`Cannot read ide.yml: ${error.message}`, "READ_ERROR");
    return;
  }
  const session = config2?.name ?? basename6(dir);
  const state = getSessionState(session);
  const panes = state.running ? listPanes(session) : [];
  const data = buildInspection(dir, { config: config2, configPath, running: state.running, panes });
  if (json2) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Directory: ${data.dir}`);
  console.log(`Config:    ${data.configPath}`);
  console.log(`Valid:     ${data.valid ? "yes" : "no"}`);
  console.log(`Session:   ${data.session}`);
  console.log(`Running:   ${data.tmux.running ? "yes" : "no"}`);
  console.log(`Rows:      ${data.summary.rows}`);
  console.log(`Panes:     ${data.summary.panes}`);
  console.log(`Team:      ${data.team ? data.team.name : "disabled"}`);
  if (data.focus) {
    console.log(
      `Focus:     row ${data.focus.row}, pane ${data.focus.pane}${data.focus.title ? ` (${data.focus.title})` : ""}`
    );
  }
  if (!data.valid) {
    console.log("\nValidation Errors:");
    for (const error of data.errors) {
      console.log(`  - ${error}`);
    }
  }
  console.log("\nResolved Layout:");
  for (const row of data.rows) {
    console.log(`  Row ${row.index}${row.size ? ` (${row.size})` : ""}`);
    for (const pane of row.panes) {
      const parts = [];
      if (pane.title) parts.push(pane.title);
      if (pane.command) parts.push(`cmd=${pane.command}`);
      if (pane.dir && pane.dir !== ".") parts.push(`dir=${pane.dir}`);
      if (pane.role) parts.push(`role=${pane.role}`);
      if (pane.focus) parts.push("focus");
      console.log(`    - pane ${pane.index}: ${parts.join(" | ") || "shell"}`);
    }
  }
  if (data.tmux.running && data.tmux.panes.length > 0) {
    console.log("\nLive Panes:");
    for (const pane of data.tmux.panes) {
      const active2 = pane.active ? " (active)" : "";
      console.log(`  ${pane.index}: ${pane.title} [${pane.width}x${pane.height}]${active2}`);
    }
  }
}

// bin/cli.ts
init_validate();
init_detect();
init_config();
init_restart();

// packages/daemon/src/restore.ts
init_src();
init_app_config();
init_errors2();
init_project_registry();
init_statusline();
init_snapshot2();
function buildRestorePlan(snapshot, liveSessionNames, ideProjects = /* @__PURE__ */ new Map()) {
  const live = new Set(liveSessionNames);
  const actions = [];
  let paneCount = 0;
  for (const session of snapshot.sessions) {
    if (live.has(session.name)) {
      actions.push({ kind: "skip", session: session.name });
      continue;
    }
    const dir = ideProjects.get(session.name);
    if (dir) {
      actions.push({ kind: "launch", session: session.name, dir });
      continue;
    }
    actions.push({ kind: "rebuild", session });
    for (const window of session.windows) paneCount += window.panes.length;
  }
  return { actions, paneCount };
}
var SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
var AGENT_RESUME_COMMANDS = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  opencode: (id) => `opencode --session ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  copilot: (id) => `copilot --resume=${id}`
};
function paneResumeCommand(pane, opts) {
  if (!opts.resumeAgents) return null;
  const resume = pane.agent ? AGENT_RESUME_COMMANDS[pane.agent] : void 0;
  if (!resume) return null;
  const id = pane.agentSessionId;
  if (!id || !SAFE_SESSION_ID.test(id)) return null;
  return resume(id);
}
function countResumableAgents(session, resumeAgents) {
  let n = 0;
  for (const window of session.windows) {
    for (const pane of window.panes) {
      if (paneResumeCommand(pane, { resumeAgents })) n++;
    }
  }
  return n;
}
function readRestorePrefs() {
  return loadAppConfig().restore;
}
function tmuxCapture(args) {
  return runTmux(args, { encoding: "utf-8" }).toString().trim();
}
function rebuildSession(session, opts) {
  const { runCommands, resumeAgents } = opts;
  const resumedTitles = [];
  const windows = session.windows;
  if (windows.length === 0) {
    runTmux(["new-session", "-d", "-s", session.name, "-c", session.cwd]);
    return resumedTitles;
  }
  windows.forEach((window, w) => {
    const windowCwd = window.panes[0]?.cwd || session.cwd;
    const windowId = w === 0 ? tmuxCapture([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-s",
      session.name,
      "-c",
      windowCwd
    ]) : tmuxCapture([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      `${session.name}:`,
      "-c",
      windowCwd
    ]);
    const paneIds = [tmuxCapture(["display-message", "-p", "-t", windowId, "#{pane_id}"])];
    for (let p = 1; p < window.panes.length; p++) {
      const paneCwd = window.panes[p].cwd || windowCwd;
      paneIds.push(
        tmuxCapture([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          paneIds[p - 1],
          "-c",
          paneCwd
        ])
      );
    }
    if (window.layout) runTmux(["select-layout", "-t", windowId, window.layout]);
    if (window.name) runTmux(["rename-window", "-t", windowId, window.name]);
    window.panes.forEach((pane, p) => {
      const paneId = paneIds[p];
      if (!paneId) return;
      if (pane.title) runTmux(["select-pane", "-t", paneId, "-T", pane.title]);
      if (pane.agentSessionId) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_session_id", pane.agentSessionId]);
      }
      if (pane.agent) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_hint", pane.agent]);
      }
      const resumeCmd = paneResumeCommand(pane, { resumeAgents });
      if (resumeCmd) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", resumeCmd]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
        resumedTitles.push(pane.title || paneId);
      } else if (runCommands && pane.command) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", pane.command]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
      }
    });
  });
  const activeIndex = windows.findIndex((w) => w.active);
  if (activeIndex >= 0) {
    runTmux(["select-window", "-t", `${session.name}:${windows[activeIndex].index}`]);
  }
  return resumedTitles;
}
function ideBackedProjects() {
  const map = /* @__PURE__ */ new Map();
  try {
    for (const project of listProjects()) {
      if (project.hasIdeYml && project.dir) map.set(project.name, project.dir);
    }
  } catch {
  }
  return map;
}
function liveSessions() {
  try {
    const raw = tmuxCapture(["list-sessions", "-F", "#{session_name}"]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}
async function restore({
  json: json2 = false,
  dryRun = false,
  runCommands = false,
  resumeAgents = false
} = {}) {
  const snapshot = readSnapshot();
  if (!snapshot) {
    throw new IdeError(
      "no snapshot yet \u2014 the updater writes one every ~30s while any session is adopted",
      { code: "NO_SNAPSHOT", exitCode: 1 }
    );
  }
  const resume = resumeAgents || readRestorePrefs().resumeAgents;
  const plan = buildRestorePlan(snapshot, liveSessions(), ideBackedProjects());
  if (dryRun) {
    reportPlan(plan, snapshot, {
      json: json2,
      dryRun: true,
      restored: [],
      launched: [],
      resumed: [],
      resumeAgents: resume
    });
    return;
  }
  const restored = [];
  const launched = [];
  const resumed = [];
  const recordResumed = (session, panes) => {
    if (panes.length) resumed.push({ session, panes });
  };
  for (const action of plan.actions) {
    if (action.kind === "skip") continue;
    if (action.kind === "launch") {
      const ok2 = await launchProject(action.dir, json2);
      if (ok2) launched.push(action.session);
      else {
        const snap = snapshot.sessions.find((s) => s.name === action.session);
        if (snap) {
          recordResumed(snap.name, rebuildSession(snap, { runCommands, resumeAgents: resume }));
          if (snap.adopted) safeAdopt(snap.name);
          restored.push(action.session);
        }
      }
      continue;
    }
    recordResumed(
      action.session.name,
      rebuildSession(action.session, { runCommands, resumeAgents: resume })
    );
    if (action.session.adopted) safeAdopt(action.session.name);
    restored.push(action.session.name);
  }
  reportPlan(plan, snapshot, {
    json: json2,
    dryRun: false,
    restored,
    launched,
    resumed,
    resumeAgents: resume
  });
}
function safeAdopt(session) {
  try {
    adoptSession(session);
  } catch {
  }
}
async function launchProject(dir, json2) {
  const restoreLog = console.log;
  if (json2) console.log = () => {
  };
  try {
    const { launch: launch2 } = await Promise.resolve().then(() => (init_launch(), launch_exports));
    await launch2(dir, { attach: false });
    return true;
  } catch {
    return false;
  } finally {
    console.log = restoreLog;
  }
}
function reportPlan(plan, snapshot, { json: json2, dryRun, restored, launched, resumed, resumeAgents }) {
  const skipped = plan.actions.filter((a) => a.kind === "skip").map((a) => a.session);
  const willLaunch = plan.actions.filter((a) => a.kind === "launch").map((a) => a.session);
  const willRebuild = plan.actions.filter((a) => a.kind === "rebuild").map((a) => a.session.name);
  const resumedPanes = resumed.reduce((n, r) => n + r.panes.length, 0);
  if (json2) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          savedAt: snapshot.savedAt,
          skipped,
          launched: dryRun ? willLaunch : launched,
          restored: dryRun ? willRebuild : restored,
          panes: plan.paneCount,
          resumeAgents,
          resumedPanes,
          resumed
        },
        null,
        2
      )
    );
    return;
  }
  if (dryRun) {
    console.log(`Restore plan (snapshot from ${snapshot.savedAt}):`);
    for (const action of plan.actions) {
      if (action.kind === "skip") {
        console.log(`  skip     ${action.session} (already running)`);
      } else if (action.kind === "launch") {
        console.log(`  launch   ${action.session} (ide.yml at ${action.dir})`);
      } else {
        const w = action.session.windows.length;
        const p = action.session.windows.reduce((n, win) => n + win.panes.length, 0);
        const wouldResume = countResumableAgents(action.session, resumeAgents);
        const resumeNote = wouldResume ? `, would resume ${wouldResume} agent${wouldResume === 1 ? "" : "s"}` : "";
        console.log(
          `  rebuild  ${action.session.name} (${w} window${w === 1 ? "" : "s"}, ${p} pane${p === 1 ? "" : "s"}${resumeNote})`
        );
      }
    }
    return;
  }
  const resumedBySession = new Map(resumed.map((r) => [r.session, r.panes.length]));
  const resumeSuffix = (name) => {
    const n = resumedBySession.get(name) ?? 0;
    return n ? ` (resumed ${n} agent${n === 1 ? "" : "s"})` : "";
  };
  const parts = [];
  if (restored.length)
    parts.push(`rebuilt ${restored.map((s) => `${s}${resumeSuffix(s)}`).join(", ")}`);
  if (launched.length) parts.push(`launched ${launched.join(", ")}`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")} (already running)`);
  console.log(parts.length ? `Restored: ${parts.join("; ")}` : "Nothing to restore.");
}

// bin/cli.ts
init_send();
init_errors2();
init_output();

// packages/daemon/src/tui/mirror/hosted.ts
var APP_HOST_SESSION = "_tmux-ide-app";
var HOSTED_ENV = "TMUX_IDE_HOSTED";
function wantsHostedApp(input) {
  if (input.hostedEnv) return false;
  return input.flagDetachable || input.flagHosted || input.configDetachable;
}
function shellQuote(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
function hostedEnvVars(base) {
  const env = {
    [HOSTED_ENV]: "1",
    TMUX_IDE_CWD: base.cwd,
    TMUX_IDE_CLI: base.cli
  };
  if (base.path) env.PATH = base.path;
  if (base.home) env.TMUX_IDE_HOME = base.home;
  if (base.config) env.TMUX_IDE_CONFIG = base.config;
  if (base.tuiBin) env.TMUX_IDE_TUI_BIN = base.tuiBin;
  return env;
}
function hostedCommandLine(bin, argv, env) {
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["exec", "env", ...assigns, shellQuote(bin), ...argv.map(shellQuote)].join(" ");
}
function hostExistsArgv() {
  return ["has-session", "-t", `=${APP_HOST_SESSION}`];
}
function hostCreateArgv(opts) {
  return ["new-session", "-d", "-s", APP_HOST_SESSION, "-c", opts.cwd, opts.commandLine];
}
function hostSetupArgvs() {
  return [
    ["set-option", "-t", APP_HOST_SESSION, "status", "off"],
    ["set-option", "-w", "-t", `${APP_HOST_SESSION}:`, "window-size", "latest"]
  ];
}
function hostAttachArgv(insideTmux) {
  return insideTmux ? ["switch-client", "-t", `=${APP_HOST_SESSION}`] : ["attach-session", "-t", `=${APP_HOST_SESSION}`];
}

// bin/cli.ts
var __dirname6 = dirname24(fileURLToPath9(import.meta.url));
var selfPath = fileURLToPath9(import.meta.url);
var nodeCliPath = selfPath.endsWith(".js") ? selfPath : resolve23(__dirname6, "cli.js");
var { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    row: { type: "string" },
    pane: { type: "string" },
    title: { type: "string" },
    command: { type: "string" },
    size: { type: "string" },
    write: { type: "boolean" },
    template: { type: "string" },
    name: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    port: { type: "string" },
    // setup command flags
    edit: { type: "boolean" },
    wizard: { type: "boolean" },
    // send command flags
    to: { type: "string" },
    "no-enter": { type: "boolean" },
    // wait command flags
    status: { type: "string" },
    timeout: { type: "string" },
    match: { type: "string" },
    // events command flag
    follow: { type: "boolean" },
    // force the team cockpit instead of launching a project
    team: { type: "boolean" },
    // adopt every live (non-internal) session at once
    all: { type: "boolean" },
    // restore: print the plan without touching tmux
    "dry-run": { type: "boolean" },
    // restore: replay recorded pane commands (off by default for safety)
    "run-commands": { type: "boolean" },
    // restore: revive agent conversations via `claude --resume <id>`
    "resume-agents": { type: "boolean" },
    // statusline: the session whose bar is being rendered
    active: { type: "string" },
    // switcher: the tmux client the popup was invoked on (see `switcher` case)
    client: { type: "string" },
    // team --popup: run the home cockpit as a popup over a tmux client (M-h)
    popup: { type: "boolean" },
    // sidebar-toggle: the session whose nav column is toggled (see `sidebar-toggle`)
    session: { type: "string" },
    // menu: the click position (mouse binds forward #{mouse_x}/#{mouse_y}) so the
    // actions menu opens at the pointer instead of centered (see `menu` case)
    x: { type: "string" },
    y: { type: "string" },
    // app: host the cockpit in the internal `_tmux-ide-app` session and attach
    // to it (M23.2) — `--detachable` is the primary name, `--hosted` the alias
    detachable: { type: "boolean" },
    hosted: { type: "boolean" },
    // worktree: base ref for a new branch, the worktree checkout dir override,
    // skip creating a session, and force-remove a dirty worktree (see `worktree`)
    from: { type: "string" },
    dir: { type: "string" },
    "no-session": { type: "boolean" },
    force: { type: "boolean" }
  }
});
var knownCommands = /* @__PURE__ */ new Set([
  "start",
  "init",
  "stop",
  "attach",
  "restart",
  "restore",
  "ls",
  "doctor",
  "status",
  "inspect",
  "validate",
  "detect",
  "config",
  "setup",
  "send",
  "settings",
  "team",
  "app",
  "switcher",
  "wait",
  "events",
  "statusline",
  "adopt",
  "unadopt",
  "agent",
  "integration",
  "chrome-updater",
  "cheatsheet",
  "welcome",
  "menu",
  "popup",
  "sidebar-toggle",
  "worktree",
  "update",
  "skill-sync",
  "serve",
  "command-center",
  "server",
  "help"
]);
if (values.version) {
  const pkg = await Promise.resolve().then(() => __toESM(require_package(), 1));
  console.log(`tmux-ide v${pkg.version}`);
  process.exit(0);
}
if (values.verbose) {
  globalThis.__tmuxIdeVerbose = true;
}
var firstPositional = positionals[0];
var resolved = firstPositional;
var hasKnownCommand = resolved ? knownCommands.has(resolved) : false;
var command = hasKnownCommand ? resolved : "start";
var startTargetDir = hasKnownCommand ? positionals[1] : firstPositional;
var json = values.json ?? false;
var noColor = "NO_COLOR" in process.env;
var bold3 = (s) => noColor ? s : `\x1B[1m${s}\x1B[22m`;
var cyan2 = (s) => noColor ? s : `\x1B[36m${s}\x1B[39m`;
var dim3 = (s) => noColor ? s : `\x1B[2m${s}\x1B[22m`;
if (values.help) {
  printHelp();
  process.exit(0);
}
function printHelp() {
  console.log(`${bold3("tmux-ide")} \u2014 Terminal IDE powered by tmux

${bold3("Usage:")}
  ${cyan2("tmux-ide")}                    ${dim3("Launch ide.yml, or open the team cockpit if none")}
  ${cyan2("tmux-ide <path>")}             ${dim3("Launch from a specific directory (cockpit if no ide.yml)")}
  ${cyan2("tmux-ide setup")}              ${dim3("Interactive TUI setup wizard")}
  ${cyan2("tmux-ide setup --edit")}       ${dim3("Open config tree editor")}
  ${cyan2("tmux-ide settings")}           ${dim3("Interactive TUI config manager")}
  ${cyan2("tmux-ide init")} [--template]  ${dim3("Scaffold a new ide.yml (auto-detects stack)")}
  ${cyan2("tmux-ide stop")}               ${dim3("Kill the current IDE session")}
  ${cyan2("tmux-ide restart")}            ${dim3("Stop and relaunch the IDE session")}
  ${cyan2("tmux-ide restore")} [--dry-run] [--run-commands] [--resume-agents] [--json]
                              ${dim3("Rebuild the fleet from the last snapshot after a tmux crash")}
                              ${dim3("(--resume-agents revives claude conversations via claude --resume)")}
  ${cyan2("tmux-ide attach")}             ${dim3("Reattach to a running session")}
  ${cyan2("tmux-ide team")} [--json]      ${dim3("TUI over all tmux sessions (--json prints fleet state)")}
  ${cyan2("tmux-ide app")} [session]      ${dim3("Unified app: fleet home + live session mirror (bare = home)")}
  ${cyan2("tmux-ide app --detachable")}   ${dim3("Host the app in tmux and attach \u2014 survives the terminal, ^q detaches")}
  ${cyan2("tmux-ide switcher")}           ${dim3("Compact session picker (opens in the M-p popup on adopted sessions)")}
  ${cyan2("tmux-ide wait agent-status")} <session> --status <s> [--timeout <ms>]
                              ${dim3("Block until a session reaches a status (exit 0 match / 1 timeout)")}
  ${cyan2("tmux-ide wait output")} <pane|session> --match <regex> [--timeout <ms>]
                              ${dim3("Block until a pane's output matches a regex (exit 0 match / 1 timeout)")}
  ${cyan2("tmux-ide events")} [--follow] [--json] [--socket]  ${dim3("Stream agent-status transitions (--socket: push from a running serve)")}
  ${cyan2("tmux-ide serve")} [--socket <path>]  ${dim3("Local control socket: NDJSON verbs + pushed events (~/.tmux-ide/control.sock)")}
  ${cyan2("tmux-ide adopt")} <session>    ${dim3("Add the live tmux-ide status bar to a session")}
  ${cyan2("tmux-ide adopt --all")}        ${dim3("Adopt every live (non-internal) session")}
  ${cyan2("tmux-ide unadopt")} <session>  ${dim3("Remove the status bar")}
  ${cyan2("tmux-ide integration install claude")}  ${dim3("Authoritative agent status via Claude Code hooks")}
  ${cyan2("tmux-ide agent explain")} <pane> [--json]  ${dim3("Debug how a pane's agent state is detected")}
  ${cyan2("tmux-ide cheatsheet")}         ${dim3("Print the key cheat sheet (\u2325k / [ ? keys ] popup)")}
  ${cyan2("tmux-ide menu")} [--client N]  ${dim3("Open the right-click actions menu (\u2325m / right-click any pane or the bar)")}
  ${cyan2("tmux-ide popup")} <widget>     ${dim3("Open a widget as a floating panel (explorer/changes/config; \u2325e/\u2325g/\u2325,)")}
  ${cyan2("tmux-ide sidebar-toggle")} [--session S]  ${dim3("Toggle the app nav column (\u2325b on adopted sessions)")}
  ${cyan2("tmux-ide worktree create")} <branch> [--from <ref>] [--dir <path>] [--no-session]
                              ${dim3("Add a git worktree (new branch) + open a session in it")}
  ${cyan2("tmux-ide worktree open")} <branch>    ${dim3("Open (or switch to) the session for an existing worktree")}
  ${cyan2("tmux-ide worktree list")} [--json]    ${dim3("List worktrees joined with their session status")}
  ${cyan2("tmux-ide worktree remove")} <branch> [--force]  ${dim3("Kill the worktree's session + remove the worktree")}
  ${cyan2("tmux-ide ls")}                 ${dim3("List all tmux sessions")}
  ${cyan2("tmux-ide status")} [--json]    ${dim3("Show session status")}
  ${cyan2("tmux-ide inspect")} [--json]   ${dim3("Show effective config and runtime state")}
  ${cyan2("tmux-ide doctor")}             ${dim3("Check system requirements")}
  ${cyan2("tmux-ide update")} [--dry-run] ${dim3("Update tmux-ide (detects dev checkout vs npm/pnpm/bun global)")}
  ${cyan2("tmux-ide skill-sync")}         ${dim3("Refresh the bundled Claude Code skill in ~/.claude/skills/tmux-ide")}
  ${cyan2("tmux-ide validate")} [--json]  ${dim3("Validate ide.yml")}
  ${cyan2("tmux-ide detect")} [--json]    ${dim3("Detect project stack")}
  ${cyan2("tmux-ide detect --write")}     ${dim3("Detect and write ide.yml")}
  ${cyan2("tmux-ide config")} [--json]    ${dim3("Dump config as JSON")}
  ${cyan2("tmux-ide config set")} <path> <value>
  ${cyan2("tmux-ide config add-pane")} --row <N> --title <T> [--command <C>]
  ${cyan2("tmux-ide config remove-pane")} --row <N> --pane <M>
  ${cyan2("tmux-ide config add-row")} [--size <percent>]
  ${cyan2("tmux-ide config enable-team")} [--name <N>]   ${dim3("Enable agent teams")}
  ${cyan2("tmux-ide config disable-team")}               ${dim3("Disable agent teams")}

${bold3("Pane Messaging:")}
  ${cyan2("tmux-ide send")} <target> <message>     ${dim3("Send message to a pane")}
  ${cyan2("tmux-ide send")} --to <name> <message>   ${dim3("Target by name, title, role, or ID")}
  ${cyan2("tmux-ide send")} <target> --no-enter msg  ${dim3("Send text without pressing Enter")}

${bold3("Server:")}
  ${cyan2("tmux-ide command-center")} [--port N]    ${dim3("Start the command-center HTTP API")}
  ${cyan2("tmux-ide server")} [--port N]            ${dim3("Start HTTP + PTY WebSocket server")}

${bold3("Discover (in the TUI):")}
  ${dim3("Bare")} ${cyan2("tmux-ide")} ${dim3("with no ide.yml opens the HOME cockpit \u2014 the fleet home screen.")}
  ${dim3("Once a session is adopted, the whole UI is one keystroke away:")}
  ${cyan2("\u2325h")}  ${dim3("home cockpit from anywhere    ")}${cyan2("\u2325p")}  ${dim3("switch session")}
  ${cyan2("\u2325k")}  ${dim3("cheat sheet (all keys)        ")}${cyan2("\u2325m")}  ${dim3("actions menu (or right-click any pane / the bar)")}
  ${cyan2("\u2325e \u2325g \u2325,")}  ${dim3("file / changes / config panels   ")}${cyan2("\u2325b")}  ${dim3("sidebar")}
  ${dim3("A first-run welcome card names these keys once. Run")} ${cyan2("tmux-ide cheatsheet")} ${dim3("to see the full sheet.")}

${bold3("Flags:")}
  ${cyan2("--json")}                      ${dim3("Output as JSON (all commands)")}
  ${cyan2("--template <name>")}           ${dim3("Use specific template for init")}
  ${cyan2("--write")}                     ${dim3("Write detected config to ide.yml")}
  ${cyan2("--verbose")}                   ${dim3("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan2("-h, --help")}                  ${dim3("Show usage")}
  ${cyan2("-v, --version")}               ${dim3("Show version number")}`);
}
function execBunWidget(surface, scriptPath, args, commandLabel, extraEnv = {}) {
  const launch2 = resolveTuiLaunch({
    surface,
    scriptPath,
    args,
    checkoutExists: existsSync34(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new IdeError(
      `\`tmux-ide ${commandLabel}\` is unavailable because ${launch2.reasons.join(" and ")}.
Install bun (https://bun.sh) \u2014 the TUI surfaces run on it. Sources ship with the npm package since v2.6.1.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const env = {
    ...process.env,
    TMUX_IDE_CWD: process.cwd(),
    TMUX_IDE_CLI: nodeCliPath,
    ...extraEnv
  };
  if (launch2.mode === "bun") {
    execFileSync14(launch2.bin, launch2.argv, {
      stdio: "inherit",
      cwd: resolve23(__dirname6, ".."),
      env
    });
    return;
  }
  execFileSync14(launch2.bin, launch2.argv, { stdio: "inherit", env });
}
function launchHostedApp(scriptPath, appArgs) {
  const launch2 = resolveTuiLaunch({
    surface: "app",
    scriptPath,
    args: appArgs,
    checkoutExists: existsSync34(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new IdeError(
      `\`tmux-ide app --detachable\` is unavailable because ${launch2.reasons.join(" and ")}.
Install bun (https://bun.sh) \u2014 the TUI surfaces run on it. Sources ship with the npm package since v2.6.1.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  let exists = true;
  try {
    execFileSync14("tmux", hostExistsArgv(), { stdio: "ignore" });
  } catch {
    exists = false;
  }
  if (!exists) {
    const cwd = launch2.mode === "bun" ? resolve23(__dirname6, "..") : process.cwd();
    const commandLine = hostedCommandLine(
      launch2.bin,
      launch2.argv,
      hostedEnvVars({
        cwd: process.cwd(),
        cli: nodeCliPath,
        path: process.env.PATH,
        home: process.env.TMUX_IDE_HOME,
        config: process.env.TMUX_IDE_CONFIG,
        tuiBin: process.env.TMUX_IDE_TUI_BIN
      })
    );
    execFileSync14("tmux", hostCreateArgv({ cwd, commandLine }), { stdio: "ignore" });
    for (const args of hostSetupArgvs()) execFileSync14("tmux", args, { stdio: "ignore" });
  }
  execFileSync14("tmux", hostAttachArgv(Boolean(process.env.TMUX)), { stdio: "inherit" });
}
async function printFleetJson() {
  const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
  const { listTeamProjects: listTeamProjects2 } = await Promise.resolve().then(() => (init_projects(), projects_exports));
  const { toFleetJson: toFleetJson2 } = await Promise.resolve().then(() => (init_report(), report_exports));
  console.log(JSON.stringify(toFleetJson2(listTeamProjects2(createStatusTracker2())), null, 2));
}
var socketFlag = values.socket;
async function waitOverSocket(params) {
  if (!socketFlag) return null;
  const { connectControl: connectControl2, ControlRequestError: ControlRequestError2 } = await Promise.resolve().then(() => (init_client(), client_exports));
  let client;
  try {
    client = await connectControl2({
      socketPath: typeof socketFlag === "string" ? socketFlag : void 0
    });
  } catch {
    return null;
  }
  try {
    const data = await client.request("wait", params);
    return { timedOut: false, data };
  } catch (err) {
    if (err instanceof ControlRequestError2 && err.code === "timeout") return { timedOut: true };
    return null;
  } finally {
    client.close();
  }
}
var teamScriptPath = resolve23(__dirname6, "../packages/daemon/src/tui/team/index.tsx");
var appScriptPath = resolve23(__dirname6, "../packages/daemon/src/tui/mirror/app.tsx");
function launchTeamCockpit() {
  execBunWidget("team", teamScriptPath, [], "team");
}
function runApp(appArgs) {
  const hosted = wantsHostedApp({
    flagDetachable: values.detachable === true,
    flagHosted: values.hosted === true,
    configDetachable: loadAppConfig().app.detachable,
    hostedEnv: process.env[HOSTED_ENV] === "1"
  });
  if (hosted) launchHostedApp(appScriptPath, appArgs);
  else execBunWidget("app", appScriptPath, appArgs, "app");
}
function launchApp() {
  runApp([]);
}
try {
  switch (command) {
    case "start": {
      if (!json) {
        try {
          const { getUpdateStatus: getUpdateStatus2 } = await Promise.resolve().then(() => (init_update_check(), update_check_exports));
          const { latest, updateAvailable } = getUpdateStatus2();
          if (updateAvailable && latest) {
            process.stderr.write(
              dim3(`\u2B06 tmux-ide v${latest} available \u2014 run \`tmux-ide update\`
`)
            );
          }
        } catch {
        }
      }
      const targetDir = resolve23(startTargetDir || ".");
      const hasIdeYml = existsSync34(join28(targetDir, "ide.yml"));
      const entry = resolveEntry({
        hasIdeYml,
        teamFlag: values.team === true,
        frontDoor: loadAppConfig().app.frontDoor
      });
      if (entry !== "project") {
        if (json) {
          await printFleetJson();
          break;
        }
        if (entry === "app") launchApp();
        else launchTeamCockpit();
        break;
      }
      await launch(startTargetDir, { json });
      break;
    }
    case "init":
      await init({ template: values.template, json });
      break;
    case "stop":
      await stop(positionals[1], { json });
      break;
    case "attach":
      await attach(positionals[1], { json });
      break;
    case "restart":
      await restart(positionals[1], { json });
      break;
    case "restore":
      await restore({
        json,
        dryRun: values["dry-run"] === true,
        runCommands: values["run-commands"] === true,
        resumeAgents: values["resume-agents"] === true
      });
      break;
    case "ls":
      await ls({ json });
      break;
    case "doctor":
      await doctor({ json });
      break;
    case "status":
      await status(positionals[1], { json });
      break;
    case "inspect":
      await inspect(positionals[1], { json });
      break;
    case "validate":
      await validate(positionals[1], { json });
      break;
    case "detect":
      await detect(positionals[1], { json, write: values.write });
      break;
    case "config": {
      const sub = positionals[1];
      let action = "dump";
      let configArgs = [];
      if (sub === "set") {
        action = "set";
        configArgs = positionals.slice(2);
      } else if (sub === "add-pane") {
        action = "add-pane";
        configArgs = [];
        if (values.row !== void 0) configArgs.push("--row", values.row);
        if (values.title !== void 0) configArgs.push("--title", values.title);
        if (values.command !== void 0) configArgs.push("--command", values.command);
        if (values.size !== void 0) configArgs.push("--size", values.size);
      } else if (sub === "remove-pane") {
        action = "remove-pane";
        configArgs = [];
        if (values.row !== void 0) configArgs.push("--row", values.row);
        if (values.pane !== void 0) configArgs.push("--pane", values.pane);
      } else if (sub === "add-row") {
        action = "add-row";
        configArgs = [];
        if (values.size !== void 0) configArgs.push("--size", values.size);
      } else if (sub === "enable-team") {
        action = "enable-team";
        configArgs = [];
        if (values.name !== void 0) configArgs.push("--name", values.name);
      } else if (sub === "disable-team") {
        action = "disable-team";
        configArgs = [];
      } else if (sub === "edit") {
        const scriptPath = resolve23(__dirname6, "../packages/daemon/src/widgets/setup/index.tsx");
        execBunWidget(
          "setup",
          scriptPath,
          ["--dir=" + resolve23(startTargetDir || "."), "--edit"],
          "config edit"
        );
        break;
      }
      await config(null, { json, action, args: configArgs });
      break;
    }
    case "setup": {
      const scriptPath = resolve23(__dirname6, "../packages/daemon/src/widgets/setup/index.tsx");
      const setupArgs = ["--dir=" + resolve23(startTargetDir || ".")];
      if (positionals[1] === "--edit" || values.edit) setupArgs.push("--edit");
      if (positionals[1] === "--wizard" || values.wizard) setupArgs.push("--wizard");
      execBunWidget("setup", scriptPath, setupArgs, "setup");
      break;
    }
    case "send": {
      const target = values.to ?? positionals[1];
      const messageStart = values.to ? 1 : 2;
      let message = positionals.slice(messageStart).join(" ");
      if (!message && !process.stdin.isTTY) {
        const { readFileSync: readFileSync19 } = await import("node:fs");
        message = readFileSync19(0, "utf-8").trim();
      }
      await send(null, { json, to: target, message, noEnter: values["no-enter"] });
      break;
    }
    case "settings": {
      const scriptPath = resolve23(__dirname6, "../packages/daemon/src/widgets/config/index.tsx");
      execBunWidget("config", scriptPath, ["--dir=" + resolve23(startTargetDir || ".")], "settings");
      break;
    }
    case "team": {
      if (json) {
        await printFleetJson();
        break;
      }
      if (values.popup === true) {
        const clientArg = typeof values.client === "string" ? values.client : "";
        execBunWidget("team", teamScriptPath, [], "team --popup", {
          TMUX_IDE_POPUP_CLIENT: clientArg
        });
        break;
      }
      launchTeamCockpit();
      break;
    }
    case "app": {
      const session = positionals[1];
      const appArgs = session ? [`--target=${session}`] : [];
      runApp(appArgs);
      break;
    }
    case "switcher": {
      const clientArg = typeof values.client === "string" ? values.client : "";
      execBunWidget("team", teamScriptPath, [], "switcher", { TMUX_IDE_PICKER_CLIENT: clientArg });
      break;
    }
    case "wait": {
      const sub = positionals[1];
      if (sub === "output") {
        const target = positionals[2];
        const pattern = values.match;
        if (!target || typeof pattern !== "string" || pattern.length === 0) {
          console.error(
            "Usage: tmux-ide wait output <pane|session> --match <regex> [--timeout <ms>] [--socket[=path]]"
          );
          process.exit(1);
        }
        try {
          new RegExp(pattern);
        } catch (err) {
          console.error(`Invalid --match regex: ${err.message}`);
          process.exit(1);
        }
        const outTimeout = Number(values.timeout ?? "60000");
        const viaSocket2 = await waitOverSocket({
          kind: "output",
          target,
          match: pattern,
          timeoutMs: outTimeout
        });
        if (viaSocket2) {
          if (viaSocket2.timedOut) {
            console.error(
              `Timed out after ${outTimeout}ms waiting for ${target} output to match /${pattern}/`
            );
            process.exit(1);
          }
          const hit = viaSocket2.data.matched;
          if (json) console.log(JSON.stringify({ matched: hit }));
          else console.log(hit);
          process.exit(0);
        }
        const { waitForOutputMatch: waitForOutputMatch2 } = await Promise.resolve().then(() => (init_wait(), wait_exports));
        const result2 = await waitForOutputMatch2(target, pattern, { timeoutMs: outTimeout });
        if (!result2.ok) {
          console.error(
            `Timed out after ${outTimeout}ms waiting for ${target} output to match /${pattern}/`
          );
          process.exit(1);
        }
        if (json) console.log(JSON.stringify({ matched: result2.matched }));
        else console.log(result2.matched);
        process.exit(0);
      }
      const VALID = /* @__PURE__ */ new Set(["blocked", "working", "done", "idle", "unknown"]);
      const sessionName = positionals[2];
      const want = values.status;
      if (sub !== "agent-status" || !sessionName || typeof want !== "string" || !VALID.has(want)) {
        console.error(
          "Usage: tmux-ide wait agent-status <session> --status <blocked|working|done|idle|unknown> [--timeout <ms>] [--socket[=path]]"
        );
        process.exit(1);
      }
      const timeout = Number(values.timeout ?? "60000");
      const viaSocket = await waitOverSocket({
        kind: "agent-status",
        session: sessionName,
        status: want,
        timeoutMs: timeout
      });
      if (viaSocket) {
        if (viaSocket.timedOut) {
          console.error(
            `Timed out after ${timeout}ms waiting for ${sessionName} to reach status "${want}"`
          );
          process.exit(1);
        }
        if (json) console.log(JSON.stringify({ session: sessionName, status: want, ok: true }));
        else console.log(`${sessionName} reached status: ${want}`);
        process.exit(0);
      }
      const { waitForAgentStatus: waitForAgentStatus2 } = await Promise.resolve().then(() => (init_wait(), wait_exports));
      const result = await waitForAgentStatus2(
        sessionName,
        want,
        { timeoutMs: timeout }
      );
      if (!result.ok) {
        console.error(
          `Timed out after ${timeout}ms waiting for ${sessionName} to reach status "${want}" (last: ${result.status ?? "absent"})`
        );
        process.exit(1);
      }
      if (json) {
        console.log(JSON.stringify({ session: sessionName, status: result.status, ok: true }));
      } else {
        console.log(`${sessionName} reached status: ${result.status}`);
      }
      process.exit(0);
      break;
    }
    case "events": {
      const { readFileSync: readFileSync19, existsSync: existsSync35, statSync: statSync6, openSync, readSync, closeSync } = await import("node:fs");
      const { eventsPath: eventsPath2, formatEventLine: formatEventLine2 } = await Promise.resolve().then(() => (init_events(), events_exports));
      const path2 = eventsPath2();
      const paintStatus = (status2, text) => {
        if (noColor || status2 === null) return text;
        const code = status2 === "blocked" ? "203" : status2 === "working" ? "221" : status2 === "done" ? "111" : status2 === "idle" ? "114" : "244";
        return `\x1B[38;5;${code}m${text}\x1B[39m`;
      };
      const printLine = (raw) => {
        if (json) {
          console.log(raw);
          return;
        }
        try {
          const ev = JSON.parse(raw);
          console.log(formatEventLine2(ev, paintStatus));
        } catch {
        }
      };
      if (values.follow && socketFlag) {
        const { connectControl: connectControl2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = await connectControl2({
          socketPath: typeof socketFlag === "string" ? socketFlag : void 0
        }).catch(() => null);
        if (client) {
          if (existsSync35(path2)) {
            const backlog = readFileSync19(path2, "utf8").split("\n").filter((l) => l.trim().length > 0);
            for (const line of backlog.slice(-50)) printLine(line);
          }
          await client.subscribe((frame) => {
            if (frame.event === "agent-status") printLine(JSON.stringify(frame.data));
          });
          process.on("SIGINT", () => {
            client.close();
            process.exit(0);
          });
          await client.done;
          break;
        }
      }
      if (!existsSync35(path2)) {
        console.log("no events yet \u2014 is a session adopted? (the chrome updater writes events)");
        break;
      }
      const allLines = readFileSync19(path2, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const line of allLines.slice(-50)) printLine(line);
      if (!values.follow) break;
      let offset = statSync6(path2).size;
      let leftover = "";
      const timer = setInterval(() => {
        let size;
        try {
          size = statSync6(path2).size;
        } catch {
          return;
        }
        if (size < offset) {
          offset = 0;
          leftover = "";
        }
        if (size <= offset) return;
        const fd = openSync(path2, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          const parts = (leftover + buf.toString("utf8")).split("\n");
          leftover = parts.pop() ?? "";
          for (const line of parts) if (line.trim().length > 0) printLine(line);
        } finally {
          closeSync(fd);
        }
      }, 500);
      process.on("SIGINT", () => {
        clearInterval(timer);
        process.exit(0);
      });
      await new Promise(() => {
      });
      break;
    }
    case "statusline": {
      try {
        const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
        const { listTeamProjects: listTeamProjects2 } = await Promise.resolve().then(() => (init_projects(), projects_exports));
        const { buildStatusline: buildStatusline2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const projects = listTeamProjects2(createStatusTracker2());
        console.log(buildStatusline2(projects, values.active ?? null, 12, getAppConfig2().theme));
      } catch {
        console.log("#[fg=colour75,bold] tmux-ide #[default]");
      }
      break;
    }
    case "adopt": {
      const { adoptSession: adoptSession2, adoptableSessionNames: adoptableSessionNames2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
      if (values.all) {
        const raw = execFileSync14("tmux", ["list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        const targets = raw ? adoptableSessionNames2(raw.split("\n")) : [];
        if (targets.length === 0) {
          console.log("no adoptable sessions");
          break;
        }
        for (const name of targets) {
          adoptSession2(name);
          console.log(`adopted ${name}`);
        }
        break;
      }
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide adopt <session> | tmux-ide adopt --all");
        process.exit(1);
      }
      adoptSession2(target);
      console.log(`adopted ${target} \u2014 chrome row active (unadopt to remove)`);
      break;
    }
    case "unadopt": {
      const { unadoptSession: unadoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide unadopt <session>");
        process.exit(1);
      }
      unadoptSession2(target);
      console.log(`unadopted ${target}`);
      break;
    }
    case "agent": {
      const sub = positionals[1];
      const target = positionals[2];
      if (sub !== "explain" || !target) {
        console.error(
          "Usage: tmux-ide agent explain <pane> [--json]\n  <pane>  a pane id (%N) or a session name (uses its active pane)\n  Prints how the fleet detector classifies the pane: authority,\n  hint, resolved manifest, per-state rule results, and the snapshot."
        );
        process.exit(1);
      }
      const { agentExplain: agentExplain2 } = await Promise.resolve().then(() => (init_agent_explain(), agent_explain_exports));
      agentExplain2(target, { json });
      break;
    }
    case "integration": {
      const sub = positionals[1];
      const agent = positionals[2];
      const needsClaude = sub === "install" || sub === "uninstall";
      if (!sub || needsClaude && agent !== "claude") {
        console.error(
          "Usage: tmux-ide integration <install|uninstall|status|offer> [claude]\n  install    hook Claude Code lifecycle events into tmux pane state\n  uninstall  remove exactly the tmux-ide hook entries\n  status     list discovered agents + integration state\n  offer      one-time first-adopt install prompt (used by the popup)"
        );
        process.exit(1);
      }
      const mod = await Promise.resolve().then(() => (init_claude(), claude_exports));
      if (sub === "install") {
        const { scriptPath, settingsPath } = mod.installClaudeIntegration();
        const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
        const skill = syncSkill2();
        console.log(`hook script: ${scriptPath}`);
        console.log(`settings:    ${settingsPath} (backup written once as .tmux-ide.bak)`);
        console.log(`skill:       ${skill.action} \u2192 ${skill.path} (v${skill.to})`);
        console.log(
          "installed \u2014 NEW Claude Code sessions now report working/blocked/done authoritatively into the tmux-ide chrome."
        );
      } else if (sub === "uninstall") {
        const { wasInstalled } = mod.uninstallClaudeIntegration();
        console.log(wasInstalled ? "uninstalled \u2014 hook entries removed" : "was not installed");
      } else if (sub === "offer") {
        const offerMod = await Promise.resolve().then(() => (init_offer(), offer_exports));
        try {
          console.log(offerMod.buildOfferText());
        } catch {
          console.log("Claude Code detected \u2014 install the tmux-ide integration? [y/N]");
        }
        const act = (key) => {
          offerMod.markIntegrationOffered();
          if (key === "y" || key === "Y") {
            try {
              mod.installClaudeIntegration();
              console.log("\ninstalled \u2014 new Claude Code sessions now report state to tmux-ide.");
            } catch (e) {
              console.log(`
install failed: ${e.message}`);
            }
          } else {
            console.log("\nskipped \u2014 run `tmux-ide integration install claude` anytime.");
          }
        };
        const forced = process.env.TMUX_IDE_OFFER_KEY;
        if (forced !== void 0) {
          act(forced);
          process.exit(0);
        }
        const closeOffer = () => process.exit(0);
        const offerTimer = setTimeout(closeOffer, 6e4);
        offerTimer.unref?.();
        try {
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.once("data", (data) => {
            act(data.toString());
            console.log("\n[ press any key to close ]");
            process.stdin.once("data", closeOffer);
            process.stdin.once("end", closeOffer);
          });
          process.stdin.once("end", closeOffer);
        } catch {
          closeOffer();
        }
      } else {
        const { discoverAgents: discoverAgents2 } = await Promise.resolve().then(() => (init_agent_discovery(), agent_discovery_exports));
        const agents = discoverAgents2();
        if (json) {
          console.log(JSON.stringify({ agents }, null, 2));
          break;
        }
        for (const a of agents) {
          let state;
          if (a.path === null) state = "not found";
          else if (a.integration)
            state = a.installed ? "integration installed \u2713" : "on PATH \u2014 integration not installed";
          else state = "detected (no integration)";
          console.log(`  ${a.id.padEnd(10)} ${state}`);
        }
      }
      break;
    }
    case "chrome-updater": {
      try {
        const { runUpdaterLoop: runUpdaterLoop2 } = await Promise.resolve().then(() => (init_updater(), updater_exports));
        runUpdaterLoop2();
      } catch {
        process.exit(0);
      }
      break;
    }
    case "cheatsheet": {
      try {
        const { buildCheatsheet: buildCheatsheet2 } = await Promise.resolve().then(() => (init_cheatsheet(), cheatsheet_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const cfg = getAppConfig2();
        console.log(
          buildCheatsheet2({
            width: process.stdout.columns ?? 100,
            keys: cfg.keys,
            theme: cfg.theme
          })
        );
      } catch {
        console.log("tmux-ide \u2014 press \u2325p for the switcher, \u2325k for this sheet. Any key closes.");
      }
      const close = () => process.exit(0);
      const timer = setTimeout(close, 6e4);
      timer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", close);
        process.stdin.once("end", close);
      } catch {
        close();
      }
      break;
    }
    case "welcome": {
      try {
        const { buildWelcomeText: buildWelcomeText2 } = await Promise.resolve().then(() => (init_welcome(), welcome_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        console.log(buildWelcomeText2(getAppConfig2().keys));
      } catch {
        console.log(
          "Welcome to tmux-ide. Right-click for the menu \xB7 \u2325h home \xB7 \u2325p switch \xB7 \u2325k all keys."
        );
      }
      const closeWelcome = () => process.exit(0);
      const welcomeTimer = setTimeout(closeWelcome, 6e4);
      welcomeTimer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", closeWelcome);
        process.stdin.once("end", closeWelcome);
      } catch {
        closeWelcome();
      }
      break;
    }
    case "menu": {
      try {
        const tmuxCap = {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        };
        const rawClient = typeof values.client === "string" ? values.client : "";
        let client = rawClient && !rawClient.includes("#{") ? rawClient : "";
        if (!client) {
          const raw = execFileSync14(
            "tmux",
            ["list-clients", "-F", "#{client_activity} #{client_name}"],
            tmuxCap
          ).trim();
          const newest = raw.split("\n").filter(Boolean).map((line) => {
            const sp = line.indexOf(" ");
            return { activity: Number(line.slice(0, sp)), name: line.slice(sp + 1) };
          }).sort((a, b) => b.activity - a.activity)[0];
          client = newest?.name ?? "";
        }
        if (!client) break;
        const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
        const { listTeamSessions: listTeamSessions2 } = await Promise.resolve().then(() => (init_sessions2(), sessions_exports));
        const { buildMenu: buildMenu2, menuPositionArgs: menuPositionArgs2 } = await Promise.resolve().then(() => (init_menu(), menu_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const { getUpdateStatus: getUpdateStatus2 } = await Promise.resolve().then(() => (init_update_check(), update_check_exports));
        const sessions = listTeamSessions2(createStatusTracker2()).map((s) => ({
          name: s.name,
          status: s.status
        }));
        const position = menuPositionArgs2(
          typeof values.x === "string" ? values.x : void 0,
          typeof values.y === "string" ? values.y : void 0
        );
        const args = [
          "display-menu",
          "-c",
          client,
          ...position,
          ...buildMenu2(sessions, getAppConfig2().theme, getUpdateStatus2())
        ];
        execFileSync14("tmux", args, { stdio: "ignore", timeout: 2e3 });
      } catch {
      }
      break;
    }
    case "popup": {
      const { POPUP_WIDGETS: POPUP_WIDGETS2 } = await Promise.resolve().then(() => (init_panels(), panels_exports));
      const widget = positionals[1];
      if (!widget || !POPUP_WIDGETS2.includes(widget)) {
        throw new IdeError(
          `Usage: tmux-ide popup <widget>
Known panels: ${POPUP_WIDGETS2.join(", ")}.`,
          { code: "USAGE", exitCode: 1 }
        );
      }
      const scriptPath = resolve23(__dirname6, "../packages/daemon/src/widgets", widget, "index.tsx");
      let popupSession = "";
      try {
        popupSession = execFileSync14("tmux", ["display-message", "-p", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        }).trim();
      } catch {
      }
      const popupArgs = [`--dir=${process.cwd()}`];
      if (popupSession) popupArgs.push(`--session=${popupSession}`);
      execBunWidget(widget, scriptPath, popupArgs, `popup ${widget}`);
      break;
    }
    case "sidebar-toggle": {
      try {
        const {
          findSidebarPane: findSidebarPane2,
          openSidebarPane: openSidebarPane2,
          closeSidebarPane: closeSidebarPane2,
          resolveSidebarConfig: resolveSidebarConfig2,
          DEFAULT_SIDEBAR_WIDTH: DEFAULT_SIDEBAR_WIDTH2
        } = await Promise.resolve().then(() => (init_sidebar(), sidebar_exports));
        let session = typeof values.session === "string" ? values.session.trim() : "";
        if (!session || session.includes("#{")) {
          try {
            session = execFileSync14("tmux", ["display-message", "-p", "#{session_name}"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 2e3
            }).trim();
          } catch {
            session = "";
          }
        }
        if (!session) break;
        const existing = findSidebarPane2(session);
        if (existing) {
          closeSidebarPane2(existing);
          break;
        }
        const { getSessionCwd: getSessionCwd3 } = await Promise.resolve().then(() => (init_src(), src_exports));
        let dir = process.cwd();
        try {
          dir = getSessionCwd3(session) ?? dir;
        } catch {
        }
        let width = DEFAULT_SIDEBAR_WIDTH2;
        let theme = null;
        try {
          const { readConfig: readConfig2 } = await Promise.resolve().then(() => (init_yaml_io(), yaml_io_exports));
          const { config: config2 } = readConfig2(dir);
          theme = config2.theme ?? null;
          const sb = resolveSidebarConfig2(config2.sidebar);
          if (sb.enabled) width = sb.width;
        } catch {
        }
        openSidebarPane2(session, dir, width, theme);
      } catch {
      }
      break;
    }
    case "worktree": {
      let printSwitchHint = function(name, wtPath) {
        console.log(`Worktree ready: ${wtPath}`);
        console.log(`Session: ${name}`);
        if (process.env.TMUX) {
          console.log(`Switch to it:  tmux switch-client -t '${name}'`);
        } else {
          console.log(`Attach to it:  tmux attach -t '${name}'`);
        }
      };
      printSwitchHint2 = printSwitchHint;
      const sub = positionals[1];
      const KNOWN_SUBS = /* @__PURE__ */ new Set(["create", "open", "list", "remove"]);
      if (!sub || !KNOWN_SUBS.has(sub)) {
        throw new IdeError(
          "Usage: tmux-ide worktree <create|open|list|remove> <branch> [flags]\n  create <branch> [--from <ref>] [--dir <path>] [--no-session]\n  open <branch>\n  list [--json]\n  remove <branch> [--force]",
          { code: "USAGE", exitCode: 1 }
        );
      }
      const {
        worktreeSessionName: worktreeSessionName2,
        worktreePath: worktreePath2,
        listWorktrees: listWorktrees2,
        createWorktree: createWorktree2,
        removeWorktree: removeWorktree2,
        WorktreeError: WorktreeError2
      } = await Promise.resolve().then(() => (init_worktree(), worktree_exports));
      const { getSessionName: getSessionName2 } = await Promise.resolve().then(() => (init_yaml_io(), yaml_io_exports));
      const { getSessionCwd: getSessionCwd3, hasSession: hasSession2, killSession: killSession2, createDetachedSession: createDetachedSession2 } = await Promise.resolve().then(() => (init_src(), src_exports));
      let repoDir = process.cwd();
      const sessionArg = typeof values.session === "string" ? values.session.trim() : "";
      if (sessionArg && !sessionArg.includes("#{")) {
        try {
          const cwd = getSessionCwd3(sessionArg);
          if (cwd) repoDir = cwd;
        } catch {
        }
      }
      const worktrees = listWorktrees2(repoDir);
      const mainPath = worktrees[0]?.path ?? repoDir;
      const projectName = getSessionName2(mainPath).name;
      async function openWorktreeSession(wtPath, name) {
        if (existsSync34(join28(wtPath, "ide.yml"))) {
          await launch(wtPath, { attach: false, sessionName: name });
        } else {
          if (!hasSession2(name)) createDetachedSession2(name, wtPath);
          const { adoptSession: adoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
          adoptSession2(name);
        }
      }
      if (sub === "create") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError(
            "Usage: tmux-ide worktree create <branch> [--from <ref>] [--dir <path>] [--no-session]",
            { code: "USAGE", exitCode: 1 }
          );
        }
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const dirOverride = typeof values.dir === "string" && values.dir.length > 0 ? values.dir : getAppConfig2().worktrees.dir || null;
        const wtPath = worktreePath2(repoDir, branch, dirOverride);
        const from = typeof values.from === "string" ? values.from : null;
        try {
          createWorktree2(repoDir, branch, wtPath, { newBranch: true, from });
        } catch (err) {
          if (err instanceof WorktreeError2 && err.code === "BRANCH_EXISTS" && !from) {
            createWorktree2(repoDir, branch, wtPath, { newBranch: false });
          } else {
            throw err;
          }
        }
        const sessionName = worktreeSessionName2(projectName, branch);
        if (!values["no-session"]) {
          await openWorktreeSession(wtPath, sessionName);
        }
        if (json) {
          console.log(
            JSON.stringify({
              branch,
              path: wtPath,
              session: values["no-session"] ? null : sessionName
            })
          );
        } else if (values["no-session"]) {
          console.log(`Worktree ready: ${wtPath}`);
          console.log(`Open a session later:  tmux-ide worktree open '${branch}'`);
        } else {
          printSwitchHint(sessionName, wtPath);
        }
        break;
      }
      if (sub === "open") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree open <branch>", {
            code: "USAGE",
            exitCode: 1
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(
            `No worktree for branch "${branch}". Create one with: tmux-ide worktree create '${branch}'`,
            { code: "USAGE", exitCode: 1 }
          );
        }
        const sessionName = worktreeSessionName2(projectName, branch);
        const already = hasSession2(sessionName);
        if (!already) await openWorktreeSession(entry.path, sessionName);
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, session: sessionName, created: !already })
          );
        } else {
          if (already) console.log(`Session already running.`);
          printSwitchHint(sessionName, entry.path);
        }
        break;
      }
      if (sub === "remove") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree remove <branch> [--force]", {
            code: "USAGE",
            exitCode: 1
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(`No worktree for branch "${branch}".`, {
            code: "USAGE",
            exitCode: 1
          });
        }
        removeWorktree2(repoDir, entry.path, { force: values.force === true });
        const sessionName = worktreeSessionName2(projectName, branch);
        const killed = hasSession2(sessionName) ? killSession2(sessionName).stopped : false;
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, sessionKilled: killed, removed: true })
          );
        } else {
          console.log(`Removed worktree ${entry.path}${killed ? ` (killed ${sessionName})` : ""}.`);
        }
        break;
      }
      const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
      const { listTeamSessions: listTeamSessions2 } = await Promise.resolve().then(() => (init_sessions2(), sessions_exports));
      const sessions = listTeamSessions2(createStatusTracker2());
      const rows = worktrees.map((wt) => {
        const isPrimary = wt.path === mainPath;
        const candidates = [];
        if (isPrimary) candidates.push(projectName);
        if (wt.branch) candidates.push(worktreeSessionName2(projectName, wt.branch));
        const match = sessions.find((s) => candidates.includes(s.name)) ?? null;
        return {
          path: wt.path,
          branch: wt.branch,
          primary: isPrimary,
          session: match?.name ?? null,
          running: match !== null,
          status: match?.status ?? null
        };
      });
      if (json) {
        console.log(JSON.stringify({ repo: mainPath, worktrees: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log("No worktrees.");
      } else {
        for (const r of rows) {
          const tag = r.primary ? " (primary)" : "";
          const state = r.running ? `${r.status} \xB7 ${r.session}` : "no session";
          console.log(`${r.branch ?? "(detached)"}${tag}  ${state}
    ${r.path}`);
        }
      }
      break;
    }
    case "update": {
      if (values["tui-binary"] === true) {
        const { downloadTuiBinary: downloadTuiBinary2 } = await Promise.resolve().then(() => (init_tui_binary(), tui_binary_exports));
        const { path: path2 } = await downloadTuiBinary2({ log: (m) => console.error(m) });
        if (json) {
          console.log(JSON.stringify({ ok: true, path: path2 }, null, 2));
        } else {
          console.log(`TUI binary ready: ${path2}`);
        }
        break;
      }
      const { runUpdate: runUpdate2 } = await Promise.resolve().then(() => (init_update(), update_exports));
      const dryRun = values["dry-run"] === true;
      const plan = runUpdate2({ cliDir: __dirname6, dryRun });
      if (!dryRun) {
        const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
        if (plan.method === "dev") {
          const result = syncSkill2();
          console.log("");
          console.log(`skill: ${result.action} \u2192 ${result.path} (v${result.to})`);
        } else {
          console.log("");
          console.log("skill: refreshed by the package postinstall (~/.claude/skills/tmux-ide)");
        }
      }
      break;
    }
    case "skill-sync": {
      const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
      const result = syncSkill2();
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const detail = result.action === "updated" && result.from ? ` (v${result.from} \u2192 v${result.to})` : ` (v${result.to})`;
        console.log(`skill ${result.action}${detail}: ${result.path}`);
      }
      break;
    }
    case "serve": {
      const { startControlServer: startControlServer2, defaultControlSocketPath: defaultControlSocketPath2 } = await Promise.resolve().then(() => (init_server2(), server_exports2));
      const socketPath = typeof socketFlag === "string" ? socketFlag : positionals[1] ?? defaultControlSocketPath2();
      const server = await startControlServer2({
        socketPath,
        log: (m) => console.error(`[serve] ${m}`)
      });
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void server.close().then(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      await new Promise(() => {
      });
      break;
    }
    case "command-center": {
      const { startCommandCenter: startCommandCenter2 } = await Promise.resolve().then(() => (init_command_center(), command_center_exports));
      await startCommandCenter2({ port: parseInt(values.port ?? "4000") });
      break;
    }
    case "server": {
      if ("bun" in process.versions) {
        const scriptPath = resolve23(__dirname6, "../packages/daemon/src/server/standalone.ts");
        const serverArgs = ["--experimental-strip-types", scriptPath];
        if (values.port) serverArgs.push("--port", values.port);
        execFileSync14("node", serverArgs, { stdio: "inherit" });
      } else {
        const { start: start2 } = await Promise.resolve().then(() => (init_server3(), server_exports3));
        await start2(values.port ? parseInt(values.port, 10) : void 0);
      }
      break;
    }
    case "help":
      printHelp();
      break;
    default:
      throw new IdeError(`Unknown command: ${command}
Run "tmux-ide help" for usage.`, {
        code: "USAGE",
        exitCode: 1
      });
  }
} catch (error) {
  if (error instanceof IdeError) {
    printCommandError(error, { json });
  } else {
    throw error;
  }
}
var printSwitchHint2;
