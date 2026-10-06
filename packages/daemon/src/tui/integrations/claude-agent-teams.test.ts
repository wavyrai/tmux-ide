import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TEAMS_ENV,
  agentTeamsSetting,
  claudeAgentTeamsStatus,
  claudeOnPath,
  disableAgentTeams,
  disableClaudeAgentTeams,
  enableClaudeAgentTeams,
  isOptOut,
  mergeAgentTeams,
  type AgentTeamsPaths,
} from "./claude-agent-teams.ts";

describe("mergeAgentTeams (pure)", () => {
  it("enables teams and auto teammate mode when both are absent", () => {
    const merged = mergeAgentTeams({});
    expect(merged.settings).toEqual({ env: { [AGENT_TEAMS_ENV]: "1" }, teammateMode: "auto" });
    expect(merged.changes).toEqual([`env.${AGENT_TEAMS_ENV}=1`, "teammateMode=auto"]);
  });

  it("is a no-op when already enabled with a teammate mode", () => {
    const settings = { env: { [AGENT_TEAMS_ENV]: "1" }, teammateMode: "tmux" };
    const merged = mergeAgentTeams(settings);
    expect(merged.changes).toEqual([]);
    expect(merged.settings).toBe(settings);
  });

  it("only adds teammateMode when the env flag is already on", () => {
    const merged = mergeAgentTeams({ env: { [AGENT_TEAMS_ENV]: "true" } });
    expect(merged.changes).toEqual(["teammateMode=auto"]);
    expect(merged.settings.env).toEqual({ [AGENT_TEAMS_ENV]: "true" });
  });

  it("never overwrites an existing teammateMode", () => {
    const merged = mergeAgentTeams({ teammateMode: "in-process" });
    expect(merged.settings.teammateMode).toBe("in-process");
    expect(merged.changes).toEqual([`env.${AGENT_TEAMS_ENV}=1`]);
  });

  for (const off of ["0", "false", " OFF ", false, 0])
    it(`respects the user's opt-out (${JSON.stringify(off)}) and touches nothing`, () => {
      const settings = { env: { [AGENT_TEAMS_ENV]: off } };
      const merged = mergeAgentTeams(settings);
      expect(merged.setting).toBe("disabled-by-user");
      expect(merged.changes).toEqual([]);
      expect(merged.settings).toBe(settings);
    });

  it("preserves every other key, including other env entries", () => {
    const settings = {
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
      env: { OTHER: "keep" },
      permissions: { allow: ["Bash(ls)"] },
    };
    const merged = mergeAgentTeams(settings);
    expect(merged.settings).toEqual({
      ...settings,
      env: { OTHER: "keep", [AGENT_TEAMS_ENV]: "1" },
      teammateMode: "auto",
    });
    expect(settings.env).toEqual({ OTHER: "keep" });
  });

  it("rejects a non-object env instead of guessing", () => {
    expect(() => mergeAgentTeams({ env: "nope" })).toThrow();
  });

  it("classifies the setting and opt-out values", () => {
    expect(agentTeamsSetting({})).toBe("not-configured");
    expect(agentTeamsSetting({ env: { [AGENT_TEAMS_ENV]: "1" } })).toBe("enabled");
    expect(agentTeamsSetting({ env: { [AGENT_TEAMS_ENV]: "0" } })).toBe("disabled-by-user");
    expect(isOptOut("1")).toBe(false);
    expect(isOptOut(undefined)).toBe(false);
  });

  it("an explicit enable overrides the opt-out, keeping teammateMode", () => {
    const merged = mergeAgentTeams(
      { env: { [AGENT_TEAMS_ENV]: "0" }, teammateMode: "tmux" },
      { overrideOptOut: true },
    );
    expect(merged.settings).toEqual({ env: { [AGENT_TEAMS_ENV]: "1" }, teammateMode: "tmux" });
    expect(merged.changes).toEqual([`env.${AGENT_TEAMS_ENV}=1`]);
  });

  it("disable records an explicit opt-out once", () => {
    const off = disableAgentTeams({ teammateMode: "auto" });
    expect(off.settings).toEqual({ teammateMode: "auto", env: { [AGENT_TEAMS_ENV]: "0" } });
    expect(disableAgentTeams(off.settings).changes).toEqual([]);
    expect(mergeAgentTeams(off.settings).changes).toEqual([]);
  });
});

describe("agent teams settings io", () => {
  let root: string;
  let paths: AgentTeamsPaths;
  const notOnPath = () => false;
  const read = () => JSON.parse(readFileSync(paths.settingsPath, "utf8"));
  const backups = () =>
    readdirSync(paths.claudeDir).filter((name) => name.includes(".tmux-ide-backup-"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tmux-ide-agent-teams-"));
    paths = {
      claudeDir: join(root, ".claude"),
      settingsPath: join(root, ".claude", "settings.json"),
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("skips without writing when Claude Code is not installed", () => {
    const result = enableClaudeAgentTeams(paths, notOnPath);
    expect(result.action).toBe("skipped");
    expect(result.claudeDetected).toBe(false);
    expect(() => statSync(paths.claudeDir)).toThrow();
  });

  it("acts when claude is on PATH even without ~/.claude, creating the file", () => {
    const result = enableClaudeAgentTeams(paths, () => true);
    expect(result.action).toBe("enabled");
    expect(result.backup).toBeNull();
    expect(read()).toEqual({ env: { [AGENT_TEAMS_ENV]: "1" }, teammateMode: "auto" });
  });

  it("writes 2-space JSON, backs up once, then no-ops without writing", () => {
    mkdirSync(paths.claudeDir);
    writeFileSync(paths.settingsPath, '{"model":"opus"}', { mode: 0o640 });
    const first = enableClaudeAgentTeams(paths, notOnPath);
    expect(first.action).toBe("enabled");
    expect(first.message).toContain("Disable: tmux-ide integration agent-teams disable");
    expect(first.backup).toMatch(/settings\.json\.tmux-ide-backup-\d{8}T\d{6}Z$/u);
    expect(readFileSync(first.backup!, "utf8")).toBe('{"model":"opus"}');
    expect(readFileSync(paths.settingsPath, "utf8")).toBe(
      `${JSON.stringify({ model: "opus", env: { [AGENT_TEAMS_ENV]: "1" }, teammateMode: "auto" }, null, 2)}\n`,
    );
    expect(statSync(paths.settingsPath).mode & 0o777).toBe(0o640);
    const before = statSync(paths.settingsPath).mtimeMs;
    const second = enableClaudeAgentTeams(paths, notOnPath);
    expect(second.action).toBe("unchanged");
    expect(statSync(paths.settingsPath).mtimeMs).toBe(before);
    expect(readdirSync(paths.claudeDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("respects an opt-out on disk and reports it", () => {
    mkdirSync(paths.claudeDir);
    const original = JSON.stringify({ env: { [AGENT_TEAMS_ENV]: "0" } });
    writeFileSync(paths.settingsPath, original);
    const result = enableClaudeAgentTeams(paths, notOnPath);
    expect(result.action).toBe("disabled-by-user");
    expect(readFileSync(paths.settingsPath, "utf8")).toBe(original);
    expect(backups()).toEqual([]);
  });

  it("refuses to touch invalid JSON", () => {
    mkdirSync(paths.claudeDir);
    writeFileSync(paths.settingsPath, "{ not json");
    const result = enableClaudeAgentTeams(paths, notOnPath);
    expect(result.action).toBe("invalid");
    expect(readFileSync(paths.settingsPath, "utf8")).toBe("{ not json");
    expect(claudeAgentTeamsStatus(paths, notOnPath).setting).toBe("invalid-settings");
    expect(disableClaudeAgentTeams(paths).action).toBe("invalid");
  });

  it("disable keeps a single backup and makes later enables respect the opt-out", () => {
    mkdirSync(paths.claudeDir);
    writeFileSync(paths.settingsPath, "{}");
    enableClaudeAgentTeams(paths, notOnPath);
    const off = disableClaudeAgentTeams(paths);
    expect(off.action).toBe("disabled");
    expect(read().env[AGENT_TEAMS_ENV]).toBe("0");
    expect(backups()).toHaveLength(1);
    expect(enableClaudeAgentTeams(paths, notOnPath).action).toBe("disabled-by-user");
    const status = claudeAgentTeamsStatus(paths, notOnPath);
    const again = enableClaudeAgentTeams(paths, notOnPath, { overrideOptOut: true });
    expect(again.action).toBe("enabled");
    expect(read().env[AGENT_TEAMS_ENV]).toBe("1");
    expect(backups()).toHaveLength(1);
    expect(status).toEqual({
      settingsPath: paths.settingsPath,
      claudeDetected: true,
      setting: "disabled-by-user",
      teammateMode: "auto",
    });
  });

  it("finds an executable claude on PATH only", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    expect(claudeOnPath(bin)).toBe(false);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o644 });
    expect(claudeOnPath(bin)).toBe(false);
    chmodSync(join(bin, "claude"), 0o755);
    expect(claudeOnPath(`/nonexistent:${bin}`)).toBe(true);
  });
});
