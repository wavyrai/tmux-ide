/**
 * Unit tests for the global app-config parser + loader.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_APP_CONFIG,
  _resetForTests,
  appConfigPath,
  getAppConfig,
  loadAppConfig,
  mergeConfigPatch,
  parseAppConfig,
  updateAppConfig,
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
    expect(cfg.keys.panels).toEqual(DEFAULT_APP_CONFIG.keys.panels);
    expect(cfg.theme.muted).toBe("colour240");
    expect(cfg.theme.status.working).toBe("colour221");
    expect(cfg.theme.glyphs).toEqual(DEFAULT_APP_CONFIG.theme.glyphs);
    expect(cfg.updater).toEqual(DEFAULT_APP_CONFIG.updater);
  });

  it("defaults the sidebar toggle key to M-b", () => {
    expect(DEFAULT_APP_CONFIG.keys.sidebar).toBe("M-b");
    expect(parseAppConfig(undefined).keys.sidebar).toBe("M-b");
  });

  it("defaults the home cockpit key to M-h", () => {
    expect(DEFAULT_APP_CONFIG.keys.home).toBe("M-h");
    expect(parseAppConfig(undefined).keys.home).toBe("M-h");
  });

  it("overrides the home key while keeping the other chrome keys default", () => {
    const cfg = parseAppConfig({ keys: { home: "M-H" } });
    expect(cfg.keys.home).toBe("M-H");
    expect(cfg.keys.popup).toBe("M-p");
    expect(cfg.keys.cheatsheet).toBe("M-k");
  });

  it("defaults welcome.show to true and coerces a mistyped value back to it", () => {
    expect(DEFAULT_APP_CONFIG.welcome.show).toBe(true);
    expect(parseAppConfig(undefined).welcome.show).toBe(true);
    expect(parseAppConfig({ welcome: { show: "nope" } }).welcome.show).toBe(true);
    // an explicit false is honoured
    expect(parseAppConfig({ welcome: { show: false } }).welcome.show).toBe(false);
  });

  it("defaults integrations.offer to true and coerces a mistyped value back to it", () => {
    expect(DEFAULT_APP_CONFIG.integrations.offer).toBe(true);
    expect(parseAppConfig(undefined).integrations.offer).toBe(true);
    expect(parseAppConfig({ integrations: { offer: "nope" } }).integrations.offer).toBe(true);
    // an explicit false is honoured (suppresses the first-adopt offer popup)
    expect(parseAppConfig({ integrations: { offer: false } }).integrations.offer).toBe(false);
  });

  it("overrides the sidebar key while keeping the other chrome keys default", () => {
    const cfg = parseAppConfig({ keys: { sidebar: "M-B" } });
    expect(cfg.keys.sidebar).toBe("M-B");
    expect(cfg.keys.popup).toBe("M-p");
    expect(cfg.keys.menu).toBe("M-m");
  });

  it("defaults the panel keys to M-e / M-g / M-,", () => {
    expect(DEFAULT_APP_CONFIG.keys.panels).toEqual({
      explorer: "M-e",
      changes: "M-g",
      config: "M-,",
    });
  });

  it("overrides one panel key while keeping the other panels + chrome keys default", () => {
    const cfg = parseAppConfig({ keys: { panels: { explorer: "M-1" } } });
    expect(cfg.keys.panels.explorer).toBe("M-1");
    expect(cfg.keys.panels.changes).toBe("M-g");
    expect(cfg.keys.panels.config).toBe("M-,");
    expect(cfg.keys.popup).toBe("M-p"); // chrome keys untouched
  });

  it("falls back to the default panel keys on mistyped / missing values", () => {
    const cfg = parseAppConfig({ keys: { panels: { explorer: 5, changes: "", config: null } } });
    expect(cfg.keys.panels).toEqual(DEFAULT_APP_CONFIG.keys.panels);
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

  it("worktrees.dir — a non-empty string overrides, anything else stays the empty default", () => {
    expect(parseAppConfig({ worktrees: { dir: "../checkouts" } }).worktrees).toEqual({
      dir: "../checkouts",
    });
    expect(parseAppConfig({ worktrees: { dir: "" } }).worktrees).toEqual(
      DEFAULT_APP_CONFIG.worktrees,
    );
    expect(parseAppConfig({ worktrees: { dir: 42 } }).worktrees).toEqual(
      DEFAULT_APP_CONFIG.worktrees,
    );
    expect(parseAppConfig({ worktrees: "nope" }).worktrees).toEqual(DEFAULT_APP_CONFIG.worktrees);
  });

  it("app.frontDoor — defaults to false and coerces a mistyped value back to it", () => {
    expect(DEFAULT_APP_CONFIG.app.frontDoor).toBe(false);
    expect(parseAppConfig(undefined).app.frontDoor).toBe(false);
    expect(parseAppConfig({ app: { frontDoor: "yes" } }).app.frontDoor).toBe(false);
    expect(parseAppConfig({ app: "nope" }).app.frontDoor).toBe(false);
    // An explicit true opts into the front-door flip.
    expect(parseAppConfig({ app: { frontDoor: true } }).app.frontDoor).toBe(true);
  });

  it("app.detachable — defaults to false and coerces a mistyped value back to it", () => {
    expect(DEFAULT_APP_CONFIG.app.detachable).toBe(false);
    expect(parseAppConfig(undefined).app.detachable).toBe(false);
    expect(parseAppConfig({ app: { detachable: "yes" } }).app.detachable).toBe(false);
    expect(parseAppConfig({ app: "nope" }).app.detachable).toBe(false);
    // An explicit true makes bare `tmux-ide app` run hosted (M23.2).
    expect(parseAppConfig({ app: { detachable: true } }).app.detachable).toBe(true);
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

describe("mergeConfigPatch (pure)", () => {
  it("deep-merges objects, replaces scalars, leaves inputs untouched", () => {
    const raw = { theme: { accent: "colour75", muted: "colour240" }, updates: { check: true } };
    const merged = mergeConfigPatch(raw, { theme: { accent: "colour203" } });
    expect(merged).toEqual({
      theme: { accent: "colour203", muted: "colour240" },
      updates: { check: true },
    });
    expect(raw.theme.accent).toBe("colour75"); // no mutation
  });

  it("preserves keys the patch never names — including unknown user fields", () => {
    const raw = {
      notifications: { enabled: false, quietHours: { start: "22:00", end: "08:00" } },
      customField: [1, 2],
    };
    const merged = mergeConfigPatch(raw, { notifications: { macos: true } });
    expect(merged).toEqual({
      notifications: {
        enabled: false,
        quietHours: { start: "22:00", end: "08:00" },
        macos: true,
      },
      customField: [1, 2],
    });
  });

  it("an explicit undefined DELETES the key (reset semantics); nested too", () => {
    const raw = { theme: { accent: "x" }, notifications: { quietHours: { start: "a", end: "b" } } };
    expect(mergeConfigPatch(raw, { theme: undefined })).toEqual({
      notifications: { quietHours: { start: "a", end: "b" } },
    });
    expect(mergeConfigPatch(raw, { notifications: { quietHours: undefined } })).toEqual({
      theme: { accent: "x" },
      notifications: {},
    });
  });

  it("an object patch over a scalar (or missing) key builds the object", () => {
    expect(mergeConfigPatch({ theme: "broken" }, { theme: { accent: "y" } })).toEqual({
      theme: { accent: "y" },
    });
    expect(mergeConfigPatch({}, { updater: { tickMs: 3000 } })).toEqual({
      updater: { tickMs: 3000 },
    });
  });
});

describe("updateAppConfig (io — atomic write at the override path)", () => {
  let dir: string;
  const savedEnv = process.env.TMUX_IDE_CONFIG;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.TMUX_IDE_CONFIG;
    else process.env.TMUX_IDE_CONFIG = savedEnv;
    _resetForTests();
  });

  it("creates the file (and parent dir) when missing, writing only the patch", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    const path = join(dir, "nested", "config.json");
    process.env.TMUX_IDE_CONFIG = path;
    const cfg = updateAppConfig({ theme: { accent: "colour203" } });
    expect(cfg.theme.accent).toBe("colour203");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ theme: { accent: "colour203" } });
  });

  it("merges over the existing RAW file, preserving fields the typed shape doesn't model", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        notifications: { enabled: false, quietHours: { start: "22:00", end: "08:00" } },
        keys: { popup: "M-o" },
      }),
    );
    process.env.TMUX_IDE_CONFIG = path;
    updateAppConfig({ notifications: { macos: true } });
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.notifications.enabled).toBe(false); // polish-era raw field survives
    expect(raw.notifications.quietHours).toEqual({ start: "22:00", end: "08:00" });
    expect(raw.notifications.macos).toBe(true);
    expect(raw.keys.popup).toBe("M-o");
  });

  it("busts the process cache so getAppConfig sees the write", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    process.env.TMUX_IDE_CONFIG = join(dir, "config.json");
    _resetForTests();
    expect(getAppConfig().updates.check).toBe(true);
    updateAppConfig({ updates: { check: false } });
    expect(getAppConfig().updates.check).toBe(false);
  });

  it("leaves no temp files behind (temp + rename)", () => {
    dir = mkdtempSync(join(tmpdir(), "appcfg-"));
    process.env.TMUX_IDE_CONFIG = join(dir, "config.json");
    updateAppConfig({ updates: { check: false } });
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});
