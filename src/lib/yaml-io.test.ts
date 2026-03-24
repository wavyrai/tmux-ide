import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { readConfig, writeConfig, getSessionName } from "./yaml-io.ts";
import type { IdeConfig } from "../types.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-yaml-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeConfig + readConfig", () => {
  it("round-trips a config object", () => {
    const config: IdeConfig = {
      name: "test-project",
      rows: [
        {
          size: "70%",
          panes: [
            { title: "Claude", command: "claude", role: "lead", focus: true },
            { title: "Shell", command: "zsh" },
          ],
        },
        {
          panes: [{ title: "Dev", command: "pnpm dev" }],
        },
      ],
    };

    writeConfig(tmpDir, config);
    const { config: loaded, configPath } = readConfig(tmpDir);

    expect(loaded.name).toBe("test-project");
    expect(loaded.rows.length).toBe(2);
    expect(loaded.rows[0]!.size).toBe("70%");
    expect(loaded.rows[0]!.panes.length).toBe(2);
    expect(loaded.rows[0]!.panes[0]!.title).toBe("Claude");
    expect(loaded.rows[0]!.panes[0]!.role).toBe("lead");
    expect(loaded.rows[0]!.panes[0]!.focus).toBe(true);
    expect(configPath.endsWith("ide.yml")).toBeTruthy();
  });

  it("preserves theme config", () => {
    const config: IdeConfig = {
      rows: [{ panes: [{}] }],
      theme: { accent: "colour75", border: "colour238" },
    };

    writeConfig(tmpDir, config);
    const { config: loaded } = readConfig(tmpDir);
    expect(loaded.theme?.accent).toBe("colour75");
    expect(loaded.theme?.border).toBe("colour238");
  });

  it("preserves orchestrator config", () => {
    const config: IdeConfig = {
      rows: [{ panes: [{}] }],
      orchestrator: {
        enabled: true,
        auto_dispatch: true,
        stall_timeout: 300000,
        dispatch_mode: "goals",
      },
    };

    writeConfig(tmpDir, config);
    const { config: loaded } = readConfig(tmpDir);
    expect(loaded.orchestrator?.enabled).toBe(true);
    expect(loaded.orchestrator?.dispatch_mode).toBe("goals");
  });

  it("preserves team config", () => {
    const config: IdeConfig = {
      rows: [{ panes: [{}] }],
      team: { name: "my-team", model: "opus", permissions: ["read", "write"] },
    };

    writeConfig(tmpDir, config);
    const { config: loaded } = readConfig(tmpDir);
    expect(loaded.team?.name).toBe("my-team");
    expect(loaded.team?.model).toBe("opus");
    expect(loaded.team?.permissions).toEqual(["read", "write"]);
  });
});

describe("readConfig", () => {
  it("throws when no ide.yml exists", () => {
    expect(() => readConfig(tmpDir)).toThrow();
  });

  it("throws on malformed YAML", () => {
    writeFileSync(join(tmpDir, "ide.yml"), ": invalid: yaml: [");
    expect(() => readConfig(tmpDir)).toThrow();
  });
});

describe("getSessionName", () => {
  it("returns name from config", () => {
    const config: IdeConfig = { name: "my-project", rows: [{ panes: [{}] }] };
    writeConfig(tmpDir, config);
    const result = getSessionName(tmpDir);
    expect(result.name).toBe("my-project");
    expect(result.source).toBe("config");
  });

  it("falls back to directory basename when no name in config", () => {
    const config: IdeConfig = { rows: [{ panes: [{}] }] };
    writeConfig(tmpDir, config);
    const result = getSessionName(tmpDir);
    expect(result.name).toBe(basename(tmpDir));
    expect(result.source).toBe("fallback");
  });

  it("falls back to directory basename when no config file", () => {
    const result = getSessionName(tmpDir);
    expect(result.name).toBe(basename(tmpDir));
    expect(result.source).toBe("fallback");
  });
});
