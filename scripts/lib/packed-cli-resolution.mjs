import assert from "node:assert/strict";
import { lstatSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { spawnSync } from "node:child_process";

export function privateRootWitness(path, stat = lstatSync) {
  const s = stat(path);
  assert(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & 0o777) === 0o700,
    "Unsafe private root",
  );
  return { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
}
const dead = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
};
/** Receipt data cannot grant executable, path, or PID signalling authority. */
export async function retirePackedCliResolution(expected, receipt, dependencies = {}) {
  const stat = dependencies.stat ?? lstatSync;
  const isDead = dependencies.dead ?? dead;
  const pause = dependencies.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec =
    dependencies.exec ??
    ((args) =>
      spawnSync(expected.binary, args, {
        env: { PATH: "/usr/bin:/bin", HOME: expected.root, TMUX: "" },
        encoding: "utf8",
        timeout: 5000,
      }));
  const checkRoot = () =>
    assert.deepEqual(
      privateRootWitness(expected.root, stat),
      expected.rootWitness,
      "Private root changed",
    );
  checkRoot();
  assert.equal(receipt?.version, 1);
  assert.equal(receipt.cli?.realpath, expected.cli);
  assert.equal(receipt.cli?.sha256, expected.cliHash);
  assert.equal(receipt.native?.realpath, expected.binary);
  assert.equal(receipt.native?.sha256, expected.binaryHash);
  assert.equal(dirname(receipt.directory), expected.root);
  assert(
    /^tmux-cli-resolution-[A-Za-z0-9]+$/.test(basename(receipt.directory)),
    "Unexpected fixture directory",
  );
  assert.equal(receipt.socket, join(receipt.directory, "owned.sock"));
  try {
    privateRootWitness(receipt.directory, stat);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const o = receipt.ownership;
  assert(
    o &&
      /^[1-9]\d*$/.test(o.serverPid) &&
      /^[1-9]\d*$/.test(o.serverStart) &&
      /^[1-9]\d*$/.test(o.panePid),
    "Missing creation identity",
  );
  assert(/^\$\d+$/.test(o.sessionId) && /^%\d+$/.test(o.paneId), "Invalid pane identity");
  assert.equal(
    o.identity,
    [o.serverPid, o.serverStart, o.sessionId, o.paneId, o.panePid].join("|"),
  );
  const pids = [Number(o.serverPid), Number(o.panePid)];
  assert(
    pids.every((pid) => Number.isSafeInteger(pid) && pid > 1),
    "Invalid PID",
  );
  if (!pids.every(isDead)) {
    checkRoot();
    const guard = `#{&&:#{==:#{pid},${o.serverPid}},#{==:#{start_time},${o.serverStart}}}`;
    const stopped = exec([
      "-S",
      receipt.socket,
      "if-shell",
      "-F",
      guard,
      "kill-server",
      "display-message -p identity-mismatch",
    ]);
    assert(
      !stopped.error && !stopped.signal && stopped.stdout.trim() === "",
      "Guarded retirement refused",
    );
  }
  let absent = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (pids.every(isDead)) {
      absent = true;
      break;
    }
    await pause(25);
  }
  assert(absent, "Owned processes still live or reused");
  const socket = exec(["-S", receipt.socket, "has-session"]);
  assert(!socket.error && !socket.signal && socket.status === 1, "Socket absence unconfirmed");
  checkRoot();
  return { confirmed: true, serverAbsent: true, paneAbsent: true, socketAbsentStatus: 1 };
}
export function readBoundedCliResolutionReceipt(path) {
  const bytes = readFileSync(path);
  assert(bytes.length <= 64 * 1024, "Oversized ownership receipt");
  return JSON.parse(bytes.toString("utf8"));
}
export function packedExecutableIdentity(path) {
  const realpath = realpathSync(path);
  return { realpath, sha256: createHash("sha256").update(readFileSync(realpath)).digest("hex") };
}

/** Explicit contributor fallback cannot silently weaken bundled release coverage. */
export function packedNativeMode(value) {
  if (value === undefined) return "bundled";
  assert(value === "bundled" || value === "system-fallback", "Invalid packed native mode");
  return value;
}
export function packedNativeIdentity(mode, bundledPath, systemPath) {
  assert(mode === "bundled" || mode === "system-fallback", "Invalid packed native mode");
  if (mode === "bundled") return packedExecutableIdentity(bundledPath);
  assert(!existsSync(bundledPath), "System-fallback lane must not contain a bundled native binary");
  assert(
    typeof systemPath === "string" && systemPath.startsWith("/"),
    "System tmux must be absolute",
  );
  return packedExecutableIdentity(systemPath);
}
