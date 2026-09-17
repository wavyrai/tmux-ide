import { ensureCanonicalDaemon } from "./canonical-daemon-bootstrap.ts";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reserveCanonicalDaemonSupervision,
  releaseCanonicalDaemonSupervision,
  tryAcquireCanonicalDaemonClaim,
  releaseCanonicalDaemonClaim,
  writeCanonicalDaemonInfo,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonRecordOwnerProvenDead,
  getCanonicalDaemonInfoPath,
  clearCanonicalDaemonInfoIfOwned,
  clearCanonicalDaemonInfoIfUnchanged,
  canonicalDaemonClaimAllowsStartupAttempt,
  type CanonicalDaemonClaim,
  type CanonicalDaemonInfo,
} from "./canonical-daemon.ts";
let root: string, previous: string | undefined;
const claims: CanonicalDaemonClaim[] = [];
const dead = 2147483647;
beforeEach(() => {
  previous = process.env.TMUX_IDE_DAEMON_INFO_DIR;
  root = mkdtempSync(join(tmpdir(), "canonical-supervision-"));
  process.env.TMUX_IDE_DAEMON_INFO_DIR = root;
});
afterEach(() => {
  for (const claim of claims.splice(0)) releaseCanonicalDaemonClaim(claim);
  if (previous === undefined) delete process.env.TMUX_IDE_DAEMON_INFO_DIR;
  else process.env.TMUX_IDE_DAEMON_INFO_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const bytes = () => readFileSync(getCanonicalDaemonInfoPath(), "utf8");
function acquire(supervisionId?: string) {
  const attempt = tryAcquireCanonicalDaemonClaim(
    supervisionId ? { kind: "supervised", supervisionId } : undefined,
  );
  expect(attempt.status).toBe("acquired");
  if (attempt.status !== "acquired") throw Error("claim refused");
  claims.push(attempt.claim);
  return attempt.claim;
}
function info(supervisionId?: string, pid = dead): CanonicalDaemonInfo {
  return {
    pid,
    port: 31000,
    protocolVersion: 1,
    productVersion: "test",
    instanceId: "11111111-1111-4111-8111-111111111111",
    startedAt: new Date().toISOString(),
    bindHostname: "127.0.0.1",
    authToken: "private",
    ...(supervisionId ? { supervisionId } : {}),
  };
}
it("explicit reserve persists across failed startup and ordinary or mismatched claims refuse", () => {
  const reservation = reserveCanonicalDaemonSupervision("fixture.service");
  const before = bytes();
  expect(inspectCanonicalDaemonInfo().status).toBe("reserved");
  expect(canonicalDaemonClaimAllowsStartupAttempt()).toBe(false);
  expect(tryAcquireCanonicalDaemonClaim().status).toBe("invalid");
  expect(
    tryAcquireCanonicalDaemonClaim({ kind: "supervised", supervisionId: "other" }).status,
  ).toBe("invalid");
  const claim = acquire("fixture.service");
  expect(clearCanonicalDaemonInfoIfUnchanged(inspectCanonicalDaemonInfo(), claim)).toBe(false);
  releaseCanonicalDaemonClaim(claim);
  expect(bytes()).toBe(before);
  expect(reserveCanonicalDaemonSupervision("fixture.service")).toEqual(reservation);
  expect(() => reserveCanonicalDaemonSupervision("other")).toThrow();
});
it("supervised startup never creates a missing reservation", () => {
  expect(
    tryAcquireCanonicalDaemonClaim({ kind: "supervised", supervisionId: "fixture" }).status,
  ).toBe("invalid");
  expect(inspectCanonicalDaemonInfo().status).toBe("missing");
});
it("reservation installer cannot overtake a held startup claim", () => {
  const claim = acquire();
  expect(() => reserveCanonicalDaemonSupervision("fixture")).toThrow();
  expect(inspectCanonicalDaemonInfo().status).toBe("missing");
  releaseCanonicalDaemonClaim(claim);
  reserveCanonicalDaemonSupervision("fixture");
});
it("matching publication replaces reservation atomically and shutdown retains the ready record", () => {
  reserveCanonicalDaemonSupervision("fixture");
  const claim = acquire("fixture");
  writeCanonicalDaemonInfo(info("fixture"), claim);
  const before = bytes();
  expect(inspectCanonicalDaemonInfo().status).toBe("valid");
  expect(clearCanonicalDaemonInfoIfOwned(info().instanceId, claim)).toBe(false);
  expect(clearCanonicalDaemonInfoIfUnchanged(inspectCanonicalDaemonInfo(), claim)).toBe(false);
  releaseCanonicalDaemonClaim(claim);
  expect(bytes()).toBe(before);
  expect(tryAcquireCanonicalDaemonClaim().status).toBe("invalid");
  const replacement = acquire("fixture");
  writeCanonicalDaemonInfo(
    { ...info("fixture"), instanceId: "22222222-2222-4222-8222-222222222222" },
    replacement,
  );
  expect(bytes()).not.toBe(before);
});
it("publication revalidates intent even when caller observed missing before another reservation appeared", () => {
  const claim = acquire();
  writeFileSync(
    getCanonicalDaemonInfoPath(),
    JSON.stringify({
      kind: "supervised-reservation",
      version: 1,
      supervisionId: "fixture",
      reservationId: "11111111-1111-4111-8111-111111111111",
      reservedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const before = bytes();
  expect(() => writeCanonicalDaemonInfo(info(), claim)).toThrow();
  expect(bytes()).toBe(before);
});
it("matching reservation cannot publish ordinary or differently-bound metadata", () => {
  reserveCanonicalDaemonSupervision("fixture");
  const claim = acquire("fixture");
  const before = bytes();
  for (const candidate of [info(), info("other")])
    expect(() => writeCanonicalDaemonInfo(candidate, claim)).toThrow();
  expect(bytes()).toBe(before);
});
it("explicit migration accepts valid proven-dead ordinary record and refuses live owner", () => {
  const claim = acquire();
  writeCanonicalDaemonInfo(info(undefined, process.pid), claim);
  releaseCanonicalDaemonClaim(claim);
  const before = bytes();
  expect(() => reserveCanonicalDaemonSupervision("fixture")).toThrow();
  expect(bytes()).toBe(before);
  writeFileSync(getCanonicalDaemonInfoPath(), JSON.stringify(info()), { mode: 0o600 });
  expect(reserveCanonicalDaemonSupervision("fixture").supervisionId).toBe("fixture");
});
it("release requires exact binding and no held claim, then restores ordinary startup", () => {
  reserveCanonicalDaemonSupervision("fixture");
  const claim = acquire("fixture");
  expect(() => releaseCanonicalDaemonSupervision("fixture")).toThrow();
  releaseCanonicalDaemonClaim(claim);
  expect(() => releaseCanonicalDaemonSupervision("other")).toThrow();
  releaseCanonicalDaemonSupervision("fixture");
  expect(inspectCanonicalDaemonInfo().status).toBe("missing");
  acquire();
});
it("release refuses live and uncertain recorded owners without changing bytes", () => {
  reserveCanonicalDaemonSupervision("fixture");
  const claim = acquire("fixture");
  writeCanonicalDaemonInfo(info("fixture", process.pid), claim);
  releaseCanonicalDaemonClaim(claim);
  const before = bytes();
  expect(() => releaseCanonicalDaemonSupervision("fixture")).toThrow();
  expect(bytes()).toBe(before);
  const kill = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("unknown"), { code: "EIO" });
  });
  try {
    expect(() => releaseCanonicalDaemonSupervision("fixture")).toThrow();
    expect(bytes()).toBe(before);
  } finally {
    kill.mockRestore();
  }
});
it("dead retained ready record can be released only explicitly", () => {
  reserveCanonicalDaemonSupervision("fixture");
  const claim = acquire("fixture");
  writeCanonicalDaemonInfo(info("fixture"), claim);
  releaseCanonicalDaemonClaim(claim);
  releaseCanonicalDaemonSupervision("fixture");
  expect(inspectCanonicalDaemonInfo().status).toBe("missing");
});
it("malformed and symlink reservations refuse installation and release", () => {
  writeFileSync(
    getCanonicalDaemonInfoPath(),
    JSON.stringify({ kind: "supervised-reservation", supervisionId: "fixture", pid: dead }),
    { mode: 0o600 },
  );
  const before = bytes();
  expect(() => reserveCanonicalDaemonSupervision("fixture")).toThrow();
  expect(() => releaseCanonicalDaemonSupervision("fixture")).toThrow();
  expect(bytes()).toBe(before);
  rmSync(getCanonicalDaemonInfoPath());
  writeFileSync(join(root, "target"), before, { mode: 0o600 });
  symlinkSync(join(root, "target"), getCanonicalDaemonInfoPath());
  expect(() => reserveCanonicalDaemonSupervision("fixture")).toThrow();
  expect(() => releaseCanonicalDaemonSupervision("fixture")).toThrow();
  expect(readFileSync(join(root, "target"), "utf8")).toBe(before);
});

it("actual ordinary bootstrap refuses malformed supervision even with a dead-looking PID", async () => {
  for (const record of [
    { kind: "supervised-reservation", supervisionId: "fixture", pid: dead },
    { ...info(), supervisionId: "invalid/binding" },
  ]) {
    writeFileSync(getCanonicalDaemonInfoPath(), JSON.stringify(record), { mode: 0o600 });
    const before = bytes();
    let spawned = 0;
    await expect(
      ensureCanonicalDaemon(
        { entryPath: join(root, "never-launched.js") },
        {
          inspect: inspectCanonicalDaemonInfo,
          ownerProvenDead: isCanonicalDaemonRecordOwnerProvenDead,
          spawnOwner: async () => {
            spawned++;
          },
        },
      ),
    ).rejects.toThrow();
    expect(spawned).toBe(0);
    const claim = acquire();
    const state = inspectCanonicalDaemonInfo();
    expect(state.status).toBe("invalid");
    if (state.status === "missing") throw Error("record disappeared");
    const mayClear = await isCanonicalDaemonRecordOwnerProvenDead(state);
    expect(mayClear).toBe(false);
    if (mayClear) clearCanonicalDaemonInfoIfUnchanged(state, claim);
    expect(() => writeCanonicalDaemonInfo(info(), claim)).toThrow();
    expect(bytes()).toBe(before);
    releaseCanonicalDaemonClaim(claim);
  }
});
