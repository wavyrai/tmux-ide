import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  DAEMON_CHILD_OUTPUT_MAX_LINES,
  DaemonChildOutputTailSchemaZ,
  type DaemonChildOutputTail,
  type DesktopDaemonHostState,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfoState } from "../../../packages/daemon/src/canonical.ts";
import { rendererDaemonState } from "./daemon-resource-broker.ts";
import {
  DesktopDaemonSupervisor,
  sanitizeDaemonChildOutputLines,
  type DesktopDaemonSupervisorDependencies,
  type SpawnedDaemonChild,
} from "./daemon-supervisor.ts";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.emit("exit", null, signal);
    return true;
  });

  constructor(readonly pid: number) {
    super();
  }
}

const missing: DesktopDaemonHostState = {
  status: "unavailable",
  code: "record-missing",
  reason: "No canonical daemon record exists.",
};

/**
 * A supervisor whose start attempt spawns one child and then fails: exactly the
 * shape of the shipped defect (a child that dies with its stderr captured).
 */
function supervisorWithChild(
  child: FakeChild,
  forwardChildLog?: boolean,
  writeChildLog: (chunk: string) => void = () => undefined,
  preflight: { probe: () => Promise<DesktopDaemonHostState> } = { probe: async () => missing },
) {
  let time = 0;
  const dependencies: DesktopDaemonSupervisorDependencies = {
    writeChildLog,
    claimAllowsStartupAttempt: () => true,
    inspectCanonical: (): CanonicalDaemonInfoState => ({ status: "missing" }),
    ownerProvenDead: async () => true,
    spawnChild: () => child as unknown as SpawnedDaemonChild,
    now: () => time,
    // The readiness loop's own short backoffs advance the fake clock so the
    // startup barrier can time out; a restart backoff (>=100ms) parks until the
    // test ends, since an immediately-resolving one would turn supervision into
    // a hot respawn loop.
    sleep: (milliseconds) => {
      time += milliseconds;
      return milliseconds >= 100 ? new Promise<void>(() => undefined) : Promise.resolve();
    },
    random: () => 0.5,
  };
  return new DesktopDaemonSupervisor(
    {
      preflight,
      childEntryPath: "/packaged/daemon-child.cjs",
      productVersion: "2.8.0",
      startupTimeoutMs: 60,
      shutdownTimeoutMs: 10,
      probeTimeoutMs: 10,
      ...(forwardChildLog === undefined ? {} : { forwardChildLog }),
    },
    dependencies,
  );
}

describe("daemon child output sanitizing", () => {
  it("keeps the child's own words, bounded and control-free", () => {
    const lines = sanitizeDaemonChildOutputLines(
      "Error: listen EADDRINUSE 127.0.0.1:8787\r\n\u001b[31mstack frame\u001b[0m\n\n",
      DAEMON_CHILD_OUTPUT_MAX_LINES,
    );
    expect(lines).toEqual(["Error: listen EADDRINUSE 127.0.0.1:8787", "[31mstack frame[0m"]);
    for (const line of lines) {
      expect(DaemonChildOutputTailSchemaZ.shape.lines.element.safeParse(line).success).toBe(true);
    }
  });

  it("drops a line that looks like it carries a credential", () => {
    const lines = sanitizeDaemonChildOutputLines(
      ["starting", "Authorization: Bearer ta1_secretvalue", "listening"].join("\n"),
      DAEMON_CHILD_OUTPUT_MAX_LINES,
    );
    expect(lines).toEqual(["starting", "listening"]);
  });

  it("truncates an overlong line rather than dropping it", () => {
    const [line] = sanitizeDaemonChildOutputLines("x".repeat(4_000), 5);
    expect(line).toHaveLength(500);
  });

  it("keeps only the last N lines", () => {
    const text = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");
    const lines = sanitizeDaemonChildOutputLines(text, DAEMON_CHILD_OUTPUT_MAX_LINES);
    expect(lines).toHaveLength(DAEMON_CHILD_OUTPUT_MAX_LINES);
    expect(lines.at(-1)).toBe("line 199");
  });
});

describe("supervisor child output tail", () => {
  it("is null before any child exists", () => {
    const supervisor = supervisorWithChild(new FakeChild(5100));
    expect(supervisor.childOutputTail()).toBeNull();
  });

  it("carries the stderr and exit facts of a child that died on its own", async () => {
    // The shipped defect, reproduced: the child prints its reason and exits
    // during the readiness barrier. Emitting from inside the probe puts the
    // death exactly where it happened in production — mid-barrier, before the
    // supervisor ever gets to terminate it.
    const child = new FakeChild(5100);
    let probes = 0;
    const supervisor = supervisorWithChild(child, false, () => undefined, {
      probe: async () => {
        probes += 1;
        if (probes === 2) {
          child.stderr.write("Error: EADDRINUSE 127.0.0.1:8787\n");
          await new Promise((resolve) => setImmediate(resolve));
          child.emit("exit", 1, null);
        }
        return missing;
      },
    });
    await supervisor.start();

    const tail = supervisor.childOutputTail();
    expect(tail).toEqual({
      stream: "stderr",
      lines: ["Error: EADDRINUSE 127.0.0.1:8787"],
      truncated: false,
      exitCode: 1,
      signal: null,
    });
    expect(DaemonChildOutputTailSchemaZ.safeParse(tail).success).toBe(true);
  });

  it("reports the signal when the supervisor had to terminate the child", async () => {
    const child = new FakeChild(5100);
    const supervisor = supervisorWithChild(child);
    const started = supervisor.start();
    await Promise.resolve();
    child.stderr.write("half-started\n");
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    expect(supervisor.childOutputTail()).toMatchObject({
      lines: ["half-started"],
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("forwards child stderr to the process log only when asked", async () => {
    const quietLog = vi.fn();
    const quiet = new FakeChild(5100);
    const quietSupervisor = supervisorWithChild(quiet, false, quietLog);
    const quietStart = quietSupervisor.start();
    await Promise.resolve();
    quiet.stderr.write("silent line\n");
    await new Promise((resolve) => setImmediate(resolve));
    quiet.emit("exit", 1, null);
    await quietStart;
    expect(quietLog).not.toHaveBeenCalled();

    const loudLog = vi.fn();
    const loud = new FakeChild(5200);
    const loudSupervisor = supervisorWithChild(loud, true, loudLog);
    const loudStart = loudSupervisor.start();
    await Promise.resolve();
    loud.stderr.write("forwarded line\n");
    await new Promise((resolve) => setImmediate(resolve));
    loud.emit("exit", 1, null);
    await loudStart;
    expect(loudLog).toHaveBeenCalledWith("forwarded line\n");
  });
});

describe("renderer daemon state", () => {
  const tail: DaemonChildOutputTail = {
    stream: "stderr",
    lines: ["Error: EADDRINUSE 127.0.0.1:8787"],
    truncated: false,
    exitCode: 1,
    signal: null,
  };

  it("attaches the child output to a disconnected state", () => {
    expect(rendererDaemonState(missing, tail)).toEqual({
      status: "unavailable",
      code: "record-missing",
      reason: "The canonical daemon is unavailable.",
      childOutput: tail,
    });
  });

  it("omits it when there is none", () => {
    expect(rendererDaemonState(missing, null)).toEqual({
      status: "unavailable",
      code: "record-missing",
      reason: "The canonical daemon is unavailable.",
    });
  });

  it("never attaches it to a connected state", () => {
    const state = rendererDaemonState(
      {
        status: "connected",
        descriptor: {
          apiBaseUrl: "http://127.0.0.1:6060/",
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
      },
      tail,
    );
    expect(state).not.toHaveProperty("childOutput");
  });
});
