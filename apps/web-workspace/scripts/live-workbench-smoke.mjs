// Real, isolated daemon/browser acceptance. Requires built CLI/native tmux and Playwright Chromium.
// All processes and tmux sessions created here belong to a private temporary directory.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../desktop-renderer/package.json", import.meta.url));
const { chromium } = require("playwright");
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { widgetMarkerAnnouncement } from "../../../packages/contracts/src/pane-widget-marker.ts";
const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const root = mkdtempSync("/tmp/tmi-webqa-");
const socket = root + "/tmux.sock";
for (const d of ["home", "state", "registry"]) mkdirSync(root + "/" + d);
const env = {
  ...process.env,
  HOME: root + "/home",
  TMUX_IDE_HOME: root + "/state",
  TMUX_IDE_DAEMON_INFO_DIR: root + "/state",
  TMUX_IDE_REGISTRY_DIR: root + "/registry",
  TMUX_IDE_TMUX_SOCKET_PATH: socket,
  TMUX_IDE_TMUX_BIN:
    repo + "/packages/daemon/dist/native/tmux/" + process.platform + "-" + process.arch + "/tmux",
};
delete env.TMUX;
delete env.TMUX_PANE;
delete env.TMUX_IDE_TMUX_SOCKET_NAME;
const tmux = (args) =>
  execFileSync(env.TMUX_IDE_TMUX_BIN, ["-S", socket, "-f", "/dev/null", ...args], {
    env,
    encoding: "utf8",
  }).trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 150; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* Readiness and cleanup tolerate resources not being available yet. */
    }
    await delay(100);
  }
  throw Error("Timed out: " + label);
}
const owned = [];
let browser;
function start(command, args, extra = {}) {
  const log = openSync(root + "/" + (owned.length ? "vite" : "daemon") + ".log", "w");
  const child = spawn(command, args, {
    cwd: repo,
    env: { ...env, ...extra },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  owned.push(child);
  return child;
}
try {
  const pane = tmux([
    "new-session",
    "-d",
    "-s",
    "workbench-check",
    "-x",
    "120",
    "-y",
    "40",
    "-P",
    "-F",
    "#{pane_id}",
    "/bin/cat",
  ]);
  env.TMUX =
    socket + "," + tmux(["display-message", "-p", "-t", "workbench-check", "#{pid}"]) + ",0";
  tmux(["set-option", "-w", "-t", "workbench-check", "pane-border-status", "top"]);
  tmux(["split-window", "-d", "-v", "-t", pane, "/bin/cat"]);
  start(process.execPath, [repo + "/bin/cli.js", "--headless", "--json"]);
  const info = await until(() => {
    const d = JSON.parse(readFileSync(root + "/state/daemon.json"));
    return fetch("http://127.0.0.1:" + d.port + "/healthz").then((r) => r.ok && d);
  }, "daemon");
  execFileSync(process.execPath, [repo + "/bin/cli.js", "adopt", "workbench-check", "--json"], {
    env,
    cwd: root,
    stdio: "pipe",
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  start(
    process.execPath,
    [
      repo + "/apps/web-workspace/node_modules/vite/bin/vite.js",
      repo + "/apps/web-workspace",
      "--config",
      repo + "/apps/web-workspace/vite.config.ts",
    ],
    {
      VITE_TMUX_IDE_DEV_GATEWAY: "1",
      TMUX_IDE_DEV_DAEMON_URL: "http://127.0.0.1:" + info.port,
      TMUX_IDE_DEV_OWNER_TOKEN: info.authToken,
      TMUX_IDE_DEV_SERVER_PORT: String(port),
    },
  );
  await until(() => fetch("http://127.0.0.1:" + port).then((r) => r.ok), "vite");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const sockets = [];
  await page.routeWebSocket("**/*", (socket) => {
    sockets.push(socket);
    socket.connectToServer();
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:" + port + "/?devHost=1");
  await page
    .getByRole("button", { name: /^workbench-check/ })
    .first()
    .click({ timeout: 20000 });
  await page.locator(".live-terminal .xterm").first().waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Take input control", exact: true }).click();
  await page.getByRole("button", { name: "Release input control", exact: true }).waitFor();
  await delay(1200);
  await page.locator(".live-terminal .xterm-helper-textarea").first().focus();
  await page.keyboard.type("WORKBENCH_INPUT_OK");
  await page.keyboard.press("Enter");
  await until(
    () => tmux(["capture-pane", "-p", "-t", pane]).includes("WORKBENCH_INPUT_OK"),
    "live keyboard input",
  );
  const terminalScreen = await page.locator(".live-terminal .xterm-screen").first().boundingBox();
  assert.ok(terminalScreen);
  await delay(200);
  await page.mouse.move(terminalScreen.x + 1, terminalScreen.y + 8);
  await page.mouse.down();
  await page.mouse.move(terminalScreen.x + 180, terminalScreen.y + 8, { steps: 12 });
  await page.mouse.up();
  const copied = await page
    .locator(".live-terminal .xterm-helper-textarea")
    .first()
    .evaluate((el) => {
      const clipboardData = new globalThis.DataTransfer();
      el.dispatchEvent(
        new globalThis.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
      );
      return clipboardData.getData("text/plain");
    });
  assert.ok(copied.includes("WORKBENCH_INPUT_OK"), "selected terminal text copied");
  const divider = page.getByRole("separator", { name: "Resize pane rows" });
  await divider.focus();
  const before = Number(tmux(["display-message", "-p", "-t", pane, "#{pane_height}"]));
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
  await until(
    () => Number(tmux(["display-message", "-p", "-t", pane, "#{pane_height}"])) === before + 5,
    "five keyboard increments",
  );
  const after = Number(tmux(["display-message", "-p", "-t", pane, "#{pane_height}"]));
  await page
    .getByRole("button", { name: /^Zoom / })
    .first()
    .click();
  await until(
    () => tmux(["display-message", "-p", "-t", "workbench-check", "#{window_zoomed_flag}"]) === "1",
    "zoom",
  );
  await page
    .getByRole("button", { name: /^Unzoom / })
    .first()
    .click();
  await until(
    () => tmux(["display-message", "-p", "-t", "workbench-check", "#{window_zoomed_flag}"]) === "0",
    "unzoom",
  );
  await until(
    () => page.getByRole("separator", { name: "Resize pane rows" }).isVisible(),
    "divider after unzoom",
  );
  const box = await divider.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 36, { steps: 8 });
  await page.mouse.up();
  await until(
    () => Number(tmux(["display-message", "-p", "-t", pane, "#{pane_height}"])) < after,
    "pointer resize",
  );
  await until(
    async () =>
      Number(await divider.getAttribute("aria-valuenow")) ===
      Number(tmux(["display-message", "-p", "-t", pane, "#{pane_height}"])),
    "rendered resize acknowledgement",
  );
  await delay(300);
  const oldTop = tmux(["display-message", "-p", "-t", pane, "#{pane_top}"]);
  const handles = page.getByRole("button", { name: /^Move / });
  await handles.nth(0).dragTo(handles.nth(1));
  await until(
    () => tmux(["display-message", "-p", "-t", pane, "#{pane_top}"]) !== oldTop,
    "pointer swap",
  );
  await page
    .getByRole("button", { name: /^Split .* right$/ })
    .first()
    .click();
  await until(
    () =>
      tmux(["list-panes", "-t", "workbench-check", "-F", "#{pane_id}"]).split("\n").length === 3,
    "split",
  );
  const announcement = widgetMarkerAnnouncement("markdown", {
    text: "# Live widget check\n\nShared daemon **Markdown** renders here.",
  });
  const producer = root + "/widget.mjs";
  writeFileSync(
    producer,
    "process.stdout.write(" + JSON.stringify(announcement) + ");process.stdin.resume();",
  );
  tmux(["respawn-pane", "-k", "-t", pane, process.execPath + " " + producer]);
  await page.getByRole("heading", { name: "Live widget check", exact: true }).waitFor();
  await page.getByRole("button", { name: "Show terminal", exact: true }).click();
  await page.getByRole("button", { name: "Show widget", exact: true }).click();
  await page.getByRole("heading", { name: "Live widget check", exact: true }).waitFor();
  for (const themeName of ["Light", "Dark", "Ocean"]) {
    await page.getByRole("button", { name: "Open commands", exact: true }).click();
    await page.getByRole("combobox", { name: "Search commands" }).fill("Theme: " + themeName);
    await page.getByRole("option", { name: "Theme: " + themeName, exact: true }).click();
    for (const width of [800, 1200]) {
      await page.setViewportSize({ width, height: 800 });
      await delay(300);
      await page.screenshot({ path: root + "/live-" + themeName + "-" + width + ".png" });
      const dimensions = await page.locator(".dw-app-chrome").evaluate((el) => ({
        chrome: el.getBoundingClientRect().height,
        doc: globalThis.document.documentElement.scrollWidth,
        viewport: globalThis.innerWidth,
      }));
      assert.ok(
        dimensions.doc <= dimensions.viewport,
        "document horizontal overflow " + JSON.stringify(dimensions),
      );
    }
  }
  const historySemantic = await page
    .locator(".live-pane")
    .filter({ has: page.getByRole("heading", { name: "Live widget check", exact: true }) })
    .getAttribute("data-semantic-pane");
  const historyProducer = root + "/history.mjs";
  writeFileSync(
    historyProducer,
    "for(let i=0;i<200;i++)process.stdout.write('HISTORY_'+String(i).padStart(4,'0')+'\\r\\n');process.stdin.resume();",
  );
  tmux(["respawn-pane", "-k", "-t", pane, process.execPath + " " + historyProducer]);
  await until(
    () =>
      page
        .getByRole("heading", { name: "Live widget check", exact: true })
        .count()
        .then((n) => n === 0),
    "widget clears for new output",
  );
  const historyPane = page.locator('[data-semantic-pane="' + historySemantic + '"]');
  await delay(800);
  const historyScreen = await historyPane.locator(".xterm-screen").boundingBox();
  assert.ok(historyScreen);
  await page.mouse.move(historyScreen.x + 30, historyScreen.y + 10);
  for (let i = 0; i < 105; i++) await page.mouse.wheel(0, -120);
  await delay(300);
  await page.mouse.move(historyScreen.x + 1, historyScreen.y + 8);
  await page.mouse.down();
  await page.mouse.move(historyScreen.x + 145, historyScreen.y + 8, { steps: 10 });
  await page.mouse.up();
  const historyCopy = await historyPane.locator(".xterm-helper-textarea").evaluate((el) => {
    const clipboardData = new globalThis.DataTransfer();
    el.dispatchEvent(
      new globalThis.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
    );
    return clipboardData.getData("text/plain");
  });
  assert.ok(
    historyCopy.includes("HISTORY_0000"),
    "oldest streamed history is locally scrollable; got " + JSON.stringify(historyCopy),
  );
  await page.mouse.move(historyScreen.x + 30, historyScreen.y + 10);
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 10000);
  await page.mouse.wheel(0, -10000);
  await page.keyboard.up("Shift");
  await delay(100);
  await page.mouse.move(historyScreen.x + 1, historyScreen.y + 8);
  await page.mouse.down();
  await page.mouse.move(historyScreen.x + 145, historyScreen.y + 8, { steps: 10 });
  await page.mouse.up();
  const shiftCopy = await historyPane.locator(".xterm-helper-textarea").evaluate((el) => {
    const clipboardData = new globalThis.DataTransfer();
    el.dispatchEvent(
      new globalThis.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
    );
    return clipboardData.getData("text/plain");
  });
  assert.ok(shiftCopy.includes("HISTORY_0000"), "Shift returns to oldest retained history");
  // A background window expands the leased pane set and forces canonical reseeds
  // without changing the geometry/history of the pane being read.
  tmux(["new-window", "-d", "-t", "workbench-check", "-n", "reseed-check", "/bin/cat"]);
  await page
    .getByRole("button", { name: /reseed-check/ })
    .first()
    .waitFor();
  await delay(800);
  const reseedScreen = await historyPane.locator(".xterm-screen").boundingBox();
  assert.ok(reseedScreen);
  await page.mouse.move(reseedScreen.x + 1, reseedScreen.y + 8);
  await page.mouse.down();
  await page.mouse.move(reseedScreen.x + 145, reseedScreen.y + 8, { steps: 10 });
  await page.mouse.up();
  const reseedCopy = await historyPane.locator(".xterm-helper-textarea").evaluate((el) => {
    const clipboardData = new globalThis.DataTransfer();
    el.dispatchEvent(
      new globalThis.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
    );
    return clipboardData.getData("text/plain");
  });
  assert.ok(
    reseedCopy.includes("HISTORY_0000"),
    "canonical reseed keeps the oldest visible history row; got " + JSON.stringify(reseedCopy),
  );
  const socketsBefore = sockets.length;
  const paneSocket = sockets.filter((socket) => socket.url().includes("pane-stream")).at(-1);
  assert.ok(paneSocket, "active pane stream socket");
  await paneSocket.close({ code: 1012, reason: "isolated reconnect test" });
  await until(() => sockets.length > socketsBefore, "pane transport reconnect");
  await delay(1000);
  const reconnectedScreen = await historyPane.locator(".xterm-screen").boundingBox();
  assert.ok(reconnectedScreen);
  await page.mouse.move(reconnectedScreen.x + 1, reconnectedScreen.y + 8);
  await page.mouse.down();
  await page.mouse.move(reconnectedScreen.x + 145, reconnectedScreen.y + 8, { steps: 10 });
  await page.mouse.up();
  const reconnectCopy = await historyPane.locator(".xterm-helper-textarea").evaluate((el) => {
    const clipboardData = new globalThis.DataTransfer();
    el.dispatchEvent(
      new globalThis.ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
    );
    return clipboardData.getData("text/plain");
  });
  assert.ok(
    reconnectCopy.includes("HISTORY_0000"),
    "reconnect preserves reader position; got " + JSON.stringify(reconnectCopy),
  );
  assert.equal(
    await page
      .getByText("Could not split the pane. Check input control and try again.", { exact: true })
      .count(),
    0,
  );
  await page.screenshot({ path: root + "/workbench.png" });
  assert.deepEqual(errors, []);
  writeFileSync(
    root + "/result.json",
    JSON.stringify(
      {
        passed: true,
        before,
        after,
        zoom: true,
        historyReseed: true,
        historyReconnect: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ root, passed: true, before, after }));
} catch (e) {
  writeFileSync(root + "/error.txt", String(e.stack || e));
  console.error(root, e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const c of owned.reverse()) {
    if (c.exitCode === null) {
      c.kill("SIGTERM");
      await Promise.race([new Promise((r) => c.once("exit", r)), delay(2000)]);
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    }
  }
  try {
    tmux(["kill-server"]);
  } catch {
    /* Readiness and cleanup tolerate resources not being available yet. */
  }
}
