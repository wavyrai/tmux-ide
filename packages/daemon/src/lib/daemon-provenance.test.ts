import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDaemonProvenanceReport,
  captureDaemonProvenance,
  classifySupervisor,
  collectDaemonProvenanceReport,
  describeLogDestination,
  describeStream,
  discoverLogFiles,
  extractLogIdentity,
  formatDaemonProvenanceReport,
  type LogFileObservation,
  type PidLiveness,
  type StreamStat,
} from "./daemon-provenance.ts";
import {
  getCanonicalDaemonInfoPath,
  releaseCanonicalDaemonClaim,
  tryAcquireCanonicalDaemonClaim,
  writeCanonicalDaemonInfo,
  type CanonicalDaemonClaim,
  type CanonicalDaemonInfo,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";

const DEAD_PID = 2147483647;
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const TOKEN = "super-secret-auth-token-value";

const fileStat = (dev: number, ino: number): StreamStat => ({
  isFile: true,
  isFIFO: false,
  isSocket: false,
  isCharacterDevice: false,
  dev,
  ino,
});
const kindStat = (kind: "fifo" | "socket" | "chr"): StreamStat => ({
  isFile: false,
  isFIFO: kind === "fifo",
  isSocket: kind === "socket",
  isCharacterDevice: kind === "chr",
  dev: 1,
  ino: 2,
});

describe("classifySupervisor", () => {
  const base = {
    launcher: "headless" as const,
    platform: "linux" as const,
    env: {},
    parentPid: 4242,
  };

  it("prefers environment evidence: systemd markers", () => {
    expect(classifySupervisor({ ...base, env: { INVOCATION_ID: "abc" } })).toMatchObject({
      kind: "systemd",
    });
    expect(
      classifySupervisor({ ...base, env: { JOURNAL_STREAM: "9:1234" }, supervisionId: "x" }),
    ).toMatchObject({ kind: "systemd" });
  });

  it("recognizes launchd via XPC_SERVICE_NAME and parent pid 1 with a reservation", () => {
    expect(
      classifySupervisor({
        ...base,
        platform: "darwin",
        env: { XPC_SERVICE_NAME: "ai.tmux-ide.daemon" },
      }),
    ).toMatchObject({ kind: "launchd" });
    expect(
      classifySupervisor({
        ...base,
        platform: "darwin",
        env: { XPC_SERVICE_NAME: "0" },
        parentPid: 1,
        supervisionId: "svc",
      }),
    ).toMatchObject({ kind: "launchd" });
    expect(
      classifySupervisor({ ...base, platform: "darwin", env: { XPC_SERVICE_NAME: "0" } }),
    ).toMatchObject({
      kind: "manual",
    });
  });

  it("falls back to the reservation hint, then manual", () => {
    expect(classifySupervisor({ ...base, supervisionId: "tmux-ide.service" })).toMatchObject({
      kind: "systemd",
    });
    expect(
      classifySupervisor({ ...base, platform: "darwin", supervisionId: "com.example.daemon" }),
    ).toMatchObject({
      kind: "launchd",
    });
    expect(classifySupervisor(base)).toEqual({
      kind: "manual",
      evidence: "foreground or detached shell",
    });
    expect(classifySupervisor({ ...base, parentPid: 1 })).toMatchObject({ kind: "manual" });
  });

  it("reports embedded hosts regardless of environment", () => {
    expect(
      classifySupervisor({ ...base, launcher: "embedded", env: { INVOCATION_ID: "x" } }),
    ).toMatchObject({
      kind: "embedded",
    });
  });
});

describe("describeStream", () => {
  it("maps stat shapes to stream kinds", () => {
    expect(describeStream(fileStat(7, 9), "/var/log/d.out", false)).toEqual({
      kind: "file",
      path: "/var/log/d.out",
      dev: 7,
      ino: 9,
    });
    expect(describeStream(fileStat(7, 9), undefined, false)).toEqual({
      kind: "file",
      dev: 7,
      ino: 9,
    });
    expect(describeStream(kindStat("fifo"), undefined, false)).toEqual({ kind: "pipe" });
    expect(describeStream(kindStat("socket"), undefined, false)).toEqual({ kind: "socket" });
    expect(describeStream(kindStat("chr"), undefined, true)).toEqual({ kind: "tty" });
    expect(describeStream(null, undefined, false)).toEqual({
      kind: "unknown",
      detail: "fstat failed",
    });
  });
});

describe("captureDaemonProvenance", () => {
  it("records the actual file destination with identity and no credentials", () => {
    const provenance = captureDaemonProvenance({
      launcher: "headless",
      supervisionId: "tmux-ide.service",
      env: { INVOCATION_ID: "x" },
      platform: "linux",
      parentPid: 1,
      pid: 123,
      fstat: (fd) => fileStat(10, 100 + fd),
      isTTY: () => false,
      fdPath: (fd) => `/var/lib/tmux-ide/fd${fd}.log`,
    });
    expect(provenance).toEqual({
      launcher: "headless",
      supervisor: "systemd",
      parentPid: 1,
      stdout: { kind: "file", path: "/var/lib/tmux-ide/fd1.log", dev: 10, ino: 101 },
      stderr: { kind: "file", path: "/var/lib/tmux-ide/fd2.log", dev: 10, ino: 102 },
    });
  });

  it("identifies /dev/null by inode without a path lookup", () => {
    let lookups = 0;
    const provenance = captureDaemonProvenance({
      launcher: "headless",
      env: {},
      platform: "darwin",
      parentPid: 5,
      fstat: () => ({ ...kindStat("chr"), dev: 3, ino: 4 }),
      isTTY: () => false,
      nullDevice: () => ({ dev: 3, ino: 4 }),
      fdPath: () => {
        lookups++;
        return "/never";
      },
    });
    expect(lookups).toBe(0);
    expect(provenance.stdout).toEqual({ kind: "null", path: "/dev/null" });
    expect(provenance.supervisor).toBe("manual");
  });

  it("degrades to unknown with warnings instead of throwing", () => {
    const provenance = captureDaemonProvenance({
      launcher: "embedded",
      env: {},
      platform: "linux",
      parentPid: 5,
      fstat: (fd) => {
        if (fd === 1) throw new Error("EBADF token=leaky");
        return fileStat(1, 1);
      },
      isTTY: () => false,
      fdPath: () => {
        throw new Error("lsof missing");
      },
    });
    expect(provenance.stdout).toEqual({ kind: "unknown", detail: "fstat failed" });
    expect(provenance.stderr).toEqual({ kind: "file", dev: 1, ino: 1 });
    expect(provenance.warnings).toEqual([
      "stdout: fstat failed (EBADF token=[redacted])",
      "stderr: path resolution failed (lsof missing)",
      "stderr: regular file but its path could not be resolved",
    ]);
  });

  it("runs against the real process streams without throwing", () => {
    const provenance = captureDaemonProvenance({ launcher: "embedded" });
    expect(["file", "tty", "pipe", "socket", "null", "unknown"]).toContain(provenance.stdout.kind);
    expect(provenance.parentPid).toBe(process.ppid);
  });
});

describe("extractLogIdentity", () => {
  it("returns the last pid, instance and version markers in a window", () => {
    const text = [
      "Canonical daemon ready: http://127.0.0.1:4010 (pid 111)",
      '{"ts":"t","level":"info","msg":"x","pid":111,"instanceId":"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA","version":"1.0.0"}',
      "Canonical daemon ready: http://127.0.0.1:4010 (pid 222)",
      '{"ts":"t","level":"info","msg":"y","pid":222,"instanceId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","version":"1.0.1"}',
    ].join("\n");
    expect(extractLogIdentity(text)).toEqual({
      pid: 222,
      instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      productVersion: "1.0.1",
    });
    expect(extractLogIdentity("nothing here")).toEqual({});
  });
});

function validState(info: Partial<CanonicalDaemonInfo> = {}): CanonicalDaemonInfoState {
  return {
    status: "valid",
    info: {
      pid: 4242,
      port: 4010,
      protocolVersion: 2,
      productVersion: "2.9.0-beta.19",
      instanceId: INSTANCE,
      startedAt: "2026-09-20T10:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: TOKEN,
      provenance: {
        launcher: "headless",
        supervisor: "systemd",
        parentPid: 1,
        stdout: { kind: "socket" },
        stderr: { kind: "socket" },
      },
      ...info,
    },
    observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
  };
}

const namespace = {
  mode: "test",
  stateHome: "/tmp/state",
  daemonInfoDir: "/tmp/state",
  logsDir: "/tmp/state/logs",
  recordPath: "/tmp/state/daemon.json",
};

const file = (over: Partial<LogFileObservation>): LogFileObservation => ({
  path: "/tmp/state/logs/x.log",
  bytes: 10,
  lastWriteAt: "2026-09-19T00:00:00.000Z",
  dev: 1,
  ino: 1,
  ...over,
});

const alive = (pid: number): PidLiveness => (pid === 4242 ? "alive" : "dead");
const now = () => new Date("2026-09-21T00:00:00.000Z");

describe("buildDaemonProvenanceReport", () => {
  it("reports a live systemd daemon and labels a stale headless.out as historical", () => {
    const report = buildDaemonProvenanceReport({
      namespace,
      recordState: validState(),
      files: [
        file({
          path: "/tmp/state/headless.out",
          pid: DEAD_PID,
          lastWriteAt: "2026-09-18T00:00:00.000Z",
          productVersion: "2.9.0-beta.18",
        }),
      ],
      pidLiveness: alive,
      now,
    });
    expect(report.status).toBe("running");
    expect(report.daemon).toMatchObject({
      instanceId: INSTANCE,
      productVersion: "2.9.0-beta.19",
      pid: 4242,
      liveness: "alive",
      supervisor: "systemd",
      launcher: "headless",
      parentPid: 1,
      provenanceRecorded: true,
      logDestination: "systemd journal (socket; use journalctl)",
    });
    expect(report.logFiles).toHaveLength(1);
    expect(report.logFiles[0]).toMatchObject({
      path: "/tmp/state/headless.out",
      status: "historical",
      pid: DEAD_PID,
      pidLiveness: "dead",
      productVersion: "2.9.0-beta.18",
      lastWriteAt: "2026-09-18T00:00:00.000Z",
    });
    expect(report.logFiles[0]!.reason).toContain(`pid ${DEAD_PID}`);
    expect(report.logFiles[0]!.reason).toContain("no longer running");
  });

  it("never carries the auth token in the report or its human rendering", () => {
    const report = buildDaemonProvenanceReport({
      namespace,
      recordState: validState(),
      files: [file({ path: "/tmp/state/headless.out", pid: DEAD_PID })],
      pidLiveness: alive,
      now,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toMatch(/authToken/u);
    expect(formatDaemonProvenanceReport(report).join("\n")).not.toContain(TOKEN);
  });

  it("marks the live file destination current by dev/ino and other files by comparison", () => {
    const report = buildDaemonProvenanceReport({
      namespace,
      recordState: validState({
        provenance: {
          launcher: "headless",
          supervisor: "launchd",
          parentPid: 1,
          stdout: { kind: "file", path: "/tmp/state/logs/daemon.out", dev: 5, ino: 55 },
          stderr: { kind: "file", path: "/tmp/state/logs/daemon.err", dev: 5, ino: 56 },
        },
      }),
      files: [
        file({
          path: "/tmp/state/logs/daemon.out",
          dev: 5,
          ino: 55,
          pid: 4242,
          lastWriteAt: "2026-09-21T00:00:00.000Z",
        }),
        file({
          path: "/tmp/state/logs/daemon.err",
          dev: 5,
          ino: 56,
          lastWriteAt: "2026-09-21T00:00:00.000Z",
        }),
        file({
          path: "/tmp/state/logs/rotated.out",
          dev: 5,
          ino: 57,
          pid: 4242,
          lastWriteAt: "2026-09-19T00:00:00.000Z",
        }),
        file({
          path: "/tmp/state/logs/old.log",
          dev: 5,
          ino: 58,
          lastWriteAt: "2026-09-01T00:00:00.000Z",
        }),
        file({
          path: "/tmp/state/logs/new.log",
          dev: 5,
          ino: 59,
          lastWriteAt: "2026-09-21T00:00:00.000Z",
        }),
        file({
          path: "/tmp/state/logs/other.log",
          dev: 5,
          ino: 60,
          pid: 999,
          lastWriteAt: "2026-09-21T00:00:00.000Z",
        }),
      ],
      pidLiveness: alive,
      now,
    });
    const byPath = Object.fromEntries(report.logFiles.map((f) => [f.path, f]));
    expect(byPath["/tmp/state/logs/daemon.out"]!.status).toBe("current");
    expect(byPath["/tmp/state/logs/daemon.err"]!.status).toBe("current");
    expect(byPath["/tmp/state/logs/rotated.out"]).toMatchObject({ status: "historical" });
    expect(byPath["/tmp/state/logs/rotated.out"]!.reason).toContain("not its live log destination");
    expect(byPath["/tmp/state/logs/old.log"]).toMatchObject({ status: "historical" });
    expect(byPath["/tmp/state/logs/new.log"]).toMatchObject({ status: "unattributed" });
    expect(byPath["/tmp/state/logs/other.log"]).toMatchObject({
      status: "historical",
      pidLiveness: "dead",
    });
    expect(report.daemon!.logDestination).toBe("file /tmp/state/logs/daemon.out");
    // newest first
    expect(report.logFiles[0]!.lastWriteAt).toBe("2026-09-21T00:00:00.000Z");
  });

  it("flags a stale record whose pid is dead", () => {
    const report = buildDaemonProvenanceReport({
      namespace,
      recordState: validState({ pid: DEAD_PID }),
      files: [file({ path: "/tmp/state/headless.out", pid: DEAD_PID })],
      pidLiveness: () => "dead",
      now,
    });
    expect(report.status).toBe("stale-record");
    expect(report.daemon!.liveness).toBe("dead");
    expect(report.warnings.some((w) => w.includes("stale record"))).toBe(true);
    expect(report.logFiles[0]!.status).toBe("historical");
    expect(formatDaemonProvenanceReport(report)[0]).toContain("not running (stale record");
  });

  it("explains a record that predates provenance stamping", () => {
    const report = buildDaemonProvenanceReport({
      namespace,
      recordState: validState({ provenance: undefined }),
      files: [],
      pidLiveness: alive,
      now,
    });
    expect(report.daemon).toMatchObject({
      provenanceRecorded: false,
      supervisor: null,
      launcher: null,
      logs: { stdout: null, stderr: null },
    });
    expect(report.daemon!.logDestination).toContain("predates provenance");
    expect(report.warnings[0]).toContain("predates provenance stamping");
  });

  it("handles missing, reserved and invalid records", () => {
    expect(
      buildDaemonProvenanceReport({
        namespace,
        recordState: { status: "missing" },
        files: [],
        pidLiveness: alive,
        now,
      }),
    ).toMatchObject({ status: "not-running", record: { status: "missing" }, daemon: null });
    const reserved = buildDaemonProvenanceReport({
      namespace,
      recordState: {
        status: "reserved",
        reservation: {
          kind: "supervised-reservation",
          version: 1,
          supervisionId: "tmux-ide.service",
          reservationId: INSTANCE,
          reservedAt: "2026-09-20T00:00:00.000Z",
        },
        observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
        reason: "supervised-reservation",
        detail: "reserved",
        ownerPid: null,
      },
      files: [],
      pidLiveness: alive,
      now,
    });
    expect(reserved).toMatchObject({
      status: "not-running",
      record: { status: "reserved", supervisionId: "tmux-ide.service" },
    });
    expect(formatDaemonProvenanceReport(reserved)[0]).toContain(
      "reserved for supervisor tmux-ide.service",
    );
    const invalid = buildDaemonProvenanceReport({
      namespace,
      recordState: {
        status: "invalid",
        reason: "unsafe-permissions",
        detail: `mode 0644 token=${TOKEN}`,
        ownerPid: null,
        observation: null,
      },
      files: [],
      pidLiveness: alive,
      now,
    });
    expect(invalid).toMatchObject({
      status: "record-invalid",
      record: { status: "invalid", reason: "unsafe-permissions" },
    });
    expect(JSON.stringify(invalid)).not.toContain(TOKEN);
  });

  it("renders a readable summary", () => {
    const lines = formatDaemonProvenanceReport(
      buildDaemonProvenanceReport({
        namespace,
        recordState: validState(),
        files: [file({ path: "/tmp/state/headless.out", pid: DEAD_PID })],
        pidLiveness: alive,
        now,
      }),
    );
    expect(lines[0]).toBe("Canonical daemon: running (pid 4242, v2.9.0-beta.19)");
    expect(lines).toContain(`  instance: ${INSTANCE}`);
    expect(lines.some((l) => l.includes("supervisor: systemd"))).toBe(true);
    expect(lines.some((l) => l.includes("logs: stdout → systemd journal"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  [historical] /tmp/state/headless.out"))).toBe(true);
  });
});

describe("discovery + collection (temp state home)", () => {
  let root: string;
  let previous: Record<string, string | undefined>;
  const claims: CanonicalDaemonClaim[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmux-ide-provenance-"));
    previous = {
      TMUX_IDE_HOME: process.env.TMUX_IDE_HOME,
      TMUX_IDE_DAEMON_INFO_DIR: process.env.TMUX_IDE_DAEMON_INFO_DIR,
      TMUX_IDE_REGISTRY_DIR: process.env.TMUX_IDE_REGISTRY_DIR,
    };
    process.env.TMUX_IDE_HOME = root;
    process.env.TMUX_IDE_DAEMON_INFO_DIR = root;
    process.env.TMUX_IDE_REGISTRY_DIR = root;
    mkdirSync(join(root, "logs"), { recursive: true });
  });

  afterEach(() => {
    for (const claim of claims.splice(0)) releaseCanonicalDaemonClaim(claim);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("discovers log-like files read-only and degrades unreadable ones to readError", () => {
    writeFileSync(
      join(root, "headless.out"),
      `Canonical daemon ready: http://127.0.0.1:1 (pid ${DEAD_PID})\n`,
    );
    writeFileSync(
      join(root, "logs", "daemon.log"),
      '{"pid":4242,"instanceId":"' + INSTANCE + '"}\n',
    );
    writeFileSync(join(root, "logs", "notes.txt"), "ignored\n");
    writeFileSync(join(root, "logs", "locked.log"), "secret\n");
    chmodSync(join(root, "logs", "locked.log"), 0o000);
    const { files, warnings } = discoverLogFiles({
      directories: [root, join(root, "logs"), join(root, "absent")],
    });
    const byName = Object.fromEntries(files.map((f) => [f.path.slice(root.length + 1), f]));
    expect(Object.keys(byName).sort()).toEqual([
      "headless.out",
      "logs/daemon.log",
      "logs/locked.log",
    ]);
    expect(byName["headless.out"]).toMatchObject({ pid: DEAD_PID });
    expect(byName["logs/daemon.log"]).toMatchObject({ pid: 4242, instanceId: INSTANCE });
    if (process.getuid?.() !== 0) {
      expect(byName["logs/locked.log"]!.readError).toBeTruthy();
      expect(byName["logs/locked.log"]!.pid).toBeUndefined();
    }
    expect(warnings).toEqual([]);
    chmodSync(join(root, "logs", "locked.log"), 0o600);
  });

  it("derives provenance from a real record: live file is current, planted stale file is historical", () => {
    const livePath = join(root, "logs", "daemon.out");
    writeFileSync(livePath, `Canonical daemon ready: http://127.0.0.1:1 (pid ${process.pid})\n`);
    const stalePath = join(root, "headless.out");
    writeFileSync(stalePath, `Canonical daemon ready: http://127.0.0.1:1 (pid ${DEAD_PID})\n`);
    const liveStat = statSync(livePath);
    const attempt = tryAcquireCanonicalDaemonClaim();
    expect(attempt.status).toBe("acquired");
    if (attempt.status !== "acquired") return;
    claims.push(attempt.claim);
    writeCanonicalDaemonInfo(
      {
        pid: process.pid,
        port: 31001,
        protocolVersion: 2,
        productVersion: "2.9.0-beta.19",
        instanceId: INSTANCE,
        startedAt: new Date().toISOString(),
        bindHostname: "127.0.0.1",
        authToken: TOKEN,
        provenance: {
          launcher: "headless",
          supervisor: "manual",
          parentPid: process.ppid,
          stdout: {
            kind: "file",
            path: livePath,
            dev: Number(liveStat.dev),
            ino: Number(liveStat.ino),
          },
          stderr: {
            kind: "file",
            path: livePath,
            dev: Number(liveStat.dev),
            ino: Number(liveStat.ino),
          },
        },
      },
      attempt.claim,
    );
    const report = collectDaemonProvenanceReport();
    expect(report.namespace.recordPath).toBe(getCanonicalDaemonInfoPath());
    expect(report.status).toBe("running");
    expect(report.daemon).toMatchObject({
      pid: process.pid,
      instanceId: INSTANCE,
      supervisor: "manual",
      launcher: "headless",
      logDestination: `file ${livePath}`,
    });
    const byPath = Object.fromEntries(report.logFiles.map((f) => [f.path, f]));
    expect(byPath[livePath]).toMatchObject({ status: "current", pid: process.pid });
    expect(byPath[stalePath]).toMatchObject({
      status: "historical",
      pid: DEAD_PID,
      pidLiveness: "dead",
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain("authToken");
  });

  it("reports a missing record as not running", () => {
    const report = collectDaemonProvenanceReport();
    expect(report).toMatchObject({
      status: "not-running",
      record: { status: "missing" },
      daemon: null,
    });
  });
});

describe("describeLogDestination", () => {
  it("labels each stream kind", () => {
    expect(describeLogDestination({ kind: "null", path: "/dev/null" }, "manual")).toBe(
      "discarded (/dev/null)",
    );
    expect(describeLogDestination({ kind: "pipe" }, "embedded")).toBe("pipe to the embedding host");
    expect(describeLogDestination({ kind: "tty", path: "/dev/ttys001" }, "manual")).toBe(
      "terminal /dev/ttys001",
    );
    expect(describeLogDestination({ kind: "file", dev: 1, ino: 2 }, "launchd")).toContain(
      "unresolved path",
    );
    expect(describeLogDestination(null, null)).toContain("predates");
  });
});
