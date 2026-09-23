/** Opt-in native stage4. Four managed owners, two real SSH authorities, no Docker. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDevelopmentIdentity } from "../packages/daemon/src/lib/development-state.ts";
import { readDevelopmentBuild } from "../packages/daemon/src/lib/development-build.ts";
import { resolveDevelopmentInstance } from "../packages/daemon/src/lib/development-instance.ts";
import {
  prepareDevelopmentAppRemote,
  launchDevelopmentApp,
  type DevelopmentAppRemote,
} from "../packages/daemon/src/lib/development-app.ts";
import {
  developmentSshAuthority,
  developmentSshHandshake,
  type DevelopmentSshLease,
} from "../packages/daemon/src/lib/development-ssh.ts";
import {
  ownedProcesses,
  createMacProcessIdentity,
  createOwnedSshFixture,
  clientConfiguration,
  unusedLoopbackPort,
  waitForPort,
  sshDiagnosticSink,
} from "./lib/owned-ssh-fixture.mjs";
import {
  openSshDaemonTransport,
  probeSshDaemonIdentity,
  SshConnectionError,
  RemoteDaemonHandshakeFailureSchema,
} from "../packages/daemon/src/lib/ssh-daemon-transport.ts";
type Tuple = { role: string; worktree: string; name: string; store: string; id?: string };
type Plan = {
  version: number;
  instances: Tuple[];
  instance?: Tuple;
  remote?: DevelopmentAppRemote;
  node: string;
  bun: string;
  managerRoot: string;
  managerCommit: string;
  nativeSource: string;
  store: string;
  session: string;
};
type Pty = {
  pid: number;
  write(text: string): void;
  kill(signal?: string): void;
  onData(callback: (text: string) => void): void;
  onExit(callback: (value: { exitCode: number }) => void): void;
};
type Vt = {
  write(text: string): void;
  dispose(): void;
  buffer: {
    active: { getLine(index: number): { translateToString(trim: boolean): string } | undefined };
  };
};
type Handle = EventEmitter & {
  pid: number;
  kill(signal: string): boolean;
  exitCode: number | null;
  signalCode: string | null;
};
type Client = {
  child: Pty;
  handle: Handle;
  vt: Vt;
  exited: boolean;
  exitCode?: number;
  frame(): string;
};
type Allocation = { root: string; disposeFiles(): Promise<void>; diagnostics?(): unknown };
type Route = Awaited<ReturnType<typeof createOwnedSshFixture>> & {
  alias: string;
  setLease(value: DevelopmentSshLease): void;
  handshakeTimings: Array<Record<string, unknown>>;
  omittedHandshakeTimings(): number;
};
process.umask(0o077);
const execute = promisify(execFile),
  self = fileURLToPath(import.meta.url),
  sourceRoot = dirname(dirname(self));
const args = process.argv.slice(2);
assert(args.length === 2 && ["--run", "--client"].includes(args[0]!));
const descriptorPath = realpathSync(args[1]!);
assert(lstatSync(descriptorPath).isFile() && lstatSync(descriptorPath).size < 65536);
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as Plan;
assert.equal(realpathSync(sourceRoot), realpathSync(descriptor.managerRoot));
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: dirname(descriptor.node) + ":" + process.env.PATH,
  TERM: "xterm-256color",
};
for (const key of Object.keys(env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key)
  )
    delete env[key];
if (args[0] === "--client") {
  assert(descriptor.instance && descriptor.remote);
  const client = resolveDevelopmentInstance(descriptor.instance);
  const remote = prepareDevelopmentAppRemote(descriptor.remote);
  const launched = await launchDevelopmentApp(client, remote);
  process.exitCode = await launched.completion;
  await launched.release();
} else {
  assert(
    descriptor.version === 1 && descriptor.instances.length === 4 && !existsSync(descriptor.store),
  );
  assert.deepEqual(descriptor.instances.map((instance) => instance.role).sort(), [
    "client-a",
    "client-b",
    "target-a",
    "target-b",
  ]);
  assert(descriptor.instances.every((instance) => instance.store === descriptor.store));
  const out = dirname(descriptorPath),
    started = Date.now(),
    events: Array<Record<string, unknown>> = [];
  const save = (name: string, value: unknown) =>
    writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  const event = (stage: string, extra: Record<string, unknown> = {}) => {
    events.push({ stage, elapsedMs: Date.now() - started, ...extra });
    process.stdout.write(JSON.stringify({ stage, elapsedMs: Date.now() - started }) + "\n");
  };
  const cancellation = new AbortController();
  let cleaning = false;
  const cancel = () => cancellation.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const checkCancellation = () => {
    if (!cleaning) cancellation.signal.throwIfAborted();
  };
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function wait(predicate: () => Promise<boolean> | boolean, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      checkCancellation();
      if (await predicate()) return;
      await delay(50);
    }
    throw Error("Fixture deadline");
  }
  const run = async (file: string, argv: string[], timeout = 30000, cancellable = true) => {
    if (cancellable) checkCancellation();
    return (
      await execute(file, argv, {
        env,
        cwd: sourceRoot,
        timeout,
        maxBuffer: 1024 * 1024,
        signal: !cleaning && cancellable ? cancellation.signal : undefined,
      })
    ).stdout;
  };
  const instances = Object.fromEntries(
    descriptor.instances.map((value: Tuple) => [value.role, resolveDevelopmentInstance(value)]),
  );
  assert.equal(new Set(Object.values(instances).map((instance) => instance.id)).size, 4);
  assert(Object.values(instances).every((instance) => !existsSync(instance.runtimeDir)));
  assert(
    descriptor.instances.every(
      (instance) => !instance.id || instance.id === instances[instance.role].id,
    ),
  );
  const cli = async (role: string, action: string, extra: string[] = []) => {
    const instance = instances[role];
    return JSON.parse(
      await run(
        descriptor.node,
        [
          join(sourceRoot, "scripts/development-instance.mjs"),
          action,
          "--worktree",
          instance.worktree,
          "--name",
          instance.name,
          "--store",
          instance.store,
          "--json",
          ...extra,
        ],
        action === "rebuild" ? 240000 : 45000,
      ),
    );
  };
  const receipts: Record<string, unknown> & { cleanup: Record<string, boolean> } = {
    version: 1,
    ok: false,
    managerCommit: descriptor.managerCommit,
    nativeSourceCommit: descriptor.nativeSource,
    events,
    cleanup: {},
  };
  const errorCategory = (error: unknown) =>
    error instanceof SshConnectionError
      ? ["unavailable", "daemon-missing", "incompatible", "invalid-target"].includes(error.code)
        ? error.code
        : "ssh-refused"
      : error instanceof assert.AssertionError
        ? "assertion-refused"
        : "fixture-refused";
  let stage = "preflight";
  let kernel!: Awaited<ReturnType<typeof createMacProcessIdentity>>;
  let trap: ReturnType<typeof createServer> | undefined;
  const trapSockets = new Set<Socket>();
  const allocations: Allocation[] = [],
    ssh: Record<string, Route> = {},
    clients: Record<string, Client> = {},
    ownedPids = new Set<number>();
  let oldForwardWitness: Awaited<ReturnType<typeof openSshDaemonTransport>> | undefined;
  let captureFlight: Promise<void> | null = null,
    captureTimer: ReturnType<typeof setInterval> | undefined,
    captureFailed = false;
  const tracker = ownedProcesses({
    identify: (pid: number) => kernel.identify(pid),
    list: async () => {
      const text = await run("/bin/ps", ["-axo", "pid=,ppid="], 3000, false);
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const value = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
          assert(value);
          return { pid: Number(value[1]), ppid: Number(value[2]) };
        });
    },
  });
  const sshParent = mkdtempSync(join(realpathSync(tmpdir()), "s-"));
  receipts.privateSshParent = sshParent;
  async function canonical(role: string) {
    return JSON.parse(readFileSync(join(instances[role].stateHome, "daemon.json"), "utf8"));
  }
  async function tmux(role: string, argv: string[]) {
    const i = instances[role],
      record = JSON.parse(readFileSync(join(i.root, "tmux.json"), "utf8")),
      stat = lstatSync(record.socket.path);
    assert.equal(stat.dev, record.socket.dev);
    assert.equal(stat.ino, record.socket.ino);
    assert.equal(
      Number(
        (
          await run(
            record.executable,
            ["-S", record.socket.path, "-N", "display-message", "-p", "#{pid}"],
            3000,
          )
        ).trim(),
      ),
      record.pid,
    );
    return (await run(record.executable, ["-S", record.socket.path, "-N", ...argv], 3000)).trim();
  }
  async function fingerprint(role: string) {
    const i = instances[role],
      record = JSON.parse(readFileSync(join(i.root, "tmux.json"), "utf8")),
      info = await canonical(role);
    const panes = await tmux(role, [
      "list-panes",
      "-s",
      "-t",
      descriptor.session,
      "-F",
      "#{pane_id}|#{pane_pid}",
    ]);
    return {
      daemonId: info.instanceId,
      daemonPid: info.pid,
      port: info.port,
      tmuxPid: record.pid,
      socket: { path: record.socket.path, dev: record.socket.dev, ino: record.socket.ino },
      panes,
    };
  }
  async function remember(role: string) {
    const status = await cli(role, "status");
    for (const pid of [status.daemon?.pid, status.tmux?.pid]) if (pid) ownedPids.add(pid);
    if (status.tmux) {
      for (const pid of (await tmux(role, ["list-panes", "-a", "-F", "#{pane_pid}"]))
        .split("\n")
        .map(Number))
        if (pid) ownedPids.add(pid);
    }
    return status;
  }
  async function workspace(role: string) {
    await tmux(role, [
      "new-session",
      "-d",
      "-s",
      descriptor.session,
      "-c",
      instances[role].worktree,
      "/bin/sh",
    ]);
    const info = await canonical(role);
    const response = await fetch(`http://127.0.0.1:${info.port}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.authToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
      },
      body: JSON.stringify({ sessionId: "session." + hash(descriptor.session).slice(0, 20) }),
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
    });
    assert(response.ok && (await response.json()).ok);
    await remember(role);
  }
  async function openClient(side: string) {
    const role = "client-" + side,
      target = "target-" + side,
      i = instances[role],
      fixture = ssh[side];
    const config = clientConfiguration({
      root: fixture.root,
      account: fixture.account,
      port: fixture.port,
      alias: fixture.alias,
      sharing: false,
      defaults: false,
    });
    writeFileSync(join(fixture.root, "ssh_config"), config, { flag: "wx", mode: 0o600 });
    fixture.files.capture("ssh_config");
    fixture.config = join(fixture.root, "ssh_config");
    const remote = prepareDevelopmentAppRemote({
      alias: fixture.alias,
      controlRoot: fixture.root,
      configHash: hash(config),
    });
    fixture.files.capture("native-ssh");
    fixture.files.capture("native-ssh/ssh");
    const input = join(out, "client-" + side + "-launch.json");
    save("client-" + side + "-launch.json", {
      node: descriptor.node,
      managerRoot: descriptor.managerRoot,
      instance: descriptor.instances.find((v: Tuple) => v.role === role),
      remote,
    });
    const req = createRequire(join(i.worktree, "packages/daemon/package.json")),
      pty = req("node-pty"),
      { Terminal } = req("@tmux-ide/xterm-headless");
    const vt = new Terminal({ cols: 120, rows: 32, allowProposedApi: true }),
      child: Pty = pty.spawn(descriptor.node, ["--import", "tsx", self, "--client", input], {
        cwd: sourceRoot,
        env,
        cols: 120,
        rows: 32,
      });
    const handle: Handle = Object.assign(new EventEmitter(), {
      pid: child.pid,
      kill: (signal: string) => {
        child.kill(signal);
        return true;
      },
      exitCode: null as number | null,
      signalCode: null as string | null,
    });
    tracker.retain(handle);
    const client: Client = {
      child,
      handle,
      vt,
      exited: false,
      frame: () =>
        Array.from(
          { length: 32 },
          (_, n) => vt.buffer.active.getLine(n)?.translateToString(true) ?? "",
        ).join("\n"),
    };
    clients[side] = client;
    child.onData((text: string) => vt.write(text));
    child.onExit((value: { exitCode: number }) => {
      client.exited = true;
      client.exitCode = value.exitCode;
      handle.exitCode = value.exitCode;
      handle.emit("close", value.exitCode);
    });
    const badge =
      "DEV " + i.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 12) + ":" + i.id.slice(4, 10);
    await wait(() => {
      assert(!client.exited);
      return client.frame().includes(badge);
    });
    await wait(() =>
      client
        .frame()
        .split("\n")
        .some(
          (line: string) =>
            line.slice(0, 29).includes(descriptor.session) && line.slice(0, 29).includes("1p"),
        ),
    );
    const row =
      client
        .frame()
        .split("\n")
        .findIndex(
          (line: string) =>
            line.slice(0, 29).includes(descriptor.session) && line.slice(0, 29).includes("1p"),
        ) + 1;
    child.write(`\x1b[<0;12;${row}M\x1b[<0;12;${row}m`);
    await delay(250);
    child.write("\x1bOQ");
    await wait(() => {
      const frame = client.frame();
      return (
        !frame.includes("Command palette") &&
        !frame.includes("Open terminals F2") &&
        !frame.includes("PASSIVE PREVIEW") &&
        frame
          .split("\n")
          .some(
            (line: string) =>
              line.slice(0, 29).includes("›") && line.slice(0, 29).includes(descriptor.session),
          )
      );
    });
    await tracker.capture();
    await remember(role);
    save(side + "-selected-frame.json", { frame: client.frame(), target, alias: fixture.alias });
  }
  async function io(side: string, label: string) {
    const c = clients[side];
    assert(c && !c.exited);
    const token = randomUUID().slice(0, 8),
      output = `d11_${side}_${token}_output_ok`,
      input = `d11_${side}_${token}_input_ok`;
    await tmux("target-" + side, [
      "send-keys",
      "-t",
      descriptor.session + ".0",
      "-l",
      `printf 'd11_${side}_${token}_output_\\157k\\n'`,
    ]);
    await tmux("target-" + side, ["send-keys", "-t", descriptor.session + ".0", "Enter"]);
    await wait(() => c.frame().includes(output), 30000);
    const row =
      c
        .frame()
        .split("\n")
        .findIndex((line: string) => line.includes(output)) + 1;
    c.child.write(`\x1b[<0;55;${row}M\x1b[<0;55;${row}m`);
    await delay(100);
    c.child.write(`printf 'd11_${side}_${token}_input_\\157k\\n'\r`);
    await wait(() => c.frame().includes(input));
    save(side + "-" + label + ".json", {
      frame: c.frame(),
      output,
      input,
      elapsedMs: Date.now() - started,
    });
  }
  async function tunnel(side: string, remotePort: number) {
    await tracker.capture();
    const candidates = tracker
      .snapshot()
      .ancestry.filter((v: { rootPid: number }) => v.rootPid === clients[side].handle.pid);
    for (const row of candidates) {
      const command = await run("/bin/ps", ["-p", String(row.pid), "-o", "command="], 1000).catch(
        () => "",
      );
      const pattern = new RegExp(
        `(?:^| )-L 127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:${remotePort}(?: |$)`,
      );
      const match = pattern.exec(command);
      if (match && command.includes("-- " + ssh[side].alias)) {
        const identity = await kernel.identify(row.pid);
        assert(identity !== null);
        return {
          pid: row.pid,
          identity,
          localPort: Number(match[1]),
          remotePort,
        };
      }
    }
    throw Error("Owned TUI tunnel unavailable");
  }
  async function closeClient(side: string) {
    const c = clients[side];
    if (!c || c.exited) return;
    c.child.write("\x11");
    await wait(() => c.exited, 10000);
    assert.equal(c.exitCode, 0);
    await wait(() => readdirSync(join(instances["client-" + side].root, "apps")).length === 0);
  }
  try {
    event(stage);
    assert.equal(process.execPath, descriptor.node);
    mkdirSync(descriptor.store, { mode: 0o700 });
    kernel = await createMacProcessIdentity({
      parent: sshParent,
      onAllocated: (v: Allocation) => allocations.push(v),
    });
    captureTimer = setInterval(() => {
      if (!captureFlight)
        captureFlight = tracker
          .capture()
          .catch(() => {
            captureFailed = true;
          })
          .finally(() => {
            captureFlight = null;
          });
    }, 100);
    for (const role of ["target-a", "target-b", "client-a", "client-b"]) {
      stage = "build-" + role;
      event(stage);
      save(role + "-build.json", await cli(role, "rebuild", ["--bun", descriptor.bun]));
      save(role + "-artifact.json", readDevelopmentBuild(instances[role], {}));
      stage = "up-" + role;
      event(stage);
      save(role + "-up.json", await cli(role, "up"));
      await remember(role);
    }
    for (const side of ["a", "b"]) {
      const role = "target-" + side;
      await workspace(role);
      const authority = await developmentSshAuthority(instances[role]);
      let lease: DevelopmentSshLease = authority.lease;
      const handshakeTimings: Array<Record<string, unknown>> = [];
      let omittedHandshakeTimings = 0;
      const fixture = await createOwnedSshFixture({
        parent: sshParent,
        node: descriptor.node,
        targetPort: lease.port,
        processes: tracker,
        onAllocated: (v: Allocation) => allocations.push(v),
        handshake: async () => {
          const began = Date.now();
          const timing: Record<string, unknown> = {
            startedMs: began - started,
            outcome: "pending",
          };
          if (handshakeTimings.length < 128) handshakeTimings.push(timing);
          else omittedHandshakeTimings++;
          try {
            const value = JSON.parse(await developmentSshHandshake(instances[role], lease));
            timing.outcome = "completed";
            return value;
          } catch {
            timing.outcome = "unavailable";
            // Lease refresh is a temporary fixture transition. Empty successful
            // SSH stdout would instead tell the client the descriptor is invalid.
            return RemoteDaemonHandshakeFailureSchema.parse({
              version: 1,
              error: { code: "unavailable" },
            });
          } finally {
            timing.elapsedMs = Date.now() - began;
            timing.finishedMs = Date.now() - started;
          }
        },
      });
      ssh[side] = {
        ...fixture,
        alias: "ti-dev-" + instances[role].id.slice(4),
        handshakeTimings,
        omittedHandshakeTimings: () => omittedHandshakeTimings,
        setLease: (value: DevelopmentSshLease) => {
          lease = value;
        },
      };
    }
    for (const side of ["a", "b"]) {
      stage = "open-" + side;
      event(stage);
      await openClient(side);
      await io(side, "before");
    }
    const original = await fingerprint("target-a"),
      sibling = await fingerprint("target-b"),
      oldCanonical = await canonical("target-a"),
      oldTunnel = await tunnel("a", original.port);
    receipts.original = original;
    receipts.sibling = sibling;
    receipts.oldTunnel = oldTunnel;
    save("before-replacement.json", { original, sibling, oldTunnel });
    const witnessForwards: Array<{ port: number; child: ReturnType<typeof spawn> }> = [];
    oldForwardWitness = await openSshDaemonTransport(
      { alias: ssh.a.alias, timeoutMs: 5000, signal: cancellation.signal },
      {
        spawn: (argv) => {
          // Only this independently owned witness may observe the raw -L listener.
          // The TUI and authenticated admission still use the production relay.
          const forwarding = argv.indexOf("-L");
          let port: number | undefined;
          if (forwarding >= 0) {
            assert.equal(argv.lastIndexOf("-L"), forwarding);
            assert(argv.includes("-N"));
            assert.equal(argv.at(-1), ssh.a.alias);
            const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(
              argv[forwarding + 1] ?? "",
            );
            assert(match);
            port = Number(match[1]);
            assert(Number.isInteger(port) && port > 0 && port <= 65535);
            assert.equal(Number(match[2]), original.port);
            assert.equal(witnessForwards.length, 0);
          }
          const child = tracker.retain(
            spawn("/usr/bin/ssh", ["-F", ssh.a.config, ...argv], {
              env,
              stdio: ["ignore", "pipe", "pipe"],
            }),
          );
          if (port !== undefined) witnessForwards.push({ port, child });
          return child;
        },
        allocatePort: unusedLoopbackPort,
        probe: probeSshDaemonIdentity,
      },
    );
    assert.equal(witnessForwards.length, 1);
    const witnessForward = witnessForwards[0]!;
    assert(witnessForward.child.pid);
    const witnessIdentity = await kernel.identify(witnessForward.child.pid);
    assert(witnessIdentity !== null);
    receipts.oldForwardWitness = {
      rawLocalPort: witnessForward.port,
      guardedLocalPort: Number(new URL(oldForwardWitness.baseUrl).port),
      remotePort: original.port,
      pid: witnessForward.child.pid,
      identity: witnessIdentity,
      role: "independent-refresh-survival-only",
    };
    stage = "daemon-only-down";
    event(stage);
    await Promise.all([
      cli("target-a", "down", ["--daemon-only"]),
      (async () => {
        await wait(async () => (await kernel.identify(original.daemonPid)) === null);
        const identity = await kernel.identify(oldTunnel.pid);
        receipts.daemonDeathObservation = {
          elapsedMs: Date.now() - started,
          originalTuiTunnelAlive: identity !== null && identity === oldTunnel.identity,
        };
        assert.equal(identity, oldTunnel.identity);
        await waitForPort(oldTunnel.localPort, true, 250);
        assert.equal(await kernel.identify(oldTunnel.pid), oldTunnel.identity);
        receipts.originalForwardBoundAtDeathObservation = true;
      })(),
    ]);
    event("daemon-retired");
    receipts.oldTunnelAliveAfterDown =
      (await kernel.identify(oldTunnel.pid)) === oldTunnel.identity;
    const trapFacts = {
      requests: 0,
      identityRequests: 0,
      credentialRequests: 0,
      witnessRequests: 0,
      samples: [] as Array<Record<string, unknown>>,
      omittedSamples: 0,
    };
    let replacementToken: string | null = null;
    const recordTrapRequest = (req: IncomingMessage, upgrade: boolean) => {
      trapFacts.requests++;
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://fixture.invalid");
      } catch {
        url = new URL("/invalid", "http://fixture.invalid");
      }
      const path = url.pathname;
      const endpoint =
        path === "/identity"
          ? "identity"
          : path === "/owned-witness"
            ? "witness"
            : path === "/ws/events"
              ? "semantic-events"
              : path === "/api/v2/terminal/pane-streams/issue"
                ? "pane-stream-issue"
                : path === "/v2/terminal/pane-streams/redeem"
                  ? "pane-stream-redeem"
                  : path.startsWith("/api/v2/action/")
                    ? "owner-action"
                    : path.startsWith("/api/project/") &&
                        path.endsWith("/terminal-runtime-inventory")
                      ? "terminal-inventory"
                      : path.startsWith("/api/project/") && path.endsWith("/application-shell")
                        ? "application-shell"
                        : path === "/api/v2/capabilities"
                          ? "capabilities"
                          : "other";
      const authorization = req.headers.authorization;
      const cookie = req.headers.cookie;
      const queryValues = ["token", "authToken", "auth", "access_token"].flatMap((name) =>
        url.searchParams.getAll(name),
      );
      const authorizationPresent = Boolean(authorization);
      const cookiePresent = Boolean(cookie);
      const queryCredentialPresent = queryValues.length > 0;
      const credentialsPresent = authorizationPresent || cookiePresent || queryCredentialPresent;
      // Only fixed classes and equality booleans leave this callback. Do not persist
      // request paths, headers, cookies, query values or generated owner tokens.
      const values = [
        ...(authorization?.startsWith("Bearer ") ? [authorization.slice(7)] : []),
        ...(cookie?.split(";").map((part) => part.slice(part.indexOf("=") + 1).trim()) ?? []),
        ...queryValues,
      ];
      if (endpoint === "identity") trapFacts.identityRequests++;
      if (endpoint === "witness") trapFacts.witnessRequests++;
      if (credentialsPresent) trapFacts.credentialRequests++;
      if (trapFacts.samples.length < 128)
        trapFacts.samples.push({
          elapsedMs: Date.now() - started,
          endpoint,
          upgrade,
          authorizationPresent,
          cookiePresent,
          queryCredentialPresent,
          oldOwnerTokenMatches: values.includes(oldCanonical.authToken),
          replacementOwnerTokenMatches:
            replacementToken === null ? null : values.includes(replacementToken),
        });
      else trapFacts.omittedSamples++;
    };
    receipts.trap = trapFacts;
    const trapIdentity = {
      ...oldCanonical,
      instanceId: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    delete trapIdentity.authToken;
    delete trapIdentity.port;
    delete trapIdentity.bindHostname;
    trap = createServer((req, res) => {
      recordTrapRequest(req, false);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, ...trapIdentity }));
    });
    trap.on("connection", (socket) => {
      if (trapSockets.size >= 32) {
        socket.destroy();
        return;
      }
      trapSockets.add(socket);
      socket.setTimeout(2000, () => socket.destroy());
      socket.once("close", () => trapSockets.delete(socket));
    });
    trap.on("upgrade", (req, socket) => {
      recordTrapRequest(req, true);
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      trap!.once("error", reject);
      trap!.listen(original.port, "127.0.0.1", resolve);
    });
    event("old-port-trap-ready");
    await io("b", "during");
    stage = "replacement-up";
    event(stage);
    await cli("target-a", "up");
    await remember("target-a");
    const next = await developmentSshAuthority(instances["target-a"]),
      nextCanonical = await canonical("target-a");
    assert.notEqual(next.lease.port, original.port);
    assert.notEqual(next.lease.daemonId, original.daemonId);
    receipts.tokenChanged = oldCanonical.authToken !== nextCanonical.authToken;
    assert(receipts.tokenChanged);
    replacementToken = nextCanonical.authToken;
    ssh.a.setLease(next.lease);
    stage = "listener-refresh";
    event(stage);
    receipts.refresh = await ssh.a.refreshTargetPort(next.lease.port);
    stage = "fixture-listener-bind";
    const bindStarted = Date.now();
    await waitForPort(ssh.a.port, true, 2000);
    receipts.fixtureReloadListening = {
      elapsedMs: Date.now() - bindStarted,
      listening: true,
    };
    stage = "fixture-reload-readiness";
    const readinessAttempts: Array<Record<string, unknown>> = [];
    receipts.fixtureReloadReadiness = readinessAttempts;
    let listenerReady = false;
    // Discovery includes immutable build verification and a CLI with a 5s deadline.
    // Use one normal transport budget, not repeated attempts shorter than that work.
    {
      const attempt = 1;
      checkCancellation();
      const attemptStarted = Date.now();
      const closes: Promise<void>[] = [];
      const diagnosticReaders: Array<ReturnType<typeof sshDiagnosticSink>> = [];
      let proof: Awaited<ReturnType<typeof openSshDaemonTransport>> | undefined;
      let accepted = false;
      let category = "ready";
      try {
        proof = await openSshDaemonTransport(
          {
            alias: ssh.a.alias,
            timeoutMs: 15000,
            signal: cancellation.signal,
          },
          {
            spawn: (argv) => {
              const child = tracker.retain(
                spawn("/usr/bin/ssh", ["-F", ssh.a.config, ...argv], {
                  env,
                  stdio: ["ignore", "pipe", "pipe"],
                }),
              );
              closes.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
              diagnosticReaders.push(sshDiagnosticSink(child.stderr));
              return child;
            },
            allocatePort: unusedLoopbackPort,
            probe: probeSshDaemonIdentity,
          },
        );
        assert.equal(proof.daemon.instanceId, next.lease.daemonId);
        accepted = true;
      } catch (error) {
        category = errorCategory(error);
      } finally {
        proof?.dispose();
        if (proof) closes.push(proof.closed);
        await Promise.race([
          Promise.all(closes),
          delay(2000).then(() => {
            throw Error("Listener probe close deadline");
          }),
        ]);
        readinessAttempts.push({
          attempt,
          elapsedMs: Date.now() - attemptStarted,
          accepted,
          category,
          diagnostics: diagnosticReaders.map((read) => read()),
        });
      }
      listenerReady = accepted;
    }
    assert(listenerReady);
    receipts.refreshedPid = ssh.a.confirmRefreshedPid();
    event("refreshed-listener-authenticated");
    assert.equal(await kernel.identify(witnessForward.child.pid), witnessIdentity);
    await waitForPort(witnessForward.port, true, 250);
    // No credentials, cookies or redirect-following: this checks only the retained
    // SSH channel across sshd reload, deliberately separate from guarded TUI traffic.
    const witnessResponse = await fetch(`http://127.0.0.1:${witnessForward.port}/owned-witness`, {
      redirect: "error",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(1000)]),
    });
    assert(witnessResponse.ok);
    await witnessResponse.body?.cancel();
    assert.equal(trapFacts.witnessRequests, 1);
    assert.equal(await kernel.identify(witnessForward.child.pid), witnessIdentity);
    receipts.oldTuiTunnelAliveAfterRefresh =
      (await kernel.identify(oldTunnel.pid)) === oldTunnel.identity;
    receipts.oldForwardAliveAfterRefresh = true;
    event("refreshed-listener-old-witness-forward-proven");
    oldForwardWitness.dispose();
    await Promise.race([
      oldForwardWitness.closed,
      delay(2000).then(() => {
        throw Error("Old witness close deadline");
      }),
    ]);
    oldForwardWitness = undefined;
    stage = "retained-client-recovery";
    event(stage);
    await io("a", "after");
    const replacement = await fingerprint("target-a");
    assert.equal(replacement.tmuxPid, original.tmuxPid);
    assert.deepEqual(replacement.socket, original.socket);
    assert.equal(replacement.panes, original.panes);
    receipts.replacement = replacement;
    const newTunnel = await tunnel("a", replacement.port);
    receipts.newTunnel = newTunnel;
    assert.notEqual(newTunnel.pid, oldTunnel.pid);
    await wait(async () => (await kernel.identify(oldTunnel.pid)) === null);
    receipts.retainedClientRecovered = true;
    receipts.trap = trapFacts;
    stage = "stale-endpoint-credential-boundary";
    event(stage);
    assert.equal(trapFacts.credentialRequests, 0);
    assert(trapFacts.identityRequests > 0);
    stage = "healthy-sibling-after-recovery";
    event(stage);
    await io("b", "after");
    assert.deepEqual(await fingerprint("target-b"), sibling);
    receipts.recoveryQualified = true;
    event("recovery-qualified");
  } catch (error) {
    receipts.failure = {
      stage,
      detail: errorCategory(error),
      category: cancellation.signal.aborted ? "cancelled" : "native-ssh-recovery-refused",
    };
    for (const [side, c] of Object.entries(clients))
      save(side + "-failure-frame.json", { frame: c.frame(), exited: c.exited });
  } finally {
    cleaning = true;
    receipts.cleanupStartedMs = Date.now() - started;
    if (captureTimer) clearInterval(captureTimer);
    await captureFlight;
    for (const side of ["a", "b"]) {
      try {
        await closeClient(side);
        receipts.cleanup["client-" + side] = true;
      } catch {
        receipts.cleanup["client-" + side] = false;
      }
    }
    try {
      if (oldForwardWitness) {
        oldForwardWitness.dispose();
        await Promise.race([
          oldForwardWitness.closed,
          delay(2000).then(() => {
            throw Error("Old witness cleanup deadline");
          }),
        ]);
      }
      receipts.cleanup.oldForwardWitness = true;
    } catch {
      receipts.cleanup.oldForwardWitness = false;
    }
    try {
      await tracker.dispose();
      receipts.cleanup.ssh = !captureFailed;
    } catch {
      receipts.cleanup.ssh = false;
    }
    if (trap) {
      for (const socket of trapSockets) socket.destroy();
      trap.closeAllConnections();
      await new Promise<void>((r) => trap!.close(() => r()));
    }
    const protectedTargets = new Set<string>();
    for (const [side, route] of Object.entries(ssh)) {
      try {
        // Discovery verifies these owners' immutable artifacts. Confirm that work
        // has settled before reset can remove its inputs, not just its SSH files.
        await route.disposeFiles();
        receipts.cleanup["ssh-" + side + "-discovery"] = true;
      } catch {
        protectedTargets.add("target-" + side);
        receipts.cleanup["ssh-" + side + "-discovery"] = false;
      }
    }
    for (const role of ["client-a", "client-b", "target-a", "target-b"]) {
      if (protectedTargets.has(role)) {
        receipts.cleanup[role + "-owner"] = false;
        continue;
      }
      try {
        if (await readDevelopmentIdentity(instances[role])) {
          await cli(role, "down");
          await cli(role, "reset", ["--yes"]);
        }
        const remaining = existsSync(instances[role].root) ? readdirSync(instances[role].root) : [];
        assert(remaining.every((name) => ["locks", "reset.json"].includes(name)));
        assert(!existsSync(instances[role].runtimeDir));
        receipts.cleanup[role + "-owner"] = true;
      } catch {
        receipts.cleanup[role + "-owner"] = false;
      }
    }
    const observed = tracker.snapshot();
    for (const root of observed.retainedRoots) if (root.pid) ownedPids.add(root.pid);
    for (const row of observed.ancestry) ownedPids.add(row.pid);
    const processResults = await Promise.all(
      [...ownedPids].map(async (pid) => ({
        pid,
        gone: await kernel
          .identify(pid)
          .then((v: string | null) => v === null)
          .catch(() => false),
      })),
    );
    receipts.processes = processResults;
    receipts.processObservation = observed;
    receipts.cleanup.processes = processResults.every((v) => v.gone);
    const retired = await Promise.allSettled(allocations.map((v) => v.disposeFiles()));
    receipts.cleanup.privateFiles = retired.every((v) => v.status === "fulfilled");
    receipts.fixtureDiagnostics = allocations.map((v) => ({
      root: v.root,
      diagnostic: v.diagnostics?.(),
    }));
    receipts.sshRoutes = Object.fromEntries(
      Object.entries(ssh).map(([side, route]) => [
        side,
        {
          port: route.port,
          pid: route.sshdPid,
          hostKeyHash: hash(route.publicKey),
          metrics: route.metrics(),
          handshakeTimings: route.handshakeTimings,
          omittedHandshakeTimings: route.omittedHandshakeTimings(),
        },
      ]),
    );
    receipts.ok =
      receipts.recoveryQualified === true && Object.values(receipts.cleanup).every(Boolean);
    receipts.elapsedMs = Date.now() - started;
    save("qualification.json", receipts);
    for (const c of Object.values(clients)) c.vt.dispose();
    process.stdout.write(
      JSON.stringify({ ok: receipts.ok, failure: receipts.failure, cleanup: receipts.cleanup }) +
        "\n",
    );
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    process.exitCode = receipts.ok ? 0 : 1;
  }
}
