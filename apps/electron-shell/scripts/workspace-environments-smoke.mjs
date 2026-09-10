// Run AFTER build:workspace. Exercises built main/preload/renderer, never the installed app.
/* global DataTransfer, ClipboardEvent, location, window */
// SSH authentication itself is substituted; discovery, process ownership, real TCP forwarding,
// identity verification, scoped IPC, relay and terminal delivery use production code.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyRendererManifest } from "./renderer-artifact.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(packageRoot, "../..");
const requireRenderer = createRequire(join(repo, "apps/desktop-renderer/package.json"));
const { _electron: electron } = requireRenderer("playwright");
const requireShell = createRequire(join(packageRoot, "package.json"));
const electronPath = requireShell("electron");
const tmuxPath = join(
  repo,
  `packages/daemon/dist/native/tmux/${process.platform}-${process.arch}/tmux`,
);
const root = mkdtempSync(join(tmpdir(), "tmux-ide-environments-"));
const owned = [];
const fixtures = [];
const session = "same-session";
const remoteLabel = "Smoke remote";
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
let app;
let page;
let passed = false;
const evidence = {
  root,
  checks: [],
  limitations: [
    "An isolated SSH executable substitutes authentication and host-key negotiation. Real remote networking latency and credentials are not qualified.",
  ],
};
function check(name) {
  evidence.checks.push(name);
}
async function until(fn, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}
function tmux(fixture, args) {
  return execFileSync(tmuxPath, ["-S", fixture.socket, "-f", "/dev/null", ...args], {
    env: fixture.env,
    encoding: "utf8",
    timeout: 5000,
  }).trim();
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function start(command, args, env, logName) {
  const fd = openSync(join(root, logName), "w", 0o600);
  const child = spawn(command, args, { cwd: repo, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  owned.push(child);
  return child;
}
async function fixture(name) {
  const dir = join(root, name);
  mkdirSync(dir, { mode: 0o700 });
  for (const child of ["home", "state", "registry", "settings"])
    mkdirSync(join(dir, child), { mode: 0o700 });
  const env = {
    ...process.env,
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "home/.config"),
    TMUX_IDE_HOME: join(dir, "state"),
    TMUX_IDE_DAEMON_INFO_DIR: join(dir, "state"),
    TMUX_IDE_REGISTRY_DIR: join(dir, "registry"),
    TMUX_IDE_SETTINGS_DIR: join(dir, "settings"),
    TMUX_IDE_TMUX_SOCKET_PATH: join(dir, "tmux.sock"),
    TMUX_IDE_TMUX_BIN: tmuxPath,
  };
  for (const key of [
    "TMUX",
    "TMUX_PANE",
    "TMUX_IDE_TMUX_SOCKET_NAME",
    "TMUX_IDE_RENDERER_URL",
    "TMUX_IDE_SESSION",
    "TMUX_TMPDIR",
    "NODE_PATH",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    delete env[key];
  const f = {
    dir,
    env,
    socket: env.TMUX_IDE_TMUX_SOCKET_PATH,
    marker: `ENVIRONMENT_${name.toUpperCase()}_${randomUUID().slice(0, 8)}`,
  };
  fixtures.push(f);
  f.pane = tmux(f, [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "100",
    "-y",
    "30",
    "-P",
    "-F",
    "#{pane_id}",
    "/bin/cat",
  ]);
  env.TMUX = `${f.socket},${tmux(f, ["display-message", "-p", "-t", session, "#{pid}"])},0`;
  tmux(f, ["set-option", "-p", "-t", f.pane, "@tmux_ide_pane_id", `pane.smoke.${name}`]);
  start(
    process.execPath,
    [join(repo, "bin/cli.js"), "--headless", "--json"],
    env,
    `${name}-daemon.log`,
  );
  f.infoPath = join(dir, "state/daemon.json");
  f.info = await until(async () => {
    const info = JSON.parse(readFileSync(f.infoPath, "utf8"));
    return (await fetch(`http://127.0.0.1:${info.port}/healthz`)).ok && info;
  }, `${name} daemon`);
  execFileSync(process.execPath, [join(repo, "bin/cli.js"), "adopt", session, "--json"], {
    cwd: dir,
    env,
    stdio: "pipe",
    timeout: 15_000,
  });
  tmux(f, ["send-keys", "-t", f.pane, "-l", f.marker]);
  tmux(f, ["send-keys", "-t", f.pane, "Enter"]);
  return f;
}
function installSshShim(remote) {
  const bin = join(root, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const script = join(bin, "ssh");
  const source = `#!${process.execPath}
const {readFileSync,appendFileSync}=require('node:fs');
const {createServer,connect}=require('node:net');
const args=process.argv.slice(2);
const log=(kind,extra={})=>appendFileSync(process.env.SMOKE_SSH_LOG,JSON.stringify({kind,pid:process.pid,...extra})+'\\n');
if(!args.includes('smoke-owned-remote'))process.exit(64);
if(!args.includes('-N')){
 if(!args.includes('remote-daemon-info'))process.exit(64);
 log('discover'); process.stdout.write(JSON.stringify({version:1,daemon:JSON.parse(readFileSync(process.env.SMOKE_REMOTE_INFO,'utf8'))})+'\\n');
}else{
 const address=args[args.indexOf('-L')+1];
 const match=/^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(address||'');
 if(!match)process.exit(64);
 const expected=JSON.parse(readFileSync(process.env.SMOKE_REMOTE_INFO,'utf8'));
 if(Number(match[2])!==expected.port)process.exit(64);
 const sockets=new Set();
 const server=createServer(client=>{
  sockets.add(client); const upstream=connect({host:'127.0.0.1',port:Number(match[2])});sockets.add(upstream);
  client.pipe(upstream);upstream.pipe(client);
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  client.on('close',()=>{sockets.delete(client);upstream.destroy()});upstream.on('close',()=>{sockets.delete(upstream);client.destroy()});
 });
 server.on('error',()=>process.exit(1));
 server.listen(Number(match[1]),'127.0.0.1',()=>log('tunnel-ready',{port:Number(match[1])}));
 const stop=()=>{log('tunnel-stopped');for(const socket of sockets)socket.destroy();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),100).unref()};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
`;
  writeFileSync(script, source, { mode: 0o700 });
  chmodSync(script, 0o700);
  return {
    PATH: `${bin}:${process.env.PATH}`,
    SMOKE_REMOTE_INFO: remote.infoPath,
    SMOKE_SSH_LOG: join(root, "ssh-events.jsonl"),
  };
}
async function selectSession(label) {
  const machine = page
    .locator(".dw-sidebar")
    .getByRole("button")
    .filter({ hasText: label })
    .first();
  await machine.waitFor();
  if ((await machine.getAttribute("aria-expanded")) === "false") await machine.click();
  await machine
    .locator("..")
    .getByRole("button", { name: new RegExp(`^${session}`) })
    .first()
    .click();
  await page.locator(".live-terminal .xterm-helper-textarea").first().waitFor();
}
async function renderedText() {
  const screen = await page.locator(".live-terminal .xterm-screen").first().boundingBox();
  assert.ok(screen);
  await page.mouse.move(screen.x + 2, screen.y + 2);
  await page.mouse.down();
  await page.mouse.move(screen.x + screen.width - 3, screen.y + Math.min(screen.height - 3, 100), {
    steps: 8,
  });
  await page.mouse.up();
  return page
    .locator(".live-terminal .xterm-helper-textarea")
    .first()
    .evaluate((el) => {
      const clipboardData = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }),
      );
      return clipboardData.getData("text/plain");
    });
}
async function csp() {
  return page.evaluate(async () =>
    (await fetch(location.href)).headers.get("content-security-policy"),
  );
}
try {
  await verifyRendererManifest(join(packageRoot, "dist"), "workspace");
  const local = await fixture("local"),
    remote = await fixture("remote");
  const shim = installSshShim(remote);
  writeFileSync(
    join(local.dir, "registry/machines.json"),
    JSON.stringify({
      version: 1,
      machines: [
        {
          id: randomUUID(),
          label: remoteLabel,
          sshTarget: "smoke-owned-remote",
          expectedEnvironmentId: remote.info.environmentId,
          enabled: true,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const userData = join(root, "electron-user-data");
  mkdirSync(userData, { mode: 0o700 });
  app = await electron.launch({
    executablePath: electronPath,
    args: [packageRoot, `--user-data-dir=${userData}`],
    cwd: packageRoot,
    env: { ...local.env, ...shim },
    timeout: 30_000,
  });
  assert.equal(
    realpathSync(await app.evaluate(({ app }) => app.getPath("userData"))),
    realpathSync(userData),
    "Electron state must remain isolated",
  );
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".dw-app-chrome").waitFor({ timeout: 30_000 });
  await page.setViewportSize({ width: 1200, height: 850 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const wsOrigins = new Set();
  page.on("websocket", (ws) => wsOrigins.add(new URL(ws.url()).origin));
  await page.evaluate(() => {
    globalThis.__environmentSmokeDocument = "unchanged";
  });
  const firstCsp = await csp();
  assert.ok(firstCsp);
  const connect = firstCsp.split(";").find((value) => value.trim().startsWith("connect-src"));
  const relayOrigins = connect?.match(/ws:\/\/127\.0\.0\.1:\d+/g) ?? [];
  assert.equal(relayOrigins.length, 1, "CSP has exactly one loopback relay origin");
  assert.ok(!connect.includes("*"), "CSP never broadens to arbitrary origins");
  evidence.relayOrigin = relayOrigins[0];
  const cancellation = await page.evaluate(async () => {
    const controller = new AbortController();
    let delivered = 0;
    let registrations = 0;
    let cleanups = 0;
    const adapter = {
      aborted: controller.signal.aborted,
      subscribeAbort(callback) {
        registrations++;
        let active = true;
        if (controller.signal.aborted) callback();
        else controller.signal.addEventListener("abort", callback, { once: true });
        return () => {
          if (!active) return;
          active = false;
          cleanups++;
          controller.signal.removeEventListener("abort", callback);
        };
      },
    };
    const pending = window.tmuxIdeHost.daemon.subscribe(
      { workspaceNames: [] },
      () => delivered++,
      adapter,
    );
    controller.abort();
    const result = await pending;
    // A failure must not silently leave a live registration on main.
    if (result.status === "subscribed") result.unsubscribe();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    return { status: result.status, code: result.error?.code, delivered, registrations, cleanups };
  });
  assert.equal(cancellation.status, "error");
  assert.equal(cancellation.code, "disposed");
  assert.equal(cancellation.delivered, 0);
  assert.equal(cancellation.registrations, 1);
  assert.equal(cancellation.cleanups, 1);
  evidence.bridgeCancellation = cancellation;
  check("contextBridge cancellation callback and returned cleanup survive real Electron crossing");
  const summaries = await until(
    () =>
      page.evaluate(async () => {
        const values = await window.tmuxIdeHost.environments.list();
        return values.some((value) => value.kind === "ssh" && value.phase === "ready") && values;
      }),
    "remote environment ready",
  );
  const remoteConnection = summaries.find((value) => value.kind === "ssh");
  assert.ok(remoteConnection);
  await selectSession("Local");
  await until(async () => (await renderedText()).includes(local.marker), "local rendered marker");
  assert.ok(!(await renderedText()).includes(remote.marker));
  check("local UI session contains only its marker");
  await page.screenshot({ path: join(root, "local.png") });
  await selectSession(remoteLabel);
  await until(async () => (await renderedText()).includes(remote.marker), "remote rendered marker");
  assert.ok(!(await renderedText()).includes(local.marker));
  check("identically named remote UI session contains only its marker");
  await page.getByRole("button", { name: "Take input control", exact: true }).click();
  await page.getByRole("button", { name: "Release input control", exact: true }).waitFor();
  const input = `REMOTE_INPUT_${randomUUID().slice(0, 8)}`;
  await page.locator(".live-terminal .xterm-helper-textarea").first().focus();
  await page.keyboard.type(input);
  await page.keyboard.press("Enter");
  await until(
    () => tmux(remote, ["capture-pane", "-p", "-t", remote.pane]).includes(input),
    "remote input",
  );
  assert.ok(!tmux(local, ["capture-pane", "-p", "-t", local.pane]).includes(input));
  check("input reaches only selected remote pane");
  await page.screenshot({ path: join(root, "remote.png") });
  await page.evaluate(
    (id) => window.tmuxIdeHost.environments.disconnect(id),
    remoteConnection.connectionId,
  );
  await until(
    () =>
      page
        .getByRole("status")
        .filter({ hasText: remoteLabel })
        .getByRole("button", { name: "Reconnect", exact: true })
        .isVisible(),
    "remote offline reconnect UI",
  );
  assert.equal(tmux(remote, ["has-session", "-t", session]), "");
  check("remote tmux survives transport disconnect");
  await selectSession("Local");
  const localAfter = `LOCAL_AFTER_DISCONNECT_${randomUUID().slice(0, 6)}`;
  tmux(local, ["send-keys", "-t", local.pane, "-l", localAfter]);
  tmux(local, ["send-keys", "-t", local.pane, "Enter"]);
  await until(
    async () => (await renderedText()).includes(localAfter),
    "local remains live after remote disconnect",
  );
  check("local remains live while remote offline");
  await page
    .getByRole("status")
    .filter({ hasText: remoteLabel })
    .getByRole("button", { name: "Reconnect", exact: true })
    .click();
  await until(
    () =>
      page.evaluate(
        async (id) =>
          (await window.tmuxIdeHost.environments.list()).some(
            (value) => value.connectionId === id && value.phase === "ready",
          ),
        remoteConnection.connectionId,
      ),
    "remote retry ready",
  );
  await selectSession(remoteLabel);
  await until(
    async () => (await renderedText()).includes(input),
    "remote content preserved after reconnect",
  );
  check("retry reconnects remote through production scope and relay");
  assert.equal(await csp(), firstCsp);
  assert.equal(wsOrigins.size, 1, "at least one actual stream opened through the fixed relay");
  assert.equal(await page.evaluate(() => globalThis.__environmentSmokeDocument), "unchanged");
  assert.ok(
    [...wsOrigins].every((origin) => origin === relayOrigins[0]),
    "all observed terminal sockets use fixed relay origin",
  );
  check("CSP and document remain unchanged through remote reconnect");
  await page.screenshot({ path: join(root, "reconnected.png") });
  evidence.observedWebSocketOrigins = [...wsOrigins];
  evidence.pageErrors = errors;
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  evidence.failure = error.message;
  await page?.screenshot({ path: join(root, "failure.png") }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  const remote = fixtures.find((entry) => entry.marker.startsWith("ENVIRONMENT_REMOTE_"));
  if (remote) {
    try {
      evidence.remoteSessionSurvivedAppClose = tmux(remote, ["has-session", "-t", session]) === "";
    } catch {
      evidence.remoteSessionSurvivedAppClose = false;
      passed = false;
      process.exitCode = 1;
      evidence.failure ??= "Remote tmux session ended before fixture cleanup";
    }
  }
  for (const child of owned)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await delay(300);
  for (const child of owned)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // The shim PID log contains only processes created under this private test PATH.
  let sshEvents = [];
  try {
    sshEvents = readFileSync(join(root, "ssh-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    /* No SSH process was started. */
  }
  for (const { pid, kind } of sshEvents)
    if (kind === "tunnel-ready" && alive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already stopped. */
      }
    }
  for (const f of fixtures) {
    try {
      tmux(f, ["kill-server"]);
    } catch {
      /* Already stopped. */
    }
    rmSync(f.dir, { recursive: true, force: true });
  }
  evidence.ssh = sshEvents;
  evidence.ok = passed;
  writeFileSync(join(root, "report.json"), JSON.stringify(evidence, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      ok: passed,
      report: join(root, "report.json"),
      checks: evidence.checks,
      failure: evidence.failure,
    }),
  );
}
