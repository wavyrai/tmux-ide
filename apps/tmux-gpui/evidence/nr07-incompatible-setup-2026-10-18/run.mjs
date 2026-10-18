// Synthetic incompatible owner + actual source browser; never starts a real daemon/tmux.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  copyFile,
  rm,
  realpath,
  readdir,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const repo = process.cwd(),
  output = resolve(
    process.argv[2] ?? ".tasks/native-reliability-mission/nr07-incompatible-setup/result.json",
  );
try {
  await lstat(output);
  throw new Error("Receipt already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const syntheticToken = "synthetic-private-sentinel-" + randomUUID();
const safeError = (error) => String(error.stack ?? error).replaceAll(syntheticToken, "[redacted]");
const { DAEMON_WIRE_PROTOCOL_VERSION } = await import(
  pathToFileURL(join(repo, "packages/contracts/src/index.ts"))
);
const { stopFixtureChild } = await import(
  pathToFileURL(join(repo, "apps/tmux-gpui/bridge/fixture-child.mjs"))
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cliBefore = hash(await readFile(join(repo, "bin/cli.js")));
const root = await realpath(await mkdtemp("/tmp/gpui-incompatible-"));
const records = join(root, "records"),
  registry = join(root, "registry"),
  managed = join(root, ".local/share/tmux-ide"),
  release = join(managed, "releases/install-fixture123"),
  pkg = join(release, "npm/lib/node_modules/tmux-ide");
const log = join(root, "calls.jsonl"),
  sentinel = join(root, "settings-sentinel"),
  record = join(records, "daemon.json");
let child,
  server,
  latest,
  fatal,
  closing = false,
  buffer = "",
  stderrBytes = 0;
const requests = [],
  publications = [],
  observedPids = [];
const receipt = {
  syntheticOwner: true,
  sourceBrowser: true,
  realDaemon: false,
  node: process.version,
  passed: false,
  checks: {},
  failures: [],
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
const calls = async () =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x));
const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
const until = async (predicate) => {
  const end = Date.now() + 10000;
  while (!(await predicate())) {
    if (fatal) throw fatal;
    assert.ok(Date.now() < end, "fixture deadline");
    await delay(20);
  }
};
const noAuthority = (value) => {
  assert.equal(value.snapshot, null);
  assert.equal(value.inputReady, false);
  assert.equal(value.localSessionCreate ?? null, null);
  assert.equal(value.selectedPane ?? null, null);
};
try {
  for (const dir of [
    join(pkg, "bin"),
    join(release, "node/bin"),
    records,
    registry,
    join(root, "tmp"),
  ])
    await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(process.execPath, join(release, "node/bin/node"), constants.COPYFILE_FICLONE);
  await writeFile(join(managed, "installer-v1"), "1\n");
  await writeFile(join(release, ".installer-release-v1"), "1\n");
  await symlink(release, join(managed, "current"));
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "tmux-ide", version: "2.9.7", bin: { "tmux-ide": "bin/cli.js" } }),
  );
  await writeFile(log, "");
  await writeFile(sentinel, "preserve");
  const instanceId = randomUUID();
  await writeFile(
    join(pkg, "bin/cli.js"),
    `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({args,pid:process.pid})+'\\n');if(args[0]==='--version')console.log('tmux-ide v2.9.7');else console.log(JSON.stringify({ok:true,status:'ready',productVersion:'2.9.7',instanceId:${JSON.stringify(instanceId)}}));`,
  );
  let info;
  server = createServer((req, res) => {
    requests.push({ path: req.url, authorizationPresent: !!req.headers.authorization });
    if (requests.length > 100) {
      fatal = Error("request bound");
      res.writeHead(429).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/identity") {
      const { authToken, ...identity } = info;
      res.end(JSON.stringify({ ok: true, ...identity }));
    } else {
      res.writeHead(403).end("{}");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  info = {
    pid: process.pid,
    port: server.address().port,
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION + 1,
    productVersion: "2.9.7",
    instanceId,
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: syntheticToken,
  };
  const recordBytes = JSON.stringify(info);
  await writeFile(record, recordBytes, { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.startsWith("TMUX") &&
        ![
          "NODE_OPTIONS",
          "NODE_PATH",
          "HOME",
          "TMPDIR",
          "XDG_CONFIG_HOME",
          "XDG_STATE_HOME",
          "XDG_CACHE_HOME",
          "XDG_DATA_HOME",
        ].includes(k),
    ),
  );
  Object.assign(env, {
    HOME: root,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    TMUX_IDE_HOME: join(root, "state"),
    TMUX_IDE_CONFIG: join(root, "config.json"),
    TMUX_IDE_SETTINGS_DIR: join(root, "settings"),
    TMUX_IDE_DAEMON_INFO_DIR: records,
    TMUX_IDE_REGISTRY_DIR: registry,
    TMUX_IDE_TMUX_SOCKET_PATH: join(root, "unused.sock"),
    FIXTURE_CALLS: log,
  });
  child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      join(repo, "apps/tmux-gpui/bridge/browser.ts"),
      "--local",
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.on("error", (e) => (fatal = e));
  child.on("exit", () => {
    if (!closing) fatal = Error("unexpected browser exit");
  });
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.on("error", (e) => (fatal = e));
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) fatal = Error("stderr bound");
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    try {
      buffer += chunk;
      assert.ok(Buffer.byteLength(buffer) <= 1024 * 1024);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        latest = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        noAuthority(latest);
        assert.ok(!JSON.stringify(latest).includes(info.authToken), "no credential in publication");
        publications.push({
          request: latest.request,
          home: latest.home?.phase,
          setup: latest.localSetup?.phase ?? null,
          status: latest.status,
        });
        assert.ok(publications.length <= 500);
      }
    } catch (e) {
      fatal = e;
    }
  });
  send({ type: "presence", active: true, revision: 1 });
  await until(
    () => latest?.home?.phase === "unavailable" && latest?.localSetup?.phase === "available",
  );
  assert.match(latest.status, /incompatible/);
  assert.deepEqual(await calls(), []);
  const initialProbes = requests.length;
  assert.ok(initialProbes > 0);
  send({ type: "refresh", request: 1 });
  await until(
    () =>
      latest?.request === 1 &&
      latest.home.phase === "unavailable" &&
      latest.localSetup?.phase === "available" &&
      requests.length > initialProbes,
  );
  assert.deepEqual(await calls(), []);
  const beforeSetup = requests.length;
  send({ type: "local-setup", request: 1 });
  await until(() => latest?.localSetup?.phase === "failed");
  assert.ok(
    requests.length > beforeSetup,
    "successful setup receipt must be independently re-probed",
  );
  const invoked = await calls();
  assert.deepEqual(
    invoked.map((x) => x.args),
    [["--version"], ["update", "--daemon", "--json"]],
  );
  observedPids.push(...invoked.map((x) => x.pid));
  await delay(350);
  assert.deepEqual(await calls(), invoked, "passive observation must not retry");
  assert.ok(requests.every((x) => x.path === "/identity" && !x.authorizationPresent));
  assert.equal(await readFile(record, "utf8"), recordBytes);
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
  assert.deepEqual(await readdir(registry), []);
  assert.equal(latest.home.phase, "unavailable");
  noAuthority(latest);
  if (fatal) throw fatal;
  receipt.checks = {
    initialUnavailable: true,
    refreshReadOnly: true,
    successfulReceiptReprobed: true,
    incompatibleRefused: true,
    noTerminalOrCreateAuthority: true,
    noAuthenticatedRequests: true,
    noAutomaticRetryObservationMs: 350,
    privateRecordSettingsUnchanged: true,
  };
  receipt.requests = requests;
  receipt.publications = publications;
  receipt.expectedProtocol = DAEMON_WIRE_PROTOCOL_VERSION;
  receipt.ownerProtocol = info.protocolVersion;
} catch (e) {
  receipt.failures.push(safeError(e));
} finally {
  closing = true;
  try {
    await stopFixtureChild(child);
    receipt.browserPid = child?.pid;
    receipt.browserExited = !child || !alive(child.pid);
  } catch (e) {
    receipt.failures.push(safeError(e));
  }
  try {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
    receipt.serverClosed = !server?.listening;
  } catch (e) {
    receipt.failures.push(safeError(e));
  }
  try {
    observedPids.push(...(await calls()).map((x) => x.pid));
    receipt.cliChildrenExited = observedPids.every((pid) => !alive(pid));
    assert.ok(receipt.cliChildrenExited);
    await rm(root, { recursive: true, force: true });
    receipt.privateRootRemoved = true;
  } catch (e) {
    receipt.failures.push(safeError(e));
  }
  receipt.protectedCliUnchanged = cliBefore === hash(await readFile(join(repo, "bin/cli.js")));
  receipt.requests = requests;
  receipt.publications = publications;
  receipt.sourceHashes = Object.fromEntries(
    await Promise.all(
      [
        "apps/tmux-gpui/bridge/browser.ts",
        "apps/tmux-gpui/bridge/discovery.ts",
        "apps/tmux-gpui/bridge/local-setup.ts",
      ].map(async (file) => [file, hash(await readFile(join(repo, file)))]),
    ),
  );
  receipt.harnessHash = hash(await readFile(fileURLToPath(import.meta.url)));
  receipt.stderrBytes = stderrBytes;
  receipt.passed =
    receipt.failures.length === 0 &&
    receipt.browserExited &&
    receipt.serverClosed &&
    receipt.cliChildrenExited &&
    receipt.protectedCliUnchanged;
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ passed: receipt.passed, output, failures: receipt.failures.length }));
if (!receipt.passed) process.exitCode = 1;
