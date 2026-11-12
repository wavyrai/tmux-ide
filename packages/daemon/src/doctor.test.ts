/**
 * Unit tests for the doctor's pure "agent integrations" row builder. The row
 * text depends only on a DiscoveredAgent[], so no io is needed here.
 */
import { describe, expect, it } from "vitest";
import {
  agentIntegrationRows,
  daemonProvenanceRow,
  hooksTargetRow,
  plainTmuxRow,
  snapshotRow,
  tmuxFeaturesRow,
} from "./doctor.ts";
import type { DiscoveredAgent } from "./lib/agent-discovery.ts";
import type { DaemonProvenanceReport } from "./lib/daemon-provenance.ts";

const agent = (over: Partial<DiscoveredAgent>): DiscoveredAgent => ({
  id: "x",
  bin: "x",
  integration: false,
  path: "/usr/bin/x",
  installed: false,
  capture: null,
  captureActive: false,
  ...over,
});

describe("agentIntegrationRows", () => {
  it("omits agents absent from PATH (no noise)", () => {
    const rows = agentIntegrationRows([
      agent({ id: "gemini", integration: false, path: null }),
      agent({ id: "claude", integration: true, path: null }),
    ]);
    expect(rows).toEqual([]);
  });

  it("renders an installed claude as a passing ✓ row", () => {
    const rows = agentIntegrationRows([
      agent({ id: "claude", integration: true, path: "/bin/claude", installed: true }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("agent: claude");
    expect(rows[0]!.pass).toBe(true);
    expect(rows[0]!.optional).toBe(true);
    expect(rows[0]!.detail).toContain("integration installed");
  });

  it("renders a present-but-uninstalled claude as a ○ hint pointing at the installer", () => {
    const rows = agentIntegrationRows([
      agent({ id: "claude", integration: true, path: "/bin/claude", installed: false }),
    ]);
    expect(rows[0]!.pass).toBe(false); // ○, not ✓
    expect(rows[0]!.optional).toBe(true); // never fails the overall check
    expect(rows[0]!.detail).toContain("tmux-ide integration install claude");
  });

  it("renders a non-integrated agent as a passing screen-manifest row", () => {
    const rows = agentIntegrationRows([
      agent({ id: "opencode", integration: false, path: "/bin/opencode" }),
    ]);
    expect(rows[0]!.label).toBe("agent: opencode");
    expect(rows[0]!.pass).toBe(true);
    expect(rows[0]!.detail).toContain("screen-manifest");
    expect(rows[0]!.detail).toContain("no lifecycle integration");
  });

  it("keeps every row optional so discovery never fails doctor overall", () => {
    const rows = agentIntegrationRows([
      agent({ id: "claude", integration: true, path: "/bin/claude", installed: false }),
      agent({ id: "codex", integration: false, path: "/bin/codex" }),
    ]);
    expect(rows.every((r) => r.optional)).toBe(true);
  });
});

describe("hooksTargetRow", () => {
  const path = "/home/u/.claude/settings.json";

  it("passes with the bare path when the file exists and is writable", () => {
    const row = hooksTargetRow({ settingsPath: path, fileExists: true, writable: true });
    expect(row.pass).toBe(true);
    expect(row.detail).toBe(path);
  });

  it("passes with a 'will be created' note when the file is absent but creatable", () => {
    const row = hooksTargetRow({ settingsPath: path, fileExists: false, writable: true });
    expect(row.pass).toBe(true);
    expect(row.detail).toContain("will be created");
  });

  it("fails with a plain fix hint (permissions + env override) when not writable", () => {
    const row = hooksTargetRow({ settingsPath: path, fileExists: true, writable: false });
    expect(row.pass).toBe(false);
    expect(row.detail).toContain(path);
    expect(row.detail).toContain("chown/chmod");
    expect(row.detail).toContain("TMUX_IDE_CLAUDE_SETTINGS");
  });

  it("never fails doctor overall (always optional)", () => {
    for (const fileExists of [true, false]) {
      for (const writable of [true, false]) {
        expect(hooksTargetRow({ settingsPath: path, fileExists, writable }).optional).toBe(true);
      }
    }
  });
});

describe("notifierRow", () => {
  it("passes when the bundled native helper is present", async () => {
    const { notifierRow } = await import("./doctor.ts");
    const row = notifierRow(true);
    expect(row.pass).toBe(true);
    expect(row.optional).toBe(true);
    expect(row.detail).toContain("branded banners");
  });

  it("suggests reinstalling when the release helper is absent", async () => {
    const { notifierRow } = await import("./doctor.ts");
    const row = notifierRow(false);
    expect(row.pass).toBe(false);
    expect(row.optional).toBe(true); // informational — never fails doctor
    expect(row.detail).toContain("reinstall tmux-ide");
    expect(row.detail).toContain("AppleScript");
  });
});

describe("runtime prerequisites", () => {
  it("requires Node20 while accepting newer runtimes", async () => {
    const { nodeVersionRow } = await import("./doctor.ts");
    expect(nodeVersionRow("18.20.0").pass).toBe(false);
    expect(nodeVersionRow("20.0.0").pass).toBe(true);
    expect(nodeVersionRow("24.2.0").pass).toBe(true);
  });
  it("accepts absent optional configuration but fails malformed present configuration", async () => {
    const { workspaceConfigRow } = await import("./doctor.ts");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "doctor-configless-"));
    try {
      expect(await workspaceConfigRow(root)).toMatchObject({
        pass: true,
        detail: "absent (optional; configless mode)",
      });
      mkdirSync(join(root, ".tmux-ide"));
      writeFileSync(join(root, ".tmux-ide/workspace.yml"), "version: [malformed");
      expect(await workspaceConfigRow(root)).toMatchObject({ pass: false, optional: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("daemonProvenanceRow", () => {
  const namespace = {
    mode: "test",
    stateHome: "/s",
    daemonInfoDir: "/s",
    logsDir: "/s/logs",
    recordPath: "/s/daemon.json",
  };
  const daemon: NonNullable<DaemonProvenanceReport["daemon"]> = {
    instanceId: "11111111-1111-4111-8111-111111111111",
    productVersion: "2.9.0",
    protocolVersion: 2,
    pid: 4242,
    port: 4010,
    bindHostname: "127.0.0.1",
    startedAt: "2026-09-20T00:00:00.000Z",
    supervisionId: "tmux-ide.service",
    liveness: "alive",
    launcher: "headless",
    supervisor: "systemd",
    parentPid: 1,
    provenanceRecorded: true,
    logs: { stdout: { kind: "socket" }, stderr: { kind: "socket" } },
    logDestination: "systemd journal (socket; use journalctl)",
    provenanceWarnings: [],
  };
  const report = (over: Partial<DaemonProvenanceReport>): DaemonProvenanceReport => ({
    generatedAt: "2026-09-21T00:00:00.000Z",
    status: "running",
    namespace,
    record: { status: "valid" },
    daemon,
    logFiles: [],
    warnings: [],
    ...over,
  });

  it("summarizes a running daemon with its real log destination and stale-log count", () => {
    const row = daemonProvenanceRow(
      report({
        logFiles: [
          {
            path: "/s/headless.out",
            bytes: 1,
            lastWriteAt: "2026-09-01T00:00:00.000Z",
            dev: 1,
            ino: 1,
            pid: 99,
            status: "historical",
            reason: "dead",
          },
        ],
      }),
    );
    expect(row.pass).toBe(true);
    expect(row.optional).toBe(true);
    expect(row.detail).toBe(
      "running v2.9.0 pid 4242 (systemd) · logs → systemd journal (socket; use journalctl) — 1 historical log file (see `tmux-ide daemon info`)",
    );
  });

  it("flags a stale record and an invalid record as ○ rows", () => {
    expect(daemonProvenanceRow(report({ status: "stale-record" }))).toMatchObject({
      pass: false,
      optional: true,
      detail: "record names pid 4242 (v2.9.0) but it is not running",
    });
    expect(
      daemonProvenanceRow(
        report({
          status: "record-invalid",
          daemon: null,
          record: { status: "invalid", reason: "symlink", detail: "x" },
        }),
      ).detail,
    ).toBe("record invalid (symlink)");
  });

  it("treats no daemon as healthy", () => {
    expect(
      daemonProvenanceRow(
        report({ status: "not-running", daemon: null, record: { status: "missing" } }),
      ),
    ).toMatchObject({
      pass: true,
      detail: "not running",
    });
    expect(
      daemonProvenanceRow(
        report({
          status: "not-running",
          daemon: null,
          record: {
            status: "reserved",
            supervisionId: "svc",
            reservedAt: "2026-09-20T00:00:00.000Z",
          },
        }),
      ).detail,
    ).toBe("not running (reserved for supervisor svc)");
  });
});

describe("tmux features row", () => {
  const CAPABILITY = JSON.stringify({
    schemaVersion: 1,
    capability: "split-resize-v1",
    sessionMembership: "exact-session-link-v1",
    maxDepth: 64,
    maxLeaves: 512,
    maxGrid: 4096,
  });
  const fail = (stderr: string) => {
    throw Object.assign(new Error("Command failed"), { stderr });
  };
  const bundled = (args: readonly string[]) =>
    args[0] === "tmux-ide-resize-split" ? CAPABILITY : "{}";
  const stock = (args: readonly string[]) => fail(`unknown command: ${args[0]}\n`);
  const none = () => fail("no server running on /tmp/s\n");
  it("names stock tmux and bundled tmux from the running server", () => {
    expect(tmuxFeaturesRow(stock, bundled).detail).toBe(
      "stock tmux: reduced features (tab positions in saved output are reconstructed); run `tmux-ide servers upgrade` to move it to tmux-ide's own tmux",
    );
    expect(tmuxFeaturesRow(bundled, stock).detail).toBe("bundled tmux: full features");
    expect(tmuxFeaturesRow(stock, bundled)).toMatchObject({ pass: true, optional: true });
  });
  it("asks the binary only when no server is running", () => {
    expect(tmuxFeaturesRow(none, stock).detail).toBe(
      "stock tmux: reduced features (tab positions in saved output are reconstructed)",
    );
    expect(tmuxFeaturesRow(none, bundled).detail).toBe("bundled tmux: full features");
    expect(tmuxFeaturesRow(() => fail("error connecting to /tmp/s\n"), stock).detail).toBe(
      "stock tmux: reduced features (tab positions in saved output are reconstructed)",
    );
  });
  it("names an older tmux-ide tmux that lacks only the split command", () => {
    const eventsOnly = (args: readonly string[]) =>
      args[0] === "tmux-ide-events" ? "{}" : fail(`unknown command: ${args[0]}\n`);
    expect(tmuxFeaturesRow(eventsOnly, bundled)).toMatchObject({
      pass: true,
      detail:
        "older tmux-ide tmux: reduced features; run `tmux-ide servers upgrade` to move it to tmux-ide's own tmux",
    });
  });
  it("does not guess when the split command is missing and the journal probe fails", () => {
    const journalTimesOut = (args: readonly string[]) =>
      args[0] === "tmux-ide-events"
        ? fail("spawnSync tmux ETIMEDOUT")
        : fail(`unknown command: ${args[0]}\n`);
    expect(tmuxFeaturesRow(journalTimesOut, bundled)).toMatchObject({
      pass: false,
      detail: "could not read the tmux server's features",
    });
  });
  it("gives the mirror's verdict for a build with only some commands", () => {
    const splitOnly = (args: readonly string[]) =>
      args[0] === "tmux-ide-resize-split" ? CAPABILITY : fail(`unknown command: ${args[0]}\n`);
    const oldCapability = (args: readonly string[]) =>
      args[0] === "tmux-ide-resize-split" ? '{"schemaVersion":1}' : "{}";
    for (const probe of [splitOnly, oldCapability]) {
      const row = tmuxFeaturesRow(probe, bundled);
      expect(row.pass).toBe(false);
      expect(row.detail).toBe("this tmux has only some tmux-ide commands: no pane dividers");
    }
  });
  it("never calls another failure stock", () => {
    const row = tmuxFeaturesRow(() => fail("something else\n"), stock);
    expect(row.pass).toBe(false);
    expect(row.detail).not.toContain("stock");
  });
});

describe("plain tmux row", () => {
  it("names what a plain tmux runs, and never fails doctor for it", () => {
    expect(plainTmuxRow("/opt/homebrew/bin/tmux", "/b/tmux")).toMatchObject({
      pass: true,
      optional: true,
      detail:
        "/opt/homebrew/bin/tmux; if it starts the server, features drop (see docs: tmux upgrade)",
    });
    expect(plainTmuxRow("/b/tmux", "/b/tmux").detail).toBe("tmux-ide's own tmux (/b/tmux)");
    expect(plainTmuxRow(null, "/b/tmux").detail).toMatch(/not on PATH/);
  });
});

describe("crash snapshot row", () => {
  const NOW = Date.parse("2026-11-10T09:00:00Z");
  const saved = (savedAt: string, ...names: string[]) => ({
    savedAt,
    sessions: names.map((name) => ({ name })),
  });
  it("fails when the snapshot misses running sessions, naming its age (the 2 Nov Spark case)", () => {
    const row = snapshotRow(saved("2026-11-02T14:16:05Z", "api"), ["api", "web", "docs"], NOW);
    expect(row.pass).toBe(false);
    expect(row.detail).toMatch(/^7 days old; misses 2 running sessions \(web, docs\)/);
    expect(row.detail).toMatch(/tmux-ide adopt --all/);
  });
  it("passes when it covers every running session", () => {
    const row = snapshotRow(saved("2026-11-10T08:58:00Z", "api", "web"), ["web", "api"], NOW);
    expect(row).toMatchObject({ pass: true, detail: "2 min old, covers every running session" });
  });
  it("fails with no snapshot while sessions run, passes with none and no sessions", () => {
    expect(snapshotRow(null, ["api"], NOW).pass).toBe(false);
    expect(snapshotRow(null, [], NOW).pass).toBe(true);
  });
});
