import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installOpencodeIntegration,
  isOurPlugin,
  opencodeIntegrationStatus,
  opencodePluginPath,
  uninstallOpencodeIntegration,
  PLUGIN_FILENAME,
  PLUGIN_MARKER,
  PLUGIN_SOURCE,
} from "./opencode.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-opencode-"));
  process.env.TMUX_IDE_OPENCODE_DIR = dir;
});

afterEach(() => {
  delete process.env.TMUX_IDE_OPENCODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("opencodePluginPath", () => {
  it("honors the test override", () => {
    expect(opencodePluginPath()).toBe(join(dir, PLUGIN_FILENAME));
  });

  it("falls back to XDG config, then ~/.config", () => {
    delete process.env.TMUX_IDE_OPENCODE_DIR;
    const priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg-root";
    try {
      expect(opencodePluginPath()).toBe(join("/xdg-root", "opencode", "plugin", PLUGIN_FILENAME));
      delete process.env.XDG_CONFIG_HOME;
      expect(opencodePluginPath()).toContain(join(".config", "opencode", "plugin"));
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
    }
  });
});

describe("PLUGIN_SOURCE", () => {
  it("carries the removal marker and the safe-id gate", () => {
    expect(isOurPlugin(PLUGIN_SOURCE)).toBe(true);
    // The same charset restore trusts — nothing shell-active can be stamped.
    expect(PLUGIN_SOURCE).toContain("/^[A-Za-z0-9_-]+$/");
    // Child sessions must never overwrite the pane's own conversation key.
    expect(PLUGIN_SOURCE).toContain("parentID");
    // Stays inert outside tmux.
    expect(PLUGIN_SOURCE).toContain("TMUX_PANE");
  });

  it("is valid ESM (parses as a module)", async () => {
    const file = join(dir, "parse-check.mjs");
    writeFileSync(file, PLUGIN_SOURCE, "utf8");
    const mod = await import(file);
    expect(typeof mod.TmuxIde).toBe("function");
    // Outside tmux the plugin returns an inert hook set.
    const priorPane = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      expect(await mod.TmuxIde()).toEqual({});
    } finally {
      if (priorPane !== undefined) process.env.TMUX_PANE = priorPane;
    }
  });
});

describe("install / uninstall / status", () => {
  it("installs the plugin file and reports installed", () => {
    expect(opencodeIntegrationStatus().installed).toBe(false);
    const { pluginPath } = installOpencodeIntegration();
    expect(pluginPath).toBe(join(dir, PLUGIN_FILENAME));
    expect(readFileSync(pluginPath, "utf8")).toContain(PLUGIN_MARKER);
    expect(opencodeIntegrationStatus().installed).toBe(true);
  });

  it("is idempotent", () => {
    installOpencodeIntegration();
    installOpencodeIntegration();
    expect(opencodeIntegrationStatus().installed).toBe(true);
  });

  it("uninstall removes exactly our file", () => {
    installOpencodeIntegration();
    const { wasInstalled, pluginPath } = uninstallOpencodeIntegration();
    expect(wasInstalled).toBe(true);
    expect(existsSync(pluginPath)).toBe(false);
    expect(uninstallOpencodeIntegration().wasInstalled).toBe(false);
  });

  it("never deletes a user's own tmux-ide.js (no marker)", () => {
    const pluginPath = opencodePluginPath();
    writeFileSync(pluginPath, "export const Mine = async () => ({});\n", "utf8");
    expect(opencodeIntegrationStatus().installed).toBe(false);
    const { wasInstalled } = uninstallOpencodeIntegration();
    expect(wasInstalled).toBe(false);
    expect(existsSync(pluginPath)).toBe(true);
  });
});
