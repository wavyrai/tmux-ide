/**
 * Live proof: a real embedded daemon in a private state home stamps its log
 * provenance into the daemon record, and the report labels a planted stale
 * `headless.out` as historical while never exposing the auth token.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDaemonShutdownBackend } from "../../command-center/actions/handlers/daemon-shutdown.ts";
import { inspectCanonicalDaemonInfo, readCanonicalDaemonInfo } from "../canonical-daemon.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { collectDaemonProvenanceReport } from "../daemon-provenance.ts";
import { getLogIdentity } from "../log.ts";
import { WorkspaceRegistry, _setDefaultWorkspaceRegistryForTests } from "../workspace-registry.ts";

const DEAD_PID = 2147483647;
let stateDir: string;
let previousEnv: Record<string, string | undefined>;
const handles = new Set<EmbeddedDaemonHandle>();

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tmux-ide-provenance-live-"));
  previousEnv = {
    TMUX_IDE_DAEMON_INFO_DIR: process.env.TMUX_IDE_DAEMON_INFO_DIR,
    TMUX_IDE_REGISTRY_DIR: process.env.TMUX_IDE_REGISTRY_DIR,
    TMUX_IDE_SETTINGS_DIR: process.env.TMUX_IDE_SETTINGS_DIR,
    TMUX_IDE_HOME: process.env.TMUX_IDE_HOME,
  };
  process.env.TMUX_IDE_DAEMON_INFO_DIR = stateDir;
  process.env.TMUX_IDE_REGISTRY_DIR = stateDir;
  process.env.TMUX_IDE_SETTINGS_DIR = stateDir;
  process.env.TMUX_IDE_HOME = stateDir;
  _setDefaultWorkspaceRegistryForTests(
    new WorkspaceRegistry({ dir: stateDir, listSessions: () => [] }),
  );
  setDaemonShutdownBackend(null);
});

afterEach(async () => {
  for (const handle of handles) await handle.stop().catch(() => undefined);
  handles.clear();
  setDaemonShutdownBackend(null);
  _setDefaultWorkspaceRegistryForTests(null);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(stateDir, { recursive: true, force: true });
});

describe.sequential("daemon provenance (live embedded daemon)", () => {
  it("stamps provenance into the record and labels a planted stale log as historical", async () => {
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    const stale = join(stateDir, "logs", "headless.out");
    writeFileSync(stale, `Canonical daemon ready: http://127.0.0.1:1 (pid ${DEAD_PID})\n`);

    const handle = await startEmbeddedDaemon({
      silent: true,
      launcher: "headless",
      localBypassToken: "live-local-bypass-token-value",
    });
    handles.add(handle);

    const info = readCanonicalDaemonInfo();
    expect(info).not.toBeNull();
    expect(info!.provenance).toMatchObject({
      launcher: "headless",
      parentPid: process.ppid,
    });
    expect(["manual", "launchd", "systemd"]).toContain(info!.provenance!.supervisor);
    expect(["file", "tty", "pipe", "socket", "null", "unknown"]).toContain(
      info!.provenance!.stdout.kind,
    );
    expect(getLogIdentity()).toEqual({
      instanceId: handle.instanceId,
      version: info!.productVersion,
    });

    const report = collectDaemonProvenanceReport({ recordState: inspectCanonicalDaemonInfo() });
    expect(report.status).toBe("running");
    expect(report.daemon).toMatchObject({
      instanceId: handle.instanceId,
      pid: process.pid,
      liveness: "alive",
      launcher: "headless",
      provenanceRecorded: true,
    });
    const planted = report.logFiles.find((file) => file.path === stale);
    expect(planted).toMatchObject({ status: "historical", pid: DEAD_PID, pidLiveness: "dead" });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("live-local-bypass-token-value");
    expect(serialized).not.toContain("authToken");
  });
});
