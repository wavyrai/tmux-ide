/**
 * Live proof for the browser-only development host (m44.2).
 *
 * Drives the WHOLE seam against real infrastructure — a real tmux server, a
 * real daemon, a real Vite dev server, and a real headless Chromium — and
 * proves three things from inside the browser context:
 *
 *   a. the app boots as a LIVE runtime, not the preview fallback
 *      (`data-shell-source="runtime"` with a connected daemon);
 *   b. the fleet catalog reaches the page — the scratch session appears in the
 *      DOM, fetched over the daemon's owner-gated HTTP route; and
 *   c. a pane-stream WebSocket connects and seeds from the page's own origin —
 *      the lease is issued and redeemed by browser code, so the daemon's
 *      Origin binding is satisfied by `http://127.0.0.1:<vite port>`.
 *
 * Everything it touches is disposable and PID-scoped: an isolated tmux socket
 * under /tmp, a scratch session, temp HOME/registry/settings/daemon-info, and
 * only the daemon, Vite, and browser processes this script started. Cleanup
 * runs on every exit path.
 *
 * Run it with: node apps/desktop-renderer/scripts/dev-web-host-live-proof.mjs
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

// NOT `zz-`-prefixed: daemon discovery hides `zz-` and `_` sessions from the
// fleet, so a `zz-` session could never reach the page under test.
const SESSION_NAME = `webhost-zz-${process.pid}`;
const MAX_UNIX_SOCKET_PATH = 103;
const DAEMON_READY_TIMEOUT_MS = 45_000;
const VITE_READY_TIMEOUT_MS = 60_000;
const FLEET_TIMEOUT_MS = 30_000;
const STREAM_TIMEOUT_MS = 30_000;

const cleanups = [];
let failed = false;

function log(message) {
  console.log(`[web-host-proof] ${message}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function pollUntil({ probe, detail, timeoutMs, intervalMs = 150 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${detail}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function reservePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(address.port));
    });
  });
}

async function createScratchFleet() {
  // /tmp, not os.tmpdir(): on macOS the per-user temp dir realpaths to a long
  // prefix and pushes the tmux socket past the 104-byte sun_path limit.
  const root = await mkdtemp("/tmp/tmi-webhost-");
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const projectDir = join(root, "project");
  const daemonInfoDir = join(root, "daemon");
  const registryDir = join(root, "registry");
  const settingsDir = join(root, "settings");
  const socketPath = join(root, "t.sock");
  const resolvedLength = realpathSync(root).length + "/t.sock".length;
  if (resolvedLength > MAX_UNIX_SOCKET_PATH) {
    throw new Error(`scratch tmux socket resolves to ${resolvedLength} bytes, over the limit`);
  }
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(daemonInfoDir, { recursive: true, mode: 0o700 }),
    mkdir(registryDir, { recursive: true, mode: 0o700 }),
    mkdir(settingsDir, { recursive: true, mode: 0o700 }),
  ]);

  const tmuxBin = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const runTmux = (argv) =>
    execFileSync(tmuxBin, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      env: { TERM: process.env.TERM ?? "xterm-256color", PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  runTmux([
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    SESSION_NAME,
    "-c",
    projectDir,
    "-n",
    "one",
    "exec sh -i",
  ]);
  cleanups.push(async () => {
    await execFileAsync(tmuxBin, ["-S", socketPath, "kill-server"]).catch(() => undefined);
  });
  runTmux([
    "new-window",
    "-d",
    "-t",
    `=${SESSION_NAME}:`,
    "-c",
    projectDir,
    "-n",
    "two",
    "exec sh -i",
  ]);
  // The durable adopt stamp: the fleet catalog enumerates adopted sessions only.
  runTmux(["set-option", "-t", SESSION_NAME, "@tmux_ide_adopted", "1"]);
  const tmuxServerPid = Number(runTmux(["display-message", "-p", "-t", SESSION_NAME, "#{pid}"]));
  log(`scratch fleet up: ${SESSION_NAME} on ${socketPath} (tmux pid ${tmuxServerPid})`);

  return {
    root,
    daemonInfoDir,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TMUX: `${socketPath},${tmuxServerPid},0`,
      TMUX_IDE_TMUX_BIN: tmuxBin,
      TMUX_IDE_DAEMON_INFO_DIR: daemonInfoDir,
      TMUX_IDE_REGISTRY_DIR: registryDir,
      TMUX_IDE_SETTINGS_DIR: settingsDir,
      TMUX_IDE_HOME: join(root, "state"),
      TMUX_IDE_CONFIG: join(root, "state", "config.json"),
    },
  };
}

async function startDaemon(fleet) {
  const environment = { ...process.env, ...fleet.environment };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.TMUX_PANE;
  delete environment.TMUX_TMPDIR;
  let output = "";
  const child = spawn(process.execPath, [join(repoRoot, "bin", "cli.js"), "--headless"], {
    cwd: repoRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });

  const canonical = await pollUntil({
    probe: async () => {
      if (child.exitCode !== null) throw new Error(`daemon exited (${child.exitCode})\n${output}`);
      const record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
      return record?.port && record?.authToken ? record : null;
    },
    detail: "the daemon to publish its canonical record",
    timeoutMs: DAEMON_READY_TIMEOUT_MS,
  });
  cleanups.push(async () => {
    if (Number.isInteger(canonical.pid) && processIsAlive(canonical.pid)) {
      process.kill(canonical.pid, "SIGTERM");
    }
  });
  log(`daemon ready on port ${canonical.port} (pid ${canonical.pid})`);
  return canonical;
}

/** Promote the scratch session so its panes become attachable resources. */
async function promoteScratchSession(canonical) {
  const base = `http://127.0.0.1:${canonical.port}`;
  const owner = { Authorization: `Bearer ${canonical.authToken}` };
  const session = await pollUntil({
    probe: async () => {
      const response = await fetch(`${base}/api/resources/fleet-catalog`, { headers: owner });
      if (!response.ok) return null;
      const body = await response.json();
      // The catalog exposes a session by its display `label`; raw tmux session
      // names and pane ids stay daemon-side.
      return body.sessions?.find((entry) => entry.label === SESSION_NAME) ?? null;
    },
    detail: `the scratch session ${SESSION_NAME} in the fleet catalog`,
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 200,
  });
  const response = await fetch(`${base}/api/v2/action/workspace.promote`, {
    method: "POST",
    headers: {
      ...owner,
      "Content-Type": "application/json",
      "X-Tmux-Ide-Operation-Id": randomUUID(),
    },
    body: JSON.stringify({ sessionId: session.sessionId }),
  });
  const body = await response.json();
  if (body?.ok !== true) throw new Error(`workspace.promote refused: ${JSON.stringify(body)}`);
  const workspaceName = body.result?.resource?.workspaceName;
  log(`promoted ${SESSION_NAME} to workspace ${workspaceName} (${body.result.outcome})`);
  return workspaceName;
}

async function startVite(canonical, vitePort) {
  const daemonUrl = `http://127.0.0.1:${canonical.port}`;
  let output = "";
  const child = spawn("npx", ["vite", "--host", "127.0.0.1"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      TMUX_IDE_DEV_SERVER_PORT: String(vitePort),
      VITE_TMUX_IDE_DEV_HOST: "1",
      VITE_TMUX_IDE_DEV_DAEMON_URL: daemonUrl,
      VITE_TMUX_IDE_DEV_OWNER_TOKEN: canonical.authToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  const pageUrl = `http://127.0.0.1:${vitePort}/`;
  const headers = await pollUntil({
    probe: async () => {
      if (child.exitCode !== null) throw new Error(`vite exited (${child.exitCode})\n${output}`);
      const response = await fetch(pageUrl);
      return response.ok ? response.headers : null;
    },
    detail: "the vite dev server",
    timeoutMs: VITE_READY_TIMEOUT_MS,
  });
  const csp = headers.get("content-security-policy") ?? "";
  if (!csp.includes(daemonUrl)) {
    throw new Error(`the dev CSP did not admit the daemon origin ${daemonUrl}\n${csp}`);
  }
  log(`vite ready on ${pageUrl}; CSP admits ${daemonUrl}`);
  return { pageUrl, daemonUrl };
}

async function proveInBrowser({ pageUrl, daemonUrl }, workspaceName, root) {
  const browser = await chromium.launch();
  cleanups.push(async () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1_400, height: 900 } });
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (!response.ok()) failedRequests.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await page.goto(`${pageUrl}?devHost=1`, { waitUntil: "domcontentloaded" });

  // (a) The app booted LIVE — not the preview fallback, not a hard error.
  const shellSource = await pollUntil({
    probe: async () => {
      const value = await page.getAttribute(".app", "data-shell-source");
      return value === "runtime" ? value : null;
    },
    detail: 'the app shell to report data-shell-source="runtime"',
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 250,
  });
  log(`rung a: the app booted live (data-shell-source="${shellSource}")`);

  // (b) The fleet catalog reached the page. Asserted at the host boundary
  //     first — the session name alone could have come from the app-shell
  //     resource — and then in the rendered DOM.
  const catalog = await page.evaluate(async () => {
    const result = await globalThis.window.tmuxIdeHost.daemon.fetchFleetCatalog();
    if (result.status !== "ok") return { ok: false, reason: JSON.stringify(result.error) };
    return {
      ok: true,
      sessionCount: result.envelope.sessions.length,
      labels: result.envelope.sessions.map((session) => session.label),
    };
  });
  if (!catalog.ok) throw new Error(`rung b failed: fetchFleetCatalog: ${catalog.reason}`);
  if (!catalog.labels.includes(SESSION_NAME)) {
    throw new Error(
      `rung b failed: fleet catalog lacks ${SESSION_NAME}: ${catalog.labels.join(",")}`,
    );
  }
  log(
    `rung b: host fetchFleetCatalog returned ${catalog.sessionCount} session(s): ${catalog.labels.join(", ")}`,
  );

  // The fleet sidebar must leave its loading state: that proves the store's
  // own subscribe-then-fetch cycle completed through this host, not just that
  // a direct call works.
  await pollUntil({
    probe: async () => {
      const rendered = await page.locator(".fleet-sidebar h2 span").innerText();
      return Number(rendered) > 0 ? rendered : null;
    },
    detail: "the fleet sidebar to render a non-zero session count",
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 250,
  }).catch(async (error) => {
    const state = await page
      .getAttribute(".fleet-sidebar__quiet", "data-fleet-state")
      .catch(() => null);
    throw new Error(`${error.message} (fleet sidebar state: ${state ?? "none"})`);
  });
  log("rung b: the fleet sidebar store settled with the session rendered");

  const fleetText = await pollUntil({
    probe: async () => {
      const text = await page.locator("body").innerText();
      return text.includes(SESSION_NAME) ? text : null;
    },
    detail: `the scratch session ${SESSION_NAME} to render in the page`,
    timeoutMs: FLEET_TIMEOUT_MS,
    intervalMs: 250,
  });
  const excerpt = fleetText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 24)
    .join(" | ");
  log(`rung b: fleet catalog rendered. DOM text: ${excerpt}`);

  // The scratch root is deleted on cleanup; point TMUX_IDE_PROOF_ARTIFACTS at a
  // durable directory to keep the evidence.
  const artifactDir = process.env.TMUX_IDE_PROOF_ARTIFACTS || root;
  // The daemon event socket must reach `connection.changed{state:"live"}`:
  // without it the shell falls back to "showing last live workspace" and never
  // refreshes on fleet or agent-status changes.
  const events = await page.evaluate(async () => {
    const seen = [];
    const result = await globalThis.window.tmuxIdeHost.daemon.subscribe(
      { workspaceNames: [] },
      (event) => seen.push(event),
    );
    if (result.status !== "subscribed") {
      return { ok: false, reason: `subscribe: ${JSON.stringify(result.error)}` };
    }
    const live = await new Promise((done) => {
      const deadline = Date.now() + 10_000;
      const tick = setInterval(() => {
        if (seen.some((event) => event.type === "connection.changed" && event.state === "live")) {
          clearInterval(tick);
          done(true);
        } else if (Date.now() > deadline) {
          clearInterval(tick);
          done(false);
        }
      }, 100);
    });
    result.unsubscribe();
    return { ok: live, seen: seen.map((event) => event.type) };
  });
  if (!events.ok) {
    throw new Error(
      `rung b failed: the daemon event socket never went live: ${events.reason ?? `saw [${events.seen}]`}`,
    );
  }
  log(
    `rung b: daemon event socket live (events: ${events.seen.join(", ") || "connection.changed"})`,
  );

  const screenshot = join(artifactDir, "dev-web-host.png");
  await page.screenshot({ path: screenshot, fullPage: false });
  log(`screenshot written to ${screenshot}`);

  // (c) A pane-stream lease issues AND its WebSocket seeds — from the page's
  //     own origin, through the host the page is actually running.
  const stream = await page.evaluate(
    async ({ workspaceName, timeoutMs }) => {
      const host = globalThis.window.tmuxIdeHost;
      if (!host) return { ok: false, reason: "globalThis.window.tmuxIdeHost is absent" };
      const shell = await host.daemon.fetchApplicationShell({ workspaceName });
      if (shell.status !== "ok") {
        return { ok: false, reason: `application-shell: ${JSON.stringify(shell.error)}` };
      }
      const resources = shell.envelope.resource?.terminalInventory?.resources ?? [];
      const pane = resources.find((entry) => entry.attachability?.status === "available");
      if (!pane) {
        return {
          ok: false,
          reason: `no attachable pane among ${resources.length}: ${resources
            .map((entry) => entry.attachability?.status)
            .join(",")}`,
        };
      }
      const paneId = pane.attachability.semanticPaneId ?? pane.id;
      const issued = await host.daemon.issuePaneStream({
        protocolVersion: 1,
        workspaceName,
        panes: [paneId],
        viewerMode: "interactive",
      });
      if (issued.status !== "issued") {
        return { ok: false, reason: `issue: ${JSON.stringify(issued.error)}`, paneId };
      }
      const descriptor = issued.descriptor;
      return await new Promise((done) => {
        const socket = new WebSocket(descriptor.webSocketUrl, descriptor.subprotocol);
        const frames = [];
        const finish = (value) => {
          try {
            socket.close();
          } catch {
            /* already closing */
          }
          done(value);
        };
        const timer = setTimeout(
          () => finish({ ok: false, reason: "timed out waiting for a seed batch", frames, paneId }),
          timeoutMs,
        );
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify({
              type: "redeem",
              protocolVersion: 1,
              ticket: descriptor.redemptionTicket,
              requestId: descriptor.requestId,
              daemonInstanceId: descriptor.daemonInstanceId,
            }),
          );
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          let frame;
          try {
            frame = JSON.parse(event.data);
          } catch {
            return;
          }
          frames.push(frame.type);
          if (frame.type === "error") {
            clearTimeout(timer);
            finish({ ok: false, reason: `stream error: ${frame.code}`, frames, paneId });
          }
          if (frame.type === "seed-batch") {
            clearTimeout(timer);
            finish({ ok: true, frames, paneId, subprotocol: socket.protocol });
          }
        });
        socket.addEventListener("error", () => {
          clearTimeout(timer);
          finish({ ok: false, reason: "the WebSocket failed to connect", frames, paneId });
        });
      });
    },
    { workspaceName, timeoutMs: STREAM_TIMEOUT_MS },
  );
  if (!stream.ok)
    throw new Error(`rung c failed: ${stream.reason} (frames: ${stream.frames?.join(",")})`);
  log(
    `rung c: pane-stream connected and seeded ${stream.paneId} over subprotocol ` +
      `${stream.subprotocol}; frames: ${stream.frames.join(",")}`,
  );

  // (d) The interactive terminal attachment — the tile's own path, which the
  //     app starts by itself on load through `issueTerminalAttachment`.
  await pollUntil({
    probe: async () => {
      const text = await page.locator("body").innerText();
      return text.includes("Connecting to tmux") ? null : true;
    },
    detail: "the terminal tile to leave its connecting state",
    timeoutMs: 30_000,
    intervalMs: 500,
  });
  log("rung d: the interactive terminal attachment settled");

  const cspRefusals = consoleErrors.filter((line) => /content security policy/iu.test(line));
  if (cspRefusals.length > 0) {
    throw new Error(`the page logged CSP refusals:\n${cspRefusals.join("\n")}`);
  }
  if (failedRequests.length > 0) {
    log(
      `note: ${failedRequests.length} non-ok response(s): ${failedRequests.slice(0, 5).join(" | ")}`,
    );
  }
  await writeFile(join(artifactDir, "dom-text.txt"), fleetText, "utf8");
  return { screenshot, daemonUrl };
}

async function main() {
  const fleet = await createScratchFleet();
  const canonical = await startDaemon(fleet);
  const workspaceName = await promoteScratchSession(canonical);
  const vitePort = await reservePort();
  const server = await startVite(canonical, vitePort);
  await proveInBrowser(server, workspaceName, fleet.root);
  log("PASS — the renderer ran live in a plain browser against a real daemon");
}

try {
  await main();
} catch (error) {
  failed = true;
  console.error(`[web-host-proof] FAIL: ${error.message}`);
} finally {
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch((error) => console.error("[web-host-proof] cleanup failed", error));
  }
  process.exit(failed ? 1 : 0);
}
