/** Opt-in test infrastructure. Never uses the user's SSH config, agent or default sockets. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { userInfo } from "node:os";
import { createServer, connect } from "node:net";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  chmodSync,
  renameSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = () => new Error("Owned SSH fixture refused");
export function fixturePath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !/^[A-Za-z0-9_./-]+$/u.test(path)
  )
    throw fail();
  return path;
}
export function socketPath(path, reserve = 0) {
  fixturePath(path);
  if (!Number.isInteger(reserve) || reserve < 0 || Buffer.byteLength(path) + reserve > 103)
    throw fail();
  return path;
}
const quote = (path) => `"${fixturePath(path)}"`;
function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw fail();
  return value;
}
export function serverConfiguration({
  root,
  node,
  account,
  port: listenPort,
  targetPort,
  jump = false,
  missingPath = false,
}) {
  fixturePath(root);
  fixturePath(node);
  socketPath(join(root, "discovery.sock"));
  socketPath(join(root, "m"), 17);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/iu.test(account)) throw fail();
  return `Port ${port(listenPort)}\nListenAddress 127.0.0.1\nHostKey ${quote(join(root, "host"))}\nPidFile ${quote(join(root, "sshd.pid"))}\nAuthorizedKeysFile ${quote(join(root, "authorized_keys"))}\nAllowUsers ${account}\nStrictModes yes\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nHostbasedAuthentication no\nUsePAM no\nPermitUserRC no\nPermitUserEnvironment no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nAllowStreamLocalForwarding no\nAllowTcpForwarding local\nGatewayPorts no\nPermitListen none\nPermitOpen 127.0.0.1:${port(targetPort)}\nMaxSessions 4\nMaxStartups 4\nLoginGraceTime 5\nSetEnv HOME=${quote(join(root, "home"))} ZDOTDIR=${quote(join(root, "home"))} PATH=${quote(join(root, missingPath ? "empty" : "bin"))}\nForceCommand ${jump ? "/usr/bin/false" : `${quote(node)} ${quote(join(root, "dispatch.mjs"))}`}\n`;
}
export function verifyEffectiveServer(text, expected) {
  const fields = new Map();
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) {
      const k = line.slice(0, at),
        v = line.slice(at + 1);
      fields.set(k, [...(fields.get(k) ?? []), v]);
    }
  }
  const required = {
    port: String(expected.port),
    listenaddress: `127.0.0.1:${expected.port}`,
    passwordauthentication: "no",
    kbdinteractiveauthentication: "no",
    pubkeyauthentication: "yes",
    permituserrc: "no",
    permituserenvironment: "no",
    allowagentforwarding: "no",
    x11forwarding: "no",
    permittunnel: "no",
    allowstreamlocalforwarding: "no",
    allowtcpforwarding: "local",
    gatewayports: "no",
    permitlisten: "none",
    permitopen: `127.0.0.1:${expected.targetPort}`,
    strictmodes: "yes",
    usepam: "no",
    allowusers: expected.account,
    authorizedkeysfile: join(expected.root, "authorized_keys"),
    hostkey: join(expected.root, "host"),
  };
  for (const [k, v] of Object.entries(required)) {
    if (JSON.stringify(fields.get(k)) !== JSON.stringify([v])) throw fail();
  }
  const env = new Map();
  for (const line of fields.get("setenv") ?? []) {
    for (const pair of line.split(/ +/u)) {
      const match = /^(HOME|ZDOTDIR|PATH)=([A-Za-z0-9_./-]+)$/u.exec(pair);
      if (!match || env.has(match[1])) throw fail();
      env.set(match[1], match[2]);
    }
  }
  for (const [k, v] of Object.entries({
    HOME: join(expected.root, "home"),
    ZDOTDIR: join(expected.root, "home"),
    PATH: join(expected.root, expected.missingPath ? "empty" : "bin"),
  })) {
    if (env.get(k) !== v) throw fail();
  }
  const command = fields.get("forcecommand")?.join(" ");
  if (
    command !==
    (expected.jump
      ? "/usr/bin/false"
      : `${quote(expected.node)} ${quote(join(expected.root, "dispatch.mjs"))}`)
  )
    throw fail();
  return {
    publicKeyOnly: true,
    userRcDisabled: true,
    privateEnvironment: true,
    loopback: true,
    restrictedForwarding: true,
  };
}
/** @param {{root:string,account:string,port:number,alias?:string,jump?:string,identity?:string,known?:string,sharing?:boolean,defaults?:boolean}} options */
export function clientConfiguration({
  root,
  account,
  port: remotePort,
  alias = "target",
  jump = undefined,
  identity = undefined,
  known = undefined,
  sharing = true,
  defaults = true,
}) {
  if (jump && !/^[a-z][a-z0-9-]{0,31}$/u.test(jump)) throw fail();
  socketPath(join(root, "m"), 17);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(alias) || !/^[a-z_][a-z0-9_-]{0,31}$/iu.test(account))
    throw fail();
  return `Host ${alias}\n HostName 127.0.0.1\n Port ${port(remotePort)}\n User ${account}\n IdentityFile ${quote(identity ?? join(root, "client"))}\n UserKnownHostsFile ${quote(known ?? join(root, "known_hosts"))}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n IdentitiesOnly yes\n IdentityAgent none\n ForwardAgent no\n BatchMode yes\n PasswordAuthentication no\n KbdInteractiveAuthentication no\n${jump ? ` ProxyJump ${jump}\n` : ""}${sharing ? "" : ` ControlMaster no\n ControlPath none\n`}${defaults ? `Host *\n ControlMaster auto\n ControlPath ${quote(join(root, "m"))}\n ControlPersist 10m\n ForkAfterAuthentication yes\n` : ""}`;
}
/** Handles authorize only their own signals. Captured descendants require exact ancestry and incarnation. */
export function ownedProcesses({ identify, list, signal = (pid, s) => process.kill(pid, s) }) {
  const roots = [],
    descendants = new Map(),
    ancestry = new Map();
  const diagnostics = [];
  function diagnostic(value) {
    if (diagnostics.length < 16) diagnostics.push(value);
  }
  function recordIdentityChange(stage, pid, previous, current) {
    const prefix = /^([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.+)$/u;
    const before = prefix.exec(previous),
      after = prefix.exec(current);
    diagnostic({
      stage,
      pid,
      sameStartPrefix: before && after ? before[1] === after[1] : null,
      commandTailChanged: before && after ? before[2] !== after[2] : null,
    });
    throw fail();
  }
  async function rootIdentity(pid) {
    try {
      return await identify(pid);
    } catch (error) {
      diagnostic({ stage: "root-identity-read-refused", pid });
      throw error;
    }
  }
  let flight = null;
  const capture = () => {
    if (!flight)
      flight = captureNow().finally(() => {
        flight = null;
      });
    return flight;
  };
  let disposing = false;
  const retain = (child) => {
    if (disposing) throw fail();
    let done = false;
    const closed = new Promise((r) => {
      child.once("close", () => {
        done = true;
        r();
      });
    });
    child.once("error", () => {});
    const entry = {
      child,
      closed,
      get done() {
        return done;
      },
      identity: null,
    };
    roots.push(entry);
    return child;
  };
  async function captureNow() {
    let at = "roots",
      capturePid = null;
    const diagnosticCount = diagnostics.length;
    try {
      for (const r of roots) {
        if (r.done || !r.child.pid) continue;
        const identity = await rootIdentity(r.child.pid);
        if (identity === null) continue;
        if (r.identity && r.identity !== identity)
          recordIdentityChange("root-identity-changed", r.child.pid, r.identity, identity);
        r.identity = identity;
      }
      at = "before-process-list";
      const before = await list();
      if (before.length > 8192) throw fail();
      const selected = new Map(
        roots.filter((r) => !r.done && r.identity).map((r) => [r.child.pid, r.identity]),
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of before) {
          if (selected.has(row.ppid) && !selected.has(row.pid)) {
            if (selected.size >= 128) throw fail();
            at = "descendant-identity-read";
            capturePid = row.pid;
            const value = await identify(row.pid);
            if (value !== null) {
              selected.set(row.pid, value);
              changed = true;
            }
          }
        }
      }
      at = "after-process-list";
      capturePid = null;
      const after = await list();
      for (const [pid, identity] of selected) {
        at = "verification";
        capturePid = pid;
        const root = roots.find((r) => r.child.pid === pid);
        if (root) {
          const current = await rootIdentity(pid);
          if (!root.done && current !== null && current !== identity)
            recordIdentityChange("root-verification-changed", pid, identity, current);
          continue;
        }
        const a = before.find((v) => v.pid === pid),
          b = after.find((v) => v.pid === pid);
        const current = await identify(pid);
        if (current === null) continue;
        if (!a || !b || a.ppid !== b.ppid || !selected.has(b.ppid) || current !== identity) {
          diagnostic({
            stage: "descendant-binding-refused",
            pid,
            beforePresent: !!a,
            afterPresent: !!b,
            parentEqual: a && b ? a.ppid === b.ppid : null,
            identityEqual: current === identity,
            previouslyOwned: descendants.has(pid),
          });
          throw fail();
        }
        if (descendants.has(pid) && descendants.get(pid) !== identity) {
          diagnostic({ stage: "descendant-incarnation-refused", pid });
          throw fail();
        }
        descendants.set(pid, identity);
        at = "ancestor-chain";
        let ancestor = b.ppid;
        let hops = 0;
        while (!roots.some((r) => r.child.pid === ancestor)) {
          if (++hops > 128) throw fail();
          const parent = before.find((r) => r.pid === ancestor);
          if (!parent) throw fail();
          ancestor = parent.ppid;
        }
        ancestry.set(pid, ancestor);
      }
    } catch (error) {
      if (diagnostics.length === diagnosticCount)
        diagnostic({
          stage: "capture-refused",
          at,
          pid: capturePid,
          ...(error instanceof KernelWitnessReadError ? { kernelExit: error.status } : {}),
        });
      throw error;
    }
  }
  async function dispose() {
    disposing = true;
    let refused = false;
    try {
      await capture();
    } catch {
      refused = true;
    }
    async function send(kind) {
      for (const r of roots)
        if (!r.done) {
          try {
            r.child.kill(kind);
          } catch {
            refused = true;
          }
        }
      for (const [pid, id] of descendants) {
        try {
          const now = await identify(pid);
          if (now !== null) {
            if (now !== id) {
              refused = true;
              continue;
            }
            signal(pid, kind);
          }
        } catch {
          refused = true;
        }
      }
    }
    async function gone() {
      let all = roots.every((r) => r.done);
      for (const [pid, id] of descendants) {
        try {
          const now = await identify(pid);
          if (now !== null) {
            all = false;
            if (now !== id) refused = true;
          }
        } catch {
          all = false;
          refused = true;
        }
      }
      return all;
    }
    await send("SIGTERM");
    const end = Date.now() + 1500;
    while (Date.now() < end && !(await gone())) await delay(20);
    if (!(await gone())) {
      await send("SIGKILL");
      const endKill = Date.now() + 1000;
      while (Date.now() < endKill && !(await gone())) await delay(20);
    }
    if (!(await gone()) || refused) throw fail();
    return { closed: true, roots: roots.length, descendants: descendants.size };
  }
  return {
    retain,
    capture,
    dispose,
    snapshot: () => ({
      roots: roots.length,
      retainedRoots: roots.map((r) => ({ pid: r.child.pid ?? null, closed: r.done })),
      diagnostics: [...diagnostics],
      descendants: descendants.size,
      ancestry: [...ancestry].map(([pid, rootPid]) => ({ pid, rootPid })),
    }),
  };
}
export async function unusedLoopbackPort() {
  const s = createServer();
  await new Promise((r, j) => {
    s.once("error", j);
    s.listen(0, "127.0.0.1", r);
  });
  const value = s.address().port;
  await new Promise((r) => s.close(r));
  return value;
}
export async function waitForPort(value, open, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const yes = await new Promise((r) => {
      const s = connect({ host: "127.0.0.1", port: value });
      const finish = (v) => {
        s.destroy();
        r(v);
      };
      s.once("connect", () => finish(true));
      s.once("error", () => finish(false));
      s.setTimeout(100, () => finish(false));
    });
    if (yes === open) return;
    await delay(25);
  }
  throw fail();
}
function hashPrivateFile(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      before.size > 262144
    )
      throw fail();
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd);
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw fail();
    return createHash("sha256").update(bytes.subarray(0, count)).digest("hex");
  } finally {
    closeSync(fd);
  }
}
/** Removes only recorded unchanged private files; refusal preserves credentials for owned recovery. */
export function privateFiles(root) {
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw fail();
  const records = new Map();
  const capture = (name, expected = null) => {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?$/u.test(name) ||
      name.split("/").some((v) => v === "." || v === "..")
    )
      throw fail();
    if (name.includes("/")) {
      const parent = lstatSync(join(root, name.split("/")[0]));
      if (parent.isSymbolicLink() || !parent.isDirectory() || !records.has(name.split("/")[0]))
        throw fail();
    }
    const path = join(root, name),
      s = lstatSync(path);
    if (
      s.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      s.mode & 0o077 ||
      (s.nlink !== 1 && !s.isDirectory())
    )
      throw fail();
    const digest = s.isFile() ? hashPrivateFile(path, s) : null;
    if (expected && (s.dev !== expected.dev || s.ino !== expected.ino || digest !== expected.hash))
      throw fail();
    records.set(name, {
      dev: s.dev,
      ino: s.ino,
      directory: s.isDirectory(),
      socket: s.isSocket(),
      hash: digest,
    });
  };
  const clean = () => {
    const now = lstatSync(root);
    if (
      now.dev !== stat.dev ||
      now.ino !== stat.ino ||
      now.isSymbolicLink() ||
      now.uid !== stat.uid ||
      now.mode & 0o077
    )
      throw fail();
    const found = [];
    const entries = readdirSync(root);
    if (entries.length > 32) throw fail();
    for (const name of entries) {
      found.push(name);
      const item = lstatSync(join(root, name));
      if (item.isSymbolicLink()) throw fail();
      if (item.isDirectory()) {
        const children = readdirSync(join(root, name));
        if (children.length > 16) throw fail();
        for (const child of children) found.push(name + "/" + child);
      }
    }
    for (const name of found) {
      const record = records.get(name);
      if (!record) throw fail();
      const s = lstatSync(join(root, name));
      if (
        s.isSymbolicLink() ||
        s.dev !== record.dev ||
        s.ino !== record.ino ||
        (record.hash && hashPrivateFile(join(root, name), s) !== record.hash)
      )
        throw fail();
    }
    for (const name of found.sort((a, b) => b.length - a.length)) {
      const r = records.get(name);
      if (r.directory) rmdirSync(join(root, name));
      else unlinkSync(join(root, name));
    }
    rmdirSync(root);
  };
  const verify = (name) => {
    const rootNow = lstatSync(root);
    if (
      rootNow.isSymbolicLink() ||
      rootNow.dev !== stat.dev ||
      rootNow.ino !== stat.ino ||
      rootNow.uid !== stat.uid ||
      rootNow.mode & 0o077
    )
      throw fail();
    const record = records.get(name);
    if (!record) throw fail();
    const current = lstatSync(join(root, name));
    if (
      current.isSymbolicLink() ||
      current.dev !== record.dev ||
      current.ino !== record.ino ||
      current.uid !== process.getuid() ||
      current.mode & 0o077 ||
      (record.hash && hashPrivateFile(join(root, name), current) !== record.hash)
    )
      throw fail();
  };
  return { capture, clean, verify };
}
export async function createOwnedSshFixture({
  parent,
  node,
  account = userInfo().username,
  targetPort,
  jump = false,
  missingPath = false,
  handshake,
  processes,
  onAllocated,
}) {
  if (process.platform !== "darwin" || process.getuid() === 0 || userInfo().shell !== "/bin/zsh")
    throw fail();
  if (typeof onAllocated !== "function") throw fail();
  parent = fixturePath(realpathSync(fixturePath(parent)));
  node = fixturePath(realpathSync(fixturePath(node)));
  socketPath(join(parent, "ssh-XXXXXX", "discovery.sock"));
  const root = mkdtempSync(join(parent, "ssh-"));
  chmodSync(root, 0o700);
  const files = privateFiles(root),
    listeners = [],
    sockets = new Set();
  let mode = "normal",
    disposed = false,
    closing = false,
    listenPort = null;
  let stage = "allocated",
    failureStage = null;
  let sshdDiagnostics = null;
  const timers = new Set();
  const metrics = { requests: 0, deliveredBytes: 0, stalls: 0, handshakeFailures: 0 };
  const pending = new Set();
  const handshakeWork = createFixtureHandshakeWork(handshake);
  const disposeFiles = async () => {
    if (disposed) return;
    closing = true;
    handshakeWork.close();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const listenerClosures = listeners
      .filter((listener) => listener.listening)
      .map((listener) => new Promise((resolve) => listener.close(resolve)));
    for (const socket of sockets) socket.destroy();
    await Promise.all(listenerClosures);
    await Promise.allSettled([...pending]);
    // A response deadline does not cancel its producer. Preserve private files if
    // actual discovery work cannot be confirmed settled within the cleanup budget.
    await handshakeWork.settle();
    if (listenPort) await waitForPort(listenPort, false);
    files.clean();
    disposed = true;
  };
  onAllocated({
    root,
    disposeFiles,
    diagnostics: () => ({
      stage,
      failureStage,
      ...(sshdDiagnostics ? { sshd: sshdDiagnostics() } : {}),
    }),
  });
  const write = (name, text, mode = 0o600) => {
    writeFileSync(join(root, name), text, { flag: "wx", mode });
    files.capture(name);
  };
  for (const name of ["home", "bin", "empty"]) {
    mkdirSync(join(root, name), { mode: 0o700 });
    files.capture(name);
  }
  const tool = async (file, args) =>
    (
      await execute(file, args, {
        timeout: 5000,
        maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), ZDOTDIR: join(root, "home") },
      })
    ).stdout;
  let child, configProof;
  try {
    stage = "keys";
    for (const name of ["host", "client"]) {
      await tool("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(root, name)]);
      chmodSync(join(root, name + ".pub"), 0o600);
      files.capture(name);
      files.capture(name + ".pub");
    }
    write("authorized_keys", readFileSync(join(root, "client.pub")));
    listenPort = await unusedLoopbackPort();
    write(
      "known_hosts",
      `[127.0.0.1]:${listenPort} ${readFileSync(join(root, "host.pub"), "utf8")}`,
    );
    stage = "discovery-listener";
    const ipc = join(root, "discovery.sock");
    const server = createServer((socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      metrics.requests++;
      if (sockets.size >= 8) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(20000, () => socket.destroy());
      if (mode === "stall") {
        metrics.stalls++;
        return;
      }
      const deliver = () => {
        if (socket.destroyed) return;
        const task = handshakeWork
          .encode(mode)
          .then((value) => {
            if (socket.destroyed) return;
            metrics.deliveredBytes += Buffer.byteLength(value);
            socket.end(value);
          })
          .catch(() => {
            metrics.handshakeFailures++;
            socket.destroy();
          })
          .finally(() => pending.delete(task));
        pending.add(task);
      };
      if (mode === "delay") {
        const timer = setTimeout(() => {
          timers.delete(timer);
          deliver();
        }, 250);
        timers.add(timer);
        socket.once("close", () => {
          clearTimeout(timer);
          timers.delete(timer);
        });
      } else deliver();
    });
    await new Promise((r, j) => {
      server.once("error", j);
      server.listen(ipc, r);
    });
    chmodSync(ipc, 0o600);
    files.capture("discovery.sock");
    listeners.push(server);
    write(
      "bin/tmux-ide",
      `#!${node}\nconst{connect}=require('node:net');if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['remote-daemon-info','--json']))process.exit(64);const s=connect(${JSON.stringify(ipc)});let n=0;s.on('data',b=>{n+=b.length;if(n>65536){s.destroy();process.exitCode=1;}else process.stdout.write(b);});s.on('error',()=>{process.exitCode=1;});s.setTimeout(20000,()=>{s.destroy();process.exitCode=1;});\n`,
      0o700,
    );
    write("home/.zshenv", "export TMUX_IDE_D11_PRIVATE_SHELL=1\n");
    write(
      "dispatch.mjs",
      `import{spawn}from'node:child_process';if(process.env.TMUX_IDE_D11_PRIVATE_SHELL!=='1'||process.env.SSH_ORIGINAL_COMMAND!=='tmux-ide remote-daemon-info --json'||process.env.HOME!==${JSON.stringify(join(root, "home"))}||process.env.ZDOTDIR!==${JSON.stringify(join(root, "home"))}||process.env.PATH!==${JSON.stringify(join(root, missingPath ? "empty" : "bin"))})process.exit(64);const c=spawn('tmux-ide',['remote-daemon-info','--json'],{stdio:'inherit',env:{HOME:process.env.HOME,ZDOTDIR:process.env.ZDOTDIR,PATH:process.env.PATH}});c.on('error',()=>{process.exitCode=127;});c.on('exit',(code)=>{process.exitCode=code??1;});\n`,
    );
    stage = "configuration";
    const spec = { root, node, account, port: listenPort, targetPort, jump, missingPath };
    write("sshd_config", serverConfiguration(spec));
    stage = "effective-config";
    const effective = await tool("/usr/sbin/sshd", [
      "-T",
      "-f",
      join(root, "sshd_config"),
      "-C",
      `user=${account},host=localhost,addr=127.0.0.1`,
    ]);
    configProof = verifyEffectiveServer(effective, spec);
    write("client_config", clientConfiguration({ ...spec, jump: undefined }));
    stage = "spawn";
    child = processes.retain(
      spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(root, "sshd_config")], {
        stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), ZDOTDIR: join(root, "home") },
      }),
    );
    sshdDiagnostics = sshDiagnosticSink(child.stderr);
    stage = "process-capture";
    await processes.capture();
    stage = "listen";
    await waitForPort(listenPort, true);
    stage = "pid-witness";
    try {
      files.capture("sshd.pid");
    } catch {
      throw fail();
    }
    stage = "ready";
    return {
      root,
      port: listenPort,
      sshdPid: child.pid,
      async refreshTargetPort(nextPort) {
        if (closing || disposed || child.exitCode !== null || child.signalCode !== null)
          throw fail();
        const next = { ...spec, targetPort: port(nextPort) };
        files.verify("sshd_config");
        files.verify("host");
        files.verify("authorized_keys");
        write("refresh_config", serverConfiguration(next));
        const effective = await tool("/usr/sbin/sshd", [
          "-T",
          "-f",
          join(root, "refresh_config"),
          "-C",
          `user=${account},host=localhost,addr=127.0.0.1`,
        ]);
        const proof = verifyEffectiveServer(effective, next);
        files.verify("sshd_config");
        files.verify("refresh_config");
        renameSync(join(root, "refresh_config"), join(root, "sshd_config"));
        files.capture("sshd_config");
        if (!child.kill("SIGHUP")) throw fail();
        spec.targetPort = next.targetPort;
        return {
          signalled: true,
          pid: child.pid,
          targetPort: next.targetPort,
          effectiveConfiguration: proof,
        };
      },
      confirmRefreshedPid() {
        if (closing || disposed || child.exitCode !== null || child.signalCode !== null)
          throw fail();
        files.verify("sshd_config");
        const fd = openSync(join(root, "sshd.pid"), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.uid !== process.getuid() ||
            stat.mode & 0o077 ||
            stat.nlink !== 1 ||
            stat.size > 32
          )
            throw fail();
          const bytes = Buffer.alloc(33),
            count = readSync(fd, bytes, 0, 33, 0),
            text = bytes.subarray(0, count).toString("utf8");
          if (count !== stat.size || text !== `${child.pid}\n`) throw fail();
          const after = fstatSync(fd);
          if (
            after.ctimeMs !== stat.ctimeMs ||
            after.mtimeMs !== stat.mtimeMs ||
            after.size !== stat.size
          )
            throw fail();
          files.capture("sshd.pid", {
            dev: stat.dev,
            ino: stat.ino,
            hash: createHash("sha256").update(bytes.subarray(0, count)).digest("hex"),
          });
        } finally {
          closeSync(fd);
        }
        return { pid: child.pid, verified: true };
      },
      config: join(root, "client_config"),
      configProof,
      metrics: () => ({ ...metrics }),
      publicKey: readFileSync(join(root, "host.pub"), "utf8"),
      account,
      files,
      setMode(value) {
        if (!["normal", "delay", "stall", "oversize"].includes(value)) throw fail();
        mode = value;
      },
      disposeFiles,
    };
  } catch {
    failureStage = stage;
    throw fail();
  }
}

/** Fixed kernel witness decoder: a changed birth time changes authority, command titles do not. */
export function decodeMacProcessWitness(value, pid, uid = process.getuid()) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "microseconds,pid,seconds,uid" ||
    value.pid !== pid ||
    value.uid !== uid ||
    !Number.isSafeInteger(value.seconds) ||
    value.seconds <= 0 ||
    !Number.isSafeInteger(value.microseconds) ||
    value.microseconds < 0 ||
    value.microseconds >= 1000000
  )
    throw fail();
  return `darwin-kernel:${pid}:${uid}:${value.seconds}:${value.microseconds}`;
}
export class KernelWitnessReadError extends Error {
  constructor(status) {
    super("Owned kernel witness refused");
    this.status = [64, 65, 66].includes(status) ? status : null;
  }
}
/** One confirmation, inside the original read budget; only newly proven death permits omission. */
export async function confirmMacProcessExit(read, options = {}) {
  const now = options.now ?? Date.now,
    wait = options.wait ?? delay,
    deadline = now() + 1000;
  try {
    return await read(1000);
  } catch (error) {
    if (!(error instanceof KernelWitnessReadError) || error.status !== 65 || deadline - now() <= 25)
      throw error;
    await wait(25);
    if (deadline - now() <= 0) throw error;
    try {
      if ((await read(deadline - now())) === null) return null;
    } catch {
      /* Preserve the original refusal. */
    }
    throw error;
  }
}
/** Compiles only this fixed test helper; no production identity semantics are changed. */
export async function createMacProcessIdentity({ parent, onAllocated }) {
  if (process.platform !== "darwin" || process.getuid() === 0 || typeof onAllocated !== "function")
    throw fail();
  parent = fixturePath(realpathSync(fixturePath(parent)));
  const root = mkdtempSync(join(parent, "pid-"));
  chmodSync(root, 0o700);
  const files = privateFiles(root);
  let stage = "allocated",
    failureStage = null;
  onAllocated({
    root,
    disposeFiles: async () => files.clean(),
    diagnostics: () => ({ stage, failureStage }),
  });
  try {
    const source = readFileSync(fileURLToPath(new URL("./owned-ssh-process.c", import.meta.url)));
    if (source.length > 16384) throw fail();
    const path = join(root, "identity.c"),
      binary = join(root, "identity");
    writeFileSync(path, source, { flag: "wx", mode: 0o600 });
    files.capture("identity.c");
    stage = "compile-kernel-witness";
    await execute(
      "/usr/bin/clang",
      ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path, "-o", binary],
      {
        timeout: 15000,
        maxBuffer: 4096,
        env: { PATH: "/usr/bin:/bin", HOME: root, ZDOTDIR: root },
      },
    );
    chmodSync(binary, 0o700);
    files.capture("identity");
    const artifact = lstatSync(binary),
      artifactHash = hashPrivateFile(binary, artifact);
    stage = "ready";
    return {
      sourceHash: createHash("sha256").update(source).digest("hex"),
      artifactHash,
      artifactBytes: artifact.size,
      async identify(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 0) throw fail();
        return confirmMacProcessExit(async (timeout) => {
          if (hashPrivateFile(binary, artifact) !== artifactHash) throw fail();
          let stdout;
          try {
            ({ stdout } = await execute(binary, [String(pid)], {
              timeout,
              maxBuffer: 1024,
              env: { PATH: "/usr/bin:/bin", HOME: root, ZDOTDIR: root },
            }));
          } catch (error) {
            throw new KernelWitnessReadError(error.code);
          }
          return decodeMacProcessWitness(JSON.parse(stdout), pid);
        });
      },
    };
  } catch {
    failureStage = stage;
    throw fail();
  }
}

/** Bounded in-memory classifier. Never exposes raw remote text, paths or key material. */
export function sshDiagnosticSink(stream) {
  const categories = new Set();
  let tail = "",
    bytes = 0,
    truncated = false;
  const patterns = [
    ["bad-ownership", /bad ownership or modes/iu],
    ["permission-denied", /permission denied/iu],
    ["host-key-refused", /host key verification failed|remote host identification has changed/iu],
    ["connection-refused", /connection refused/iu],
    ["socket-path-too-long", /too long for unix domain socket|unix_listener[^\n]*too long/iu],
    ["forwarding-refused", /administratively prohibited|port forwarding failed/iu],
    [
      "session-helper-unavailable",
      /sshd-session[^\n]*(?:no such file|not found)|(?:exec|posix_spawn)[^\n]*sshd-session/iu,
    ],
    ["bad-option", /bad configuration option|unsupported option/iu],
    ["accepted-publickey", /accepted publickey/iu],
    ["authentication-refused", /authentication refused|not allowed because/iu],
  ];
  stream.on("data", (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const count = Math.min(buffer.length, 65536 - bytes);
    truncated ||= count < buffer.length;
    bytes += count;
    const value = tail + buffer.subarray(0, count).toString("utf8");
    for (const [category, pattern] of patterns) if (pattern.test(value)) categories.add(category);
    tail = count ? value.slice(-512) : "";
  });
  stream.resume();
  return () => ({ categories: [...categories].sort(), bytes, truncated });
}

/** Tracks actual producers separately from their bounded response promises. */
export function createFixtureHandshakeWork(getHandshake) {
  const producers = new Set();
  let closing = false;
  const run = () => {
    if (closing) throw fail();
    const producer = Promise.resolve().then(() => {
      if (closing) throw fail();
      return getHandshake();
    });
    producers.add(producer);
    // Observe either outcome without retaining credential-bearing results/errors.
    void producer.then(
      () => producers.delete(producer),
      () => producers.delete(producer),
    );
    return producer;
  };
  return {
    encode(mode = "normal", timeoutMs = 6000) {
      return encodeFixtureHandshake(run, mode, timeoutMs);
    },
    close() {
      closing = true;
    },
    async settle(timeoutMs = 7000) {
      closing = true;
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...producers]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(fail()), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Bounds response waiting only; callers own underlying producer settlement. */
export async function encodeFixtureHandshake(getHandshake, mode = "normal", timeoutMs = 6000) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(getHandshake),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail()), timeoutMs);
      }),
    ]);
    const encoded = mode === "oversize" ? "x".repeat(33000) : JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 65536) throw fail();
    return encoded;
  } finally {
    clearTimeout(timer);
  }
}
