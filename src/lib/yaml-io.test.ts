import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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

    assert.strictEqual(loaded.name, "test-project");
    assert.strictEqual(loaded.rows.length, 2);
    assert.strictEqual(loaded.rows[0]!.size, "70%");
    assert.strictEqual(loaded.rows[0]!.panes.length, 2);
    assert.strictEqual(loaded.rows[0]!.panes[0]!.title, "Claude");
    assert.strictEqual(loaded.rows[0]!.panes[0]!.role, "lead");
    assert.strictEqual(loaded.rows[0]!.panes[0]!.focus, true);
    assert.ok(configPath.endsWith("ide.yml"));
  });

  it("preserves theme config", () => {
    const config: IdeConfig = {
      rows: [{ panes: [{}] }],
      theme: { accent: "colour75", border: "colour238" },
    };

    writeConfig(tmpDir, config);
    const { config: loaded } = readConfig(tmpDir);
    assert.strictEqual(loaded.theme?.accent, "colour75");
    assert.strictEqual(loaded.theme?.border, "colour238");
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
    assert.strictEqual(loaded.orchestrator?.enabled, true);
    assert.strictEqual(loaded.orchestrator?.dispatch_mode, "goals");
  });

  it("preserves team config", () => {
    const config: IdeConfig = {
      rows: [{ panes: [{}] }],
      team: { name: "my-team", model: "opus", permissions: ["read", "write"] },
    };

    writeConfig(tmpDir, config);
    const { config: loaded } = readConfig(tmpDir);
    assert.strictEqual(loaded.team?.name, "my-team");
    assert.strictEqual(loaded.team?.model, "opus");
    assert.deepStrictEqual(loaded.team?.permissions, ["read", "write"]);
  });
});

describe("readConfig", () => {
  it("throws when no ide.yml exists", () => {
    assert.throws(() => readConfig(tmpDir));
  });

  it("throws on malformed YAML", () => {
    writeFileSync(join(tmpDir, "ide.yml"), ": invalid: yaml: [");
    assert.throws(() => readConfig(tmpDir));
  });
});

describe("getSessionName", () => {
  it("returns name from config", () => {
    const config: IdeConfig = { name: "my-project", rows: [{ panes: [{}] }] };
    writeConfig(tmpDir, config);
    const result = getSessionName(tmpDir);
    assert.strictEqual(result.name, "my-project");
    assert.strictEqual(result.source, "config");
  });

  it("falls back to directory basename when no name in config", () => {
    const config: IdeConfig = { rows: [{ panes: [{}] }] };
    writeConfig(tmpDir, config);
    const result = getSessionName(tmpDir);
    assert.strictEqual(result.name, basename(tmpDir));
    assert.strictEqual(result.source, "fallback");
  });

  it("falls back to directory basename when no config file", () => {
    const result = getSessionName(tmpDir);
    assert.strictEqual(result.name, basename(tmpDir));
    assert.strictEqual(result.source, "fallback");
  });
});
