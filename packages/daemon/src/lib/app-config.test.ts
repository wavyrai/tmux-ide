/**
 * Unit tests for the global app-config parser + loader.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_APP_CONFIG,
  _resetForTests,
  appConfigPath,
  getAppConfig,
  loadAppConfig,
  parseAppConfig,
} from "./app-config.ts";

describe("parseAppConfig — defaults", () => {
  it("returns the full defaults for undefined / null / non-objects / arrays", () => {
    expect(parseAppConfig(undefined)).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig(null)).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig("nonsense")).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig(42)).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig([])).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppConfig({})).toEqual(DEFAULT_APP_CONFIG);
  });

  it("never throws on hostile input", () => {
    expect(() => parseAppConfig({ theme: 5, keys: "x", updater: [] })).not.toThrow();
    expect(parseAppConfig({ theme: 5, keys: "x", updater: [] })).toEqual(DEFAULT_APP_CONFIG);
  });
});

describe("parseAppConfig — deep partial merge", () => {
  it("overlays only the provided leaves, keeping every sibling default", () => {
    const cfg = parseAppConfig({
      keys: { popup: "M-o" },
      theme: { accent: "colour200", status: { blocked: "colour99" } },
    });
    // provided leaves win
    expect(cfg.keys.popup).toBe("M-o");
    expect(cfg.theme.accent).toBe("colour200");
    expect(cfg.theme.status.blocked).toBe("colour99");
    // untouched siblings stay default
    expect(cfg.keys.cheatsheet).toBe("M-k");
    expect(cfg.keys.menu).toBe("M-m");
    expect(cfg.theme.muted).toBe("colour240");
    expect(cfg.theme.status.working).toBe("colour221");
    expect(cfg.theme.glyphs).toEqual(DEFAULT_APP_CONFIG.theme.glyphs);
    expect(cfg.updater).toEqual(DEFAULT_APP_CONFIG.updater);
  });
});

describe("parseAppConfig — mistyped fields fall back to default", () => {
  it("keys — non-strings become defaults", () => {
    const cfg = parseAppConfig({ keys: { popup: 5, cheatsheet: "", menu: null } });
    expect(cfg.keys).toEqual(DEFAULT_APP_CONFIG.keys);
  });

  it("theme — non-string colors/glyphs become defaults", () => {
    const cfg = parseAppConfig({
      theme: { accent: 1, fg: [], status: { done: {}, idle: "colour10" }, glyphs: { active: 7 } },
    });
    expect(cfg.theme.accent).toBe(DEFAULT_APP_CONFIG.theme.accent);
    expect(cfg.theme.fg).toBe(DEFAULT_APP_CONFIG.theme.fg);
    expect(cfg.theme.status.done).toBe(DEFAULT_APP_CONFIG.theme.status.done);
    // a valid sibling still applies
    expect(cfg.theme.status.idle).toBe("colour10");
    expect(cfg.theme.glyphs.active).toBe(DEFAULT_APP_CONFIG.theme.glyphs.active);
  });

  it("updater — non-positive / non-integer become defaults", () => {
    expect(parseAppConfig({ updater: { tickMs: 0, snapshotEvery: -1 } }).updater).toEqual(
      DEFAULT_APP_CONFIG.updater,
    );
    expect(parseAppConfig({ updater: { tickMs: 1.5, snapshotEvery: "x" } }).updater).toEqual(
      DEFAULT_APP_CONFIG.updater,
    );
    expect(parseAppConfig({ updater: { tickMs: 500, snapshotEvery: 30 } }).updater).toEqual({
      tickMs: 500,
      snapshotEvery: 30,
    });
  });

  it("notifications / restore / updates — non-booleans become defaults", () => {
    expect(parseAppConfig({ notifications: { toast: "yes", macos: 1 } }).notifications).toEqual(
      DEFAULT_APP_CONFIG.notifications,
    );
    expect(parseAppConfig({ restore: { resumeAgents: "true" } }).restore).toEqual(
      DEFAULT_APP_CONFIG.restore,
    );
    expect(parseAppConfig({ updates: { check: 0 } }).updates).toEqual(DEFAULT_APP_CONFIG.updates);
    // valid booleans apply
    expect(parseAppConfig({ notifications: { toast: false, macos: true } }).notifications).toEqual({
      toast: false,
      macos: true,
    });
    expect(parseAppConfig({ updates: { check: false } }).updates).toEqual({ check: false });
  });
});

describe("loadAppConfig / getAppConfig / TMUX_IDE_CONFIG", () => {
  let dir: string;
  const savedEnv = process.env.TMUX_IDE_CONFIG;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.TMUX_IDE_CONFIG;
    else process.env.TMUX_IDE_CONFIG = savedEnv;
    _resetForTests();
  });

  it("appConfigPath honors the TMUX_IDE_CONFIG override", () => {
    process.env.TMUX_IDE_CONFIG = "/tmp/zz-custom.json";
    expect(appConfigPath()).toBe("/tmp/zz-custom.json");
  });

  it("loads + parses a real file at the override path", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ theme: { accent: "colour200" }, keys: { popup: "M-o" } }));
    process.env.TMUX_IDE_CONFIG = path;
    const cfg = loadAppConfig();
    expect(cfg.theme.accent).toBe("colour200");
    expect(cfg.keys.popup).toBe("M-o");
    expect(cfg.theme.muted).toBe(DEFAULT_APP_CONFIG.theme.muted);
  });

  it("falls back to defaults for a missing file", () => {
    process.env.TMUX_IDE_CONFIG = join(tmpdir(), "definitely-not-here-zz.json");
    expect(loadAppConfig()).toEqual(DEFAULT_APP_CONFIG);
  });

  it("falls back to defaults for a malformed file", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not valid json ");
    process.env.TMUX_IDE_CONFIG = path;
    expect(loadAppConfig()).toEqual(DEFAULT_APP_CONFIG);
  });

  it("getAppConfig caches until reset", () => {
    process.env.TMUX_IDE_CONFIG = join(tmpdir(), "missing-zz.json");
    _resetForTests();
    const first = getAppConfig();
    expect(first).toEqual(DEFAULT_APP_CONFIG);
    // point at a real custom file, but the cache should still return the first read
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ theme: { accent: "colour200" } }));
    process.env.TMUX_IDE_CONFIG = path;
    expect(getAppConfig().theme.accent).toBe(DEFAULT_APP_CONFIG.theme.accent);
    // reset → re-read picks up the custom file
    _resetForTests();
    expect(getAppConfig().theme.accent).toBe("colour200");
  });
});
