import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection } from "node:net";

/** Bounded teardown of retained ChildProcess handles; never discovers or kills by PID. */
export async function settlePackedChildren(
  children,
  exits,
  { graceMs = 5000, killMs = 2000 } = {},
) {
  const closed = new Set();
  let observationFailed = false,
    signalFailed = false,
    termRequested = 0,
    killRequested = 0;
  const pending = children.map((child) =>
    Promise.resolve(exits.get(child)).then(
      () => {
        if (!exits.has(child)) observationFailed = true;
        else closed.add(child);
      },
      () => {
        observationFailed = true;
      },
    ),
  );
  const all = Promise.all(pending);
  const wait = async (ms) => {
    let timer;
    try {
      return await Promise.race([
        all.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const signal = (kind) => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        child.kill(kind);
        if (kind === "SIGTERM") termRequested++;
        else killRequested++;
      } catch {
        signalFailed = true;
      }
    }
  };
  signal("SIGTERM");
  const graceful = await wait(graceMs);
  if (!graceful) {
    signal("SIGKILL");
    await wait(killMs);
  }
  return {
    confirmed: closed.size === children.length && !observationFailed,
    graceful: graceful && !signalFailed && !observationFailed,
    children: children.length,
    closed: closed.size,
    termRequested,
    killRequested,
    observationFailed,
    signalFailed,
  };
}

/** A command failure is not evidence that the privately launched runtime exited. */
export function createInstalledRuntimeCleanup(downloadedTui, readyPath, dependencies = {}) {
  const inspect =
    dependencies.inspect ??
    ((args) =>
      spawnSync("ps", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      }));
  const kill = dependencies.kill ?? process.kill.bind(process);
  const pause = dependencies.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const dead = (pid) => {
    try {
      kill(pid, 0);
      return false;
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw new Error("Packed runtime liveness unverified", { cause: error });
    }
  };
  const identity = (pid) => {
    const observed = inspect(["-p", String(pid), "-o", "lstart=", "-o", "command="]);
    if (observed.error || observed.signal) throw new Error("Packed runtime identity read failed");
    if (observed.status !== 0 || !observed.stdout?.trim()) {
      if (dead(pid)) return null;
      throw new Error("Packed runtime identity unavailable while live");
    }
    const value = observed.stdout.trim();
    if (!value.includes(downloadedTui)) throw new Error("Packed runtime identity changed");
    return value;
  };
  const inventory = () => {
    const observed = inspect(["-axo", "pid=,command="]);
    if (
      observed.error ||
      observed.signal ||
      observed.status !== 0 ||
      typeof observed.stdout !== "string"
    )
      throw new Error("Packed runtime inventory failed");
    return observed.stdout
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
      .filter((match) => match?.[2]?.includes(downloadedTui))
      .map((match) => Number(match[1]))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  };
  const retire = async (pid) => {
    const original = identity(pid);
    if (original === null) return;
    const signal = (kind) => {
      const current = identity(pid);
      if (current === null) return false;
      if (current !== original) throw new Error("Packed runtime identity changed before signal");
      try {
        kill(pid, kind);
      } catch (error) {
        if (error?.code !== "ESRCH")
          throw new Error("Packed runtime signal refused", { cause: error });
      }
      return true;
    };
    const wait = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        await pause(25);
        const current = identity(pid);
        if (current === null) return true;
        if (current !== original) throw new Error("Packed runtime incarnation changed");
      }
      return false;
    };
    if (!signal("SIGTERM")) return;
    if (await wait()) return;
    if (!signal("SIGKILL")) return;
    if (!(await wait())) throw new Error("Packed runtime exit unconfirmed");
  };
  return async () => {
    const pids = new Set(inventory());
    if (readyPath && existsSync(readyPath)) {
      try {
        const readiness = JSON.parse(readFileSync(readyPath, "utf8"));
        if (
          readiness?.version === 1 &&
          readiness.phase === "input-ready" &&
          readiness.surface === "app" &&
          Number.isSafeInteger(readiness.pid) &&
          readiness.pid > 1
        )
          pids.add(readiness.pid);
      } catch {
        /* Partial readiness does not prevent exact-binary inventory cleanup. */
      }
    }
    const results = await Promise.allSettled([...pids].map(retire));
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Packed runtime retirement unconfirmed");
    if (inventory().length) throw new Error("Packed runtime inventory remains live");
  };
}

export async function waitForPackedSocketRemoval(
  path,
  { present = existsSync, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!present(path)) return true;
    await pause(25);
  }
  return !present(path);
}

const packedSocketStat = (stat) => ({
  dev: stat.dev,
  ino: stat.ino,
  uid: stat.uid,
  mode: stat.mode,
  birthtimeMs: stat.birthtimeMs,
});
const samePackedSocket = (a, b) =>
  ["dev", "ino", "uid", "mode", "birthtimeMs"].every((key) => a[key] === b[key]);
const absentPid = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
};
/** Capture only immediately after querying the server through its exact private socket. */
export function capturePackedTmuxWitness(
  path,
  pid,
  { stat = lstatSync, uid = process.getuid(), dead = absentPid } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || dead(pid))
    throw new Error("Packed tmux server witness unavailable");
  const parent = stat(dirname(path)),
    socket = stat(path);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o777) !== 0o700 ||
    !socket.isSocket() ||
    socket.uid !== uid
  )
    throw new Error("Packed tmux socket witness unsafe");
  return {
    path,
    pid,
    parent: { dev: parent.dev, ino: parent.ino, uid: parent.uid, mode: parent.mode },
    socket: packedSocketStat(socket),
  };
}
function packedSocketRefused(path) {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    const finish = (refused) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => finish(false), 500);
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
  });
}
/** tmux can leave a stale socket on clean exit. Never infer authority from refusal alone. */
export async function retirePackedTmuxSocket(
  witness,
  {
    stat = lstatSync,
    dead = absentPid,
    refused = packedSocketRefused,
    remove = unlinkSync,
    pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!witness) throw new Error("Packed tmux creation witness missing");
  const check = () => {
    const parent = stat(dirname(witness.path));
    if (
      !parent.isDirectory() ||
      !Object.keys(witness.parent).every((key) => parent[key] === witness.parent[key])
    )
      throw new Error("Packed tmux parent changed");
    let socket;
    try {
      socket = stat(witness.path);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (!socket.isSocket() || !samePackedSocket(socket, witness.socket))
      throw new Error("Packed tmux socket changed");
    return true;
  };
  let stopped = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (dead(witness.pid)) {
      stopped = true;
      break;
    }
    await pause(25);
  }
  if (!stopped) throw new Error("Packed tmux server exit unconfirmed");
  if (!check()) return { ownerDead: true, socketRemoved: true, staleSocketRemoved: false };
  if (!(await refused(witness.path))) throw new Error("Packed tmux socket is not refused");
  if (!dead(witness.pid)) throw new Error("Packed tmux PID reused during cleanup");
  if (!check()) throw new Error("Packed tmux socket changed during cleanup");
  remove(witness.path);
  return { ownerDead: true, socketRemoved: true, staleSocketRemoved: true };
}
