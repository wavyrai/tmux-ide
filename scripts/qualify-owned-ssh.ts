/** Opt-in real OpenSSH stages 1–3. HTTP identity is synthetic; no real daemon/TUI claim. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as httpServer, request, type IncomingMessage } from "node:http";
import { createFinitePressureWriter } from "./lib/owned-ssh-pressure.mjs";
import { createFleetDialScheduler } from "../packages/daemon-client/src/fleet-dial-scheduler.ts";
import { createServer as tcpServer, type Socket } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "../packages/contracts/src/index.ts";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  SshConnectionError,
} from "../packages/daemon/src/lib/ssh-daemon-transport.ts";
import {
  createOwnedSshFixture,
  createMacProcessIdentity,
  sshDiagnosticSink,
  ownedProcesses,
  unusedLoopbackPort,
  waitForPort,
  fixturePath,
  clientConfiguration,
} from "./lib/owned-ssh-fixture.mjs";
process.umask(0o077);
const runStarted = Date.now();
const execute = promisify(execFile);
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--run-owned-local" || args[1] !== "--root")
  throw new Error(
    "Usage: qualify-owned-ssh --run-owned-local --root EXISTING_PRIVATE_SHORT_DIRECTORY",
  );
const root = fixturePath(realpathSync(args[2]!));
const rootStat = lstatSync(root);
if (!rootStat.isDirectory() || rootStat.uid !== process.getuid!() || rootStat.mode & 0o077)
  throw new Error("Private fixture root required");
const env = { PATH: "/usr/bin:/bin", HOME: root, ZDOTDIR: root };
const allocations: Array<{
  root: string;
  disposeFiles(): Promise<void>;
  diagnostics(): { stage: string; failureStage: string | null };
}> = [];
const pressureWriters: Array<ReturnType<typeof createFinitePressureWriter>> = [];
const transports: Array<Awaited<ReturnType<typeof openSshDaemonTransport>>> = [];
const results: Array<{
  name: string;
  ok: boolean;
  elapsedMs: number;
  code?: string;
  facts?: Record<string, string | number | boolean | null>;
}> = [];
let caseFacts: Record<string, string | number | boolean | null> = {};
const forwardPorts: number[] = [];
const sshChildren: number[] = [];
const sshDiagnostics: Array<{ role: string; snapshot: ReturnType<typeof sshDiagnosticSink> }> = [];
let currentStage = "setup";
let proxyChildObserved = false;
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
let kernelIdentity!: Awaited<ReturnType<typeof createMacProcessIdentity>>;
const tracker = ownedProcesses({
  identify: (pid: number) => kernelIdentity.identify(pid),
  list: async () => {
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      env,
    });
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
        if (!m) throw new Error("Process snapshot refused");
        return { pid: Number(m[1]), ppid: Number(m[2]) };
      });
  },
});
// Observe retained SSH ancestry while failure injections are still in flight. One scan at a time.
let captureFlight: Promise<void> | null = null;
let captureRefused = false;
const captureTimer = setInterval(() => {
  if (captureFlight) return;
  captureFlight = tracker
    .capture()
    .catch(() => {
      captureRefused = true;
    })
    .finally(() => {
      captureFlight = null;
    });
}, 100);
const listeners: Array<ReturnType<typeof tcpServer> | ReturnType<typeof httpServer>> = [];
const peers = new Set<Socket>();
const retainPeers = (server: ReturnType<typeof tcpServer> | ReturnType<typeof httpServer>) => {
  server.on("connection", (socket) => {
    if (peers.size >= 32) {
      socket.destroy();
      return;
    }
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  });
  listeners.push(server);
};
const timers = new Set<ReturnType<typeof setTimeout>>();
const abortLater = (ms: number) => {
  const c = new AbortController();
  const t = setTimeout(() => {
    timers.delete(t);
    c.abort();
  }, ms);
  timers.add(t);
  return c.signal;
};
const assert = (value: unknown) => {
  if (!value) throw new Error("Owned SSH qualification assertion failed");
};
const privateWrite = (path: string, data: string) =>
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
let overall = true;
const cleanup: { processes?: boolean; files?: boolean; listeners?: boolean; forwards?: boolean } =
  {};
async function runCase(name: string, work: () => Promise<void>) {
  if (interrupted.signal.aborted) throw new Error("Qualification interrupted");
  currentStage = name;
  expectedFailureCode = undefined;
  caseFacts = {};
  const started = Date.now();
  try {
    await work();
    results.push({
      name,
      ok: true,
      elapsedMs: Date.now() - started,
      facts: { ...caseFacts },
      ...(expectedFailureCode ? { code: expectedFailureCode } : {}),
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      elapsedMs: Date.now() - started,
      facts: { ...caseFacts },
      ...(error instanceof SshConnectionError
        ? { code: error.code }
        : expectedFailureCode
          ? { code: expectedFailureCode }
          : {}),
    });
    throw new Error("Owned SSH qualification failed", { cause: error });
  }
}
const node = realpathSync(process.execPath);
async function fixture(options: {
  targetPort: number;
  handshake(): unknown;
  jump?: boolean;
  missingPath?: boolean;
}) {
  currentStage = options.jump
    ? "jump-fixture"
    : options.missingPath
      ? "missing-path-fixture"
      : "target-fixture";
  return createOwnedSshFixture({
    parent: root,
    node,
    processes: tracker,
    onAllocated: (owner: {
      root: string;
      disposeFiles(): Promise<void>;
      diagnostics(): { stage: string; failureStage: string | null };
    }) => allocations.push(owner),
    ...options,
  });
}
function adapter(config: string) {
  return {
    spawn: (argv: string[]) => {
      const child = tracker.retain(
        spawn("/usr/bin/ssh", ["-F", config, ...argv], { stdio: ["ignore", "pipe", "pipe"], env }),
      );
      sshDiagnostics.push({ role: "production", snapshot: sshDiagnosticSink(child.stderr) });
      if (child.pid) sshChildren.push(child.pid);
      return child;
    },
    allocatePort: unusedLoopbackPort,
    probe: probeSshDaemonIdentity,
  };
}
async function connect(config: string, signal?: AbortSignal) {
  const transport = await openSshDaemonTransport(
    {
      alias: "target",
      signal: signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal,
      timeoutMs: 5000,
    },
    adapter(config),
  );
  transports.push(transport);
  forwardPorts.push(Number(new URL(transport.baseUrl).port));
  await tracker.capture();
  return transport;
}
async function closeTransport(transport: Awaited<ReturnType<typeof connect>>) {
  transport.dispose();
  await Promise.race([
    transport.closed,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        timers.delete(t);
        reject(new Error("SSH close deadline"));
      }, 2000);
      timers.add(t);
    }),
  ]);
  await waitForPort(Number(new URL(transport.baseUrl).port), false);
}
let expectedFailureCode: string | undefined;
async function refused(config: string, signal?: AbortSignal, minMs = 0) {
  const before = sshChildren.length,
    started = Date.now();
  let rejected = false;
  try {
    const transport = await connect(config, signal);
    await closeTransport(transport);
  } catch (error) {
    if (!(error instanceof SshConnectionError)) throw error;
    expectedFailureCode = error.code;
    caseFacts.step = "error-code";
    assert(error.code === "unavailable");
    rejected = true;
  }
  caseFacts.elapsedMs = Date.now() - started;
  caseFacts.spawned = sshChildren.length - before;
  caseFacts.aborted = signal?.aborted ?? false;
  caseFacts.step = "rejected";
  assert(rejected);
  caseFacts.step = "elapsed-bound";
  assert(Date.now() - started >= minMs && Date.now() - started < 3000);
  caseFacts.step = "spawn-count";
  assert(sshChildren.length - before === (signal?.aborted && minMs === 0 ? 0 : 1));
  caseFacts.step = "abort-observed";
  if (minMs > 0) assert(signal?.aborted);
  caseFacts.step = "capture";
  await tracker.capture();
  caseFacts.step = "complete";
}
async function waitUntil(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    interrupted.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Fixture observation deadline");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function freshMarker(baseUrl: string) {
  const response = await fetch(`${baseUrl}/marker`, { signal: AbortSignal.timeout(1000) });
  assert(response.ok && (await response.json()).marker === "owned-d11");
}

try {
  currentStage = "kernel-witness";
  kernelIdentity = await createMacProcessIdentity({
    parent: root,
    onAllocated: (owner: (typeof allocations)[number]) => allocations.push(owner),
  });
  const instance = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "d11-synthetic-fixture",
  };
  const token = randomBytes(32).toString("hex");
  const server = httpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/identity" && req.method === "GET")
      res.end(JSON.stringify({ ok: true, pid: process.pid, ...instance }));
    else if (
      req.url === "/api/v2/capabilities" &&
      req.method === "POST" &&
      req.headers.authorization === `Bearer ${token}`
    ) {
      req.resume();
      res.end(
        JSON.stringify({
          status: "ok",
          daemon: instance,
          capabilities: { appWindowMutation: { available: false, reason: "fixture" } },
        }),
      );
    } else if (
      req.url === "/pressure" &&
      req.method === "GET" &&
      req.headers.authorization === `Bearer ${token}`
    ) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", 16 * 1024 * 1024);
      pressureWriters.push(createFinitePressureWriter(res));
    } else if (req.url === "/marker" && req.method === "GET")
      res.end(JSON.stringify({ marker: "owned-d11" }));
    else {
      res.statusCode = 403;
      res.end("{}");
    }
  });
  retainPeers(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const targetPort = (address as { port: number }).port;
  const target = await fixture({
    targetPort,
    handshake: () => ({
      version: 1,
      daemon: {
        ...instance,
        pid: process.pid,
        port: targetPort,
        bindHostname: "127.0.0.1",
        authToken: token,
      },
    }),
  });
  const baseline = await unusedLoopbackPort();
  forwardPorts.push(baseline);
  const marker = async () => {
    const response = await fetch(`http://127.0.0.1:${baseline}/marker`, {
      signal: AbortSignal.timeout(1000),
    });
    assert(response.ok && (await response.json()).marker === "owned-d11");
  };
  await runCase("control-master-and-dedicated-disposal", async () => {
    const master = tracker.retain(
      spawn(
        "/usr/bin/ssh",
        [
          "-F",
          target.config,
          "-M",
          "-N",
          "-o",
          "ControlPersist=no",
          "-o",
          "ForkAfterAuthentication=no",
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `127.0.0.1:${baseline}:127.0.0.1:${targetPort}`,
          "--",
          "target",
        ],
        { stdio: ["ignore", "ignore", "pipe"], env },
      ),
    );
    sshDiagnostics.push({ role: "baseline-master", snapshot: sshDiagnosticSink(master.stderr) });
    await waitForPort(baseline, true);
    target.files.capture("m");
    await tracker.capture();
    await marker();
    const transport = await connect(target.config);
    await freshMarker(transport.baseUrl);
    await closeTransport(transport);
    assert(master.exitCode === null);
    await marker();
  });
  const jump = await fixture({ targetPort: target.port, jump: true, handshake: () => ({}) });
  const jumpConfig = join(target.root, "jump_config");
  privateWrite(
    jumpConfig,
    clientConfiguration({
      root: target.root,
      account: target.account,
      port: target.port,
      jump: "jump",
      sharing: false,
      defaults: false,
    }) +
      clientConfiguration({
        root: jump.root,
        account: jump.account,
        port: jump.port,
        alias: "jump",
        sharing: false,
        defaults: false,
      }) +
      "Host *\n ForkAfterAuthentication no\n",
  );
  target.files.capture("jump_config");
  await runCase("proxy-jump-production-discovery-and-forward", async () => {
    const offset = sshChildren.length;
    const transport = await connect(jumpConfig);
    proxyChildObserved = tracker
      .snapshot()
      .ancestry.some((row: { rootPid: number }) => sshChildren.slice(offset).includes(row.rootPid));
    assert(proxyChildObserved);
    await freshMarker(transport.baseUrl);
    await marker();
    await closeTransport(transport);
  });
  const directConfig = join(target.root, "direct_config");
  privateWrite(
    directConfig,
    clientConfiguration({
      root: target.root,
      account: target.account,
      port: target.port,
      sharing: false,
    }),
  );
  target.files.capture("direct_config");
  await runCase("fresh-nonmultiplexed-discovery-control", async () => {
    const transport = await connect(directConfig);
    await freshMarker(transport.baseUrl);
    await closeTransport(transport);
  });
  for (const [name, overrides] of [
    ["wrong-key", { identity: join(jump.root, "client") }],
    ["wrong-host-key", { known: join(target.root, "wrong_known_hosts") }],
  ] as const) {
    if (name === "wrong-host-key") {
      privateWrite(
        join(target.root, "wrong_known_hosts"),
        `[127.0.0.1]:${target.port} ${jump.publicKey}`,
      );
      target.files.capture("wrong_known_hosts");
    }
    const path = join(target.root, name + "_config");
    privateWrite(
      path,
      clientConfiguration({
        root: target.root,
        account: target.account,
        port: target.port,
        sharing: false,
        ...overrides,
      }),
    );
    target.files.capture(name + "_config");
    await runCase(name, async () => {
      const requests = target.metrics().requests;
      await refused(path);
      assert(target.metrics().requests === requests);
      await marker();
    });
  }
  await runCase("private-noninteractive-path", async () => {
    const transport = await connect(target.config);
    await freshMarker(transport.baseUrl);
    await closeTransport(transport);
  });
  const missing = await fixture({ targetPort, missingPath: true, handshake: () => ({}) });
  await runCase("missing-path-no-installed-fallback", async () => {
    await refused(missing.config);
    assert(missing.metrics().requests === 0);
    await marker();
  });
  await runCase("pre-aborted", async () => {
    const before = sshChildren.length;
    const controller = new AbortController();
    controller.abort();
    await refused(target.config, controller.signal);
    assert(sshChildren.length === before);
  });
  let preauthAccepted = 0;
  const stall = tcpServer((socket) => {
    preauthAccepted++;
    socket.setTimeout(5000, () => socket.destroy());
  });
  retainPeers(stall);
  await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
  const stallAddress = stall.address() as { port: number };
  const stallConfig = join(target.root, "preauth_config");
  privateWrite(
    stallConfig,
    clientConfiguration({
      root: target.root,
      account: target.account,
      port: stallAddress.port,
      sharing: false,
    }),
  );
  target.files.capture("preauth_config");
  await runCase("preauth-stall-cancellation", async () => {
    await refused(stallConfig, abortLater(300), 250);
    await marker();
  });
  await runCase("discovery-delay", async () => {
    target.setMode("delay");
    try {
      const started = Date.now();
      const transport = await connect(target.config);
      assert(Date.now() - started >= 200);
      await freshMarker(transport.baseUrl);
      await closeTransport(transport);
    } finally {
      target.setMode("normal");
    }
  });
  await runCase("discovery-stall-cancellation-healthy-control", async () => {
    target.setMode("stall");
    try {
      const stalled = target.metrics().stalls;
      const pending = refused(target.config, abortLater(500), 450);
      await marker();
      await pending;
      assert(target.metrics().stalls === stalled + 1);
      await marker();
    } finally {
      target.setMode("normal");
    }
  });
  await runCase("paused-forward-reader-healthy-control", async () => {
    const transport = await connect(directConfig);
    const control = await connect(directConfig);
    const offset = pressureWriters.length;
    let reader: IncomingMessage | undefined;
    const requestAbort = new AbortController();
    let readerRequest: ReturnType<typeof request> | undefined;
    try {
      caseFacts.step = "reader-headers";
      reader = await new Promise<IncomingMessage>((resolve, reject) => {
        readerRequest = request(
          transport.baseUrl + "/pressure",
          {
            method: "GET",
            agent: false,
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.any([
              requestAbort.signal,
              interrupted.signal,
              AbortSignal.timeout(7000),
            ]),
          },
          (response) => {
            response.pause();
            response.on("error", () => {});
            resolve(response);
          },
        );
        readerRequest.once("error", reject);
        readerRequest.end();
      });
      assert(reader.statusCode === 200);
      await waitUntil(() => pressureWriters.length === offset + 1);
      const writer = pressureWriters[offset]!;
      caseFacts.step = "producer-plateau";
      let stableSince = Date.now(),
        previous = -1;
      await waitUntil(() => {
        const current = writer.snapshot();
        caseFacts.acceptedBytes = current.acceptedBytes;
        caseFacts.queuePeakBytes = current.queuePeakBytes;
        caseFacts.producerLimitBytes = current.limitBytes;
        if (current.exhausted || current.retired)
          throw new Error("Pressure producer exhausted before reader plateau");
        if (!current.blocked || current.acceptedBytes !== previous) {
          previous = current.acceptedBytes;
          stableSince = Date.now();
        }
        return current.blocked && Date.now() - stableSince >= 200;
      }, 5000);
      const plateau = writer.snapshot();
      caseFacts.plateauMs = Date.now() - stableSince;
      caseFacts.drains = plateau.drains;
      caseFacts.step = "healthy-during-pause";
      const healthyStarted = Date.now();
      for (let n = 0; n < 3; n++) await freshMarker(control.baseUrl);
      caseFacts.healthyElapsedMs = Date.now() - healthyStarted;
      caseFacts.healthyMarkers = 3;
      caseFacts.readerPaused = reader.isPaused();
      caseFacts.plateauPreserved = writer.snapshot().acceptedBytes === plateau.acceptedBytes;
      assert(caseFacts.readerPaused && caseFacts.plateauPreserved);
      assert(plateau.queuePeakBytes <= plateau.chunkBytes + 1024);
      caseFacts.step = "reader-cancellation";
      reader.destroy();
      requestAbort.abort();
      await waitUntil(() => writer.snapshot().retired);
      caseFacts.finalQueuedBytes = writer.snapshot().queuedBytes;
      assert(writer.snapshot().queuedBytes === 0);
      await freshMarker(control.baseUrl);
    } finally {
      reader?.destroy();
      requestAbort.abort();
      readerRequest?.destroy();
      for (const writer of pressureWriters.slice(offset)) writer.dispose();
      await closeTransport(transport);
      await closeTransport(control);
    }
  });
  await runCase("fleet-scheduler-stall-queued-healthy-cancellation", async () => {
    // A configured single slot forces the queue boundary with just two real dials.
    // Default-limit saturation is covered separately by scheduler unit tests.
    const scheduler = createFleetDialScheduler(1);
    const stalledAbort = new AbortController(),
      healthyAbort = new AbortController();
    const control = await connect(directConfig);
    let activePeak = 0,
      queuedPeak = 0,
      healthyStarted = false;
    const observe = () => {
      const value = scheduler.snapshot();
      activePeak = Math.max(activePeak, value.active);
      queuedPeak = Math.max(queuedPeak, value.queued);
      caseFacts.limit = value.limit;
      caseFacts.activeHighWater = activePeak;
      caseFacts.queuedHighWater = queuedPeak;
      assert(value.active <= value.limit && value.queued <= 1);
      return value;
    };
    const acceptedBefore = preauthAccepted;
    const stalled = scheduler
      .run(
        "stalled",
        stalledAbort.signal,
        () => connect(stallConfig, stalledAbort.signal),
        closeTransport,
      )
      .then(
        () => false,
        () => true,
      );
    const healthy = scheduler.run(
      "healthy",
      healthyAbort.signal,
      () => {
        healthyStarted = true;
        return connect(directConfig, healthyAbort.signal);
      },
      closeTransport,
    );
    // Install the rejection handler immediately; independent cleanup always settles both.
    const healthySettled = healthy.then(
      (value) => ({ value }),
      () => ({ value: null }),
    );
    try {
      assert(observe().active === 1 && observe().queued === 1 && !healthyStarted);
      await waitUntil(() => preauthAccepted > acceptedBefore);
      caseFacts.stalledSshSocketAccepted = true;
      await freshMarker(control.baseUrl);
      caseFacts.healthyControlDuringStall = true;
      stalledAbort.abort();
      const postAbort = observe();
      caseFacts.postAbortActive = postAbort.active;
      caseFacts.postAbortQueued = postAbort.queued;
      assert(postAbort.active === 1 && postAbort.queued === 1);
      assert(await stalled);
      const recovered = await healthySettled;
      assert(recovered.value !== null && healthyStarted);
      if (!recovered.value) throw new Error("Queued healthy dial failed");
      await freshMarker(recovered.value.baseUrl);
      await closeTransport(recovered.value);
      await waitUntil(() => observe().active === 0 && observe().queued === 0);
      caseFacts.limit = 1;
      caseFacts.activeHighWater = activePeak;
      caseFacts.queuedHighWater = queuedPeak;
      caseFacts.finalActive = scheduler.snapshot().active;
      caseFacts.finalQueued = scheduler.snapshot().queued;
    } finally {
      stalledAbort.abort();
      healthyAbort.abort();
      const [, recovered] = await Promise.all([stalled, healthySettled]);
      if (recovered.value) await closeTransport(recovered.value);
      await closeTransport(control);
      await waitUntil(() => scheduler.snapshot().active === 0 && scheduler.snapshot().queued === 0);
    }
  });
  await runCase("discovery-output-bound", async () => {
    target.setMode("oversize");
    try {
      const bytes = target.metrics().deliveredBytes;
      await refused(target.config);
      assert(target.metrics().deliveredBytes - bytes === 33000);
    } finally {
      target.setMode("normal");
    }
  });
} catch {
  overall = false;
} finally {
  clearInterval(captureTimer);
  await captureFlight;
  for (const timer of timers) clearTimeout(timer);
  for (const writer of pressureWriters) writer.dispose();
  for (const transport of transports) transport.dispose();
  try {
    await tracker.dispose();
    cleanup.processes = !captureRefused;
  } catch {
    cleanup.processes = false;
  }
  for (const peer of peers) peer.destroy();
  const closed = await Promise.allSettled(
    listeners.map(
      (listener) =>
        new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  cleanup.listeners = closed.every((r) => r.status === "fulfilled");
  const fileResults = await Promise.allSettled(allocations.map((owner) => owner.disposeFiles()));
  cleanup.files = fileResults.every((r) => r.status === "fulfilled");
  const portResults = await Promise.allSettled(
    forwardPorts.map((port) => waitForPort(port, false)),
  );
  cleanup.forwards = portResults.every((r) => r.status === "fulfilled");
  const receipt = {
    version: 1,
    elapsedMs: Date.now() - runStarted,
    ok: overall && Object.values(cleanup).every(Boolean),
    scope: "synthetic-identity-production-ssh-transport-only",
    realDaemon: false,
    failureStage: overall ? null : currentStage,
    proxyChildObserved,
    sshDiagnostics: sshDiagnostics.map((item) => ({ role: item.role, ...item.snapshot() })),
    processObservation: tracker.snapshot(),
    kernelWitness: kernelIdentity
      ? { sourceHash: kernelIdentity.sourceHash, artifactHash: kernelIdentity.artifactHash }
      : null,
    results,
    cleanup,
    allocatedRoots: allocations.map((owner) => owner.root),
    allocationDiagnostics: allocations.map((owner) => ({
      root: owner.root,
      ...owner.diagnostics(),
    })),
    platform: process.platform,
    node: process.version,
  };
  privateWrite(join(root, "qualification.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.stdout.write(
    JSON.stringify({ ok: receipt.ok, receipt: join(root, "qualification.json") }) + "\n",
  );
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  process.exitCode = receipt.ok ? 0 : 1;
}
