/**
 * Unit tests for the doctor's pure "agent integrations" row builder. The row
 * text depends only on a DiscoveredAgent[], so no io is needed here.
 */
import { describe, expect, it } from "vitest";
import { agentIntegrationRows, hooksTargetRow } from "./doctor.ts";
import type { DiscoveredAgent } from "./lib/agent-discovery.ts";

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
