import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APP_CONFIG,
  DEFAULT_KEYS as CHROME_DEFAULT_KEYS,
  _resetForTests,
  parseAppConfig,
  mergeConfigPatch,
  updateAppConfig,
} from "../../lib/app-config.ts";
import {
  DEFAULT_NOTIFICATION_PREFS,
  parseNotificationPrefs,
  readNotificationPrefs,
  type NotificationPrefs,
} from "../chrome/notify.ts";
import { prefixKeyBinds } from "../chrome/statusline.ts";
import {
  PALETTE_KEYCAPS,
  SETTINGS_PALETTE_COMMANDS,
  THEME_PRESETS,
  delaySecondsPatch,
  delaySummary,
  keybindingItems,
  notificationItems,
  notificationTogglePatch,
  prefixTwinFor,
  presetRgb,
  quietHoursItems,
  quietHoursOffPatch,
  quietHoursPatch,
  quietHoursSummary,
  resetSettingsPatch,
  soundItems,
  soundPatch,
  soundSummary,
  validateDelaySeconds,
  restoreItems,
  restorePatch,
  settingsRootItems,
  snapshotEveryPatch,
  themeItems,
  themeModeItems,
  themeModePatch,
  themePatch,
  tickMsPatch,
  updatesCheckPatch,
  updatesItems,
  validateQuietTime,
  validateSnapshotEvery,
  validateTickMs,
} from "./settings-model.ts";

const CFG = DEFAULT_APP_CONFIG;
const PREFS = DEFAULT_NOTIFICATION_PREFS;

describe("palette registry", () => {
  it("offers the umbrella first, then one command per setting, all Settings-prefixed", () => {
    expect(SETTINGS_PALETTE_COMMANDS[0]).toEqual({ id: "settings", label: "Settings…" });
    for (const c of SETTINGS_PALETTE_COMMANDS.slice(1)) {
      expect(c.label.startsWith("Settings: ")).toBe(true);
    }
    expect(new Set(SETTINGS_PALETTE_COMMANDS.map((c) => c.id)).size).toBe(
      SETTINGS_PALETTE_COMMANDS.length,
    );
  });
});

describe("theme", () => {
  it("marks the saved accent as current; the default config marks the default preset", () => {
    const rows = themeItems(CFG);
    expect(rows).toHaveLength(THEME_PRESETS.length);
    expect(rows.find((r) => r.current)?.id).toBe("colour75");
    expect(rows.every((r) => r.swatch !== undefined)).toBe(true);
  });
  it("keeps a hand-edited accent visible as a Custom current row", () => {
    const rows = themeItems(parseAppConfig({ theme: { accent: "colour99" } }));
    expect(rows[0]).toMatchObject({ id: "colour99", label: "Custom", current: true });
    expect(rows).toHaveLength(THEME_PRESETS.length + 1);
  });
  it("patch writes only theme.accent; presetRgb resolves known accents", () => {
    expect(themePatch("colour203")).toEqual({ theme: { accent: "colour203" } });
    expect(presetRgb("colour203")).toEqual([255, 95, 95]);
    expect(presetRgb("colour99")).toBeNull();
  });
  it("offers dark/light/system mode rows and persists only theme.mode", () => {
    expect(themeModeItems(CFG).map((row) => [row.id, row.current, row.detail])).toEqual([
      ["dark", true, "dark palette"],
      ["light", false, "light palette"],
      ["system", false, "follow terminal theme_mode"],
    ]);
    const system = parseAppConfig({ theme: { mode: "system" } });
    expect(themeModeItems(system).find((row) => row.current)?.id).toBe("system");
    expect(themeModePatch("light")).toEqual({ theme: { mode: "light" } });
  });
});

describe("notifications", () => {
  it("lists the REAL fields notify.ts reads, with on/off details", () => {
    const rows = notificationItems(PREFS);
    expect(rows.map((r) => r.id)).toEqual([
      "enabled",
      "toast",
      "macos",
      "terminal",
      "onBlocked",
      "onDone",
      "sound",
      "delaySeconds",
      "quietHours",
    ]);
    expect(rows.find((r) => r.id === "macos")?.detail).toBe("off");
    expect(rows.find((r) => r.id === "terminal")?.detail).toBe("on");
    expect(rows.find((r) => r.id === "sound")?.detail).toBe("when blocked");
    expect(rows.find((r) => r.id === "delaySeconds")?.detail).toBe("2 s");
    expect(rows.find((r) => r.id === "quietHours")?.detail).toBe("off");
  });
  it("toggle patches flip the current value and survive the raw round-trip", () => {
    expect(notificationTogglePatch("macos", PREFS)).toEqual({ notifications: { macos: true } });
    expect(notificationTogglePatch("terminal", PREFS)).toEqual({
      notifications: { terminal: false },
    });
    const raw = mergeConfigPatch({}, notificationTogglePatch("onBlocked", PREFS));
    expect(parseNotificationPrefs(raw).onBlocked).toBe(false);
  });
  it("sound: summary words, chooser marking, patch round-trip", () => {
    expect(soundSummary(PREFS)).toBe("when blocked");
    expect(soundSummary({ ...PREFS, sound: "all" })).toBe("always");
    expect(soundSummary({ ...PREFS, sound: "none" })).toBe("off");
    expect(soundItems(PREFS).find((i) => i.current)?.id).toBe("blocked");
    expect(soundItems({ ...PREFS, sound: "none" }).find((i) => i.current)?.id).toBe("none");
    const raw = mergeConfigPatch({}, soundPatch("all"));
    expect(parseNotificationPrefs(raw).sound).toBe("all");
  });
  it("delay: summary, 0–60 whole-second validation, patch round-trip (0 = immediate)", () => {
    expect(delaySummary(PREFS)).toBe("2 s");
    expect(delaySummary({ ...PREFS, delaySeconds: 0 })).toBe("immediately");
    expect(validateDelaySeconds("0")).toBeNull();
    expect(validateDelaySeconds(" 60 ")).toBeNull();
    expect(validateDelaySeconds("61")).toContain("between 0 and 60");
    expect(validateDelaySeconds("2.5")).toContain("whole number");
    expect(validateDelaySeconds("soon")).toContain("whole number");
    const raw = mergeConfigPatch({}, delaySecondsPatch(" 5 "));
    expect(parseNotificationPrefs(raw).delaySeconds).toBe(5);
    expect(parseNotificationPrefs(mergeConfigPatch(raw, delaySecondsPatch("0"))).delaySeconds).toBe(
      0,
    );
  });
  it("quiet hours: summary, chooser marking, HH:MM validation, on/off patches", () => {
    const withWindow: NotificationPrefs = {
      ...PREFS,
      quietHours: { start: "22:00", end: "08:00" },
    };
    expect(quietHoursSummary(withWindow)).toBe("22:00–08:00");
    expect(quietHoursItems(PREFS).find((i) => i.current)?.id).toBe("off");
    expect(quietHoursItems(withWindow).find((i) => i.current)?.id).toBe("window");
    expect(validateQuietTime("22:00")).toBeNull();
    expect(validateQuietTime(" 08:30 ")).toBeNull();
    expect(validateQuietTime("25:00")).toContain("HH:MM");
    expect(validateQuietTime("8pm")).toContain("HH:MM");
    expect(quietHoursPatch(" 22:00", "08:00 ")).toEqual({
      notifications: { quietHours: { start: "22:00", end: "08:00" } },
    });
    // the off patch DELETES the key (notify treats missing as "no window")
    const raw = mergeConfigPatch(
      { notifications: { quietHours: { start: "22:00", end: "08:00" } } },
      quietHoursOffPatch(),
    );
    expect(parseNotificationPrefs(raw).quietHours).toBeNull();
  });
});

describe("updates & cadence", () => {
  it("rows show the live values; the check toggle flips", () => {
    const rows = updatesItems(CFG);
    expect(rows.find((r) => r.id === "check")?.detail).toBe("on");
    expect(rows.find((r) => r.id === "tickMs")?.detail).toBe("2000 ms");
    expect(rows.find((r) => r.id === "snapshotEvery")?.detail).toBe("15 refreshes");
    expect(updatesCheckPatch(CFG)).toEqual({ updates: { check: false } });
  });
  it("validators guard honest bounds with plain errors", () => {
    expect(validateTickMs("2000")).toBeNull();
    expect(validateTickMs("250")).toBeNull();
    expect(validateTickMs("100")).toContain("between 250 and 60000");
    expect(validateTickMs("2.5")).toContain("whole number");
    expect(validateTickMs("fast")).toContain("whole number");
    expect(validateSnapshotEvery("15")).toBeNull();
    expect(validateSnapshotEvery("0")).toContain("between 1 and 1000");
  });
  it("number patches parse the trimmed value", () => {
    expect(tickMsPatch(" 3000 ")).toEqual({ updater: { tickMs: 3000 } });
    expect(snapshotEveryPatch("20")).toEqual({ updater: { snapshotEvery: 20 } });
  });
});

describe("crash restore", () => {
  it("marks the current mode and patches the boolean", () => {
    expect(restoreItems(CFG).find((r) => r.current)?.id).toBe("off");
    const on = parseAppConfig({ restore: { resumeAgents: true } });
    expect(restoreItems(on).find((r) => r.current)?.id).toBe("on");
    expect(restorePatch("on")).toEqual({ restore: { resumeAgents: true } });
    expect(restorePatch("off")).toEqual({ restore: { resumeAgents: false } });
  });
});

describe("keybinding viewer", () => {
  it("agrees with the chrome's prefixKeyBinds derivation for the default keys (drift guard)", () => {
    const fromChrome = new Set(prefixKeyBinds(CHROME_DEFAULT_KEYS).map((b) => b.pkey));
    const alts = [
      CHROME_DEFAULT_KEYS.home,
      CHROME_DEFAULT_KEYS.popup,
      CHROME_DEFAULT_KEYS.cheatsheet,
      CHROME_DEFAULT_KEYS.menu,
      CHROME_DEFAULT_KEYS.sidebar,
      CHROME_DEFAULT_KEYS.panels.explorer,
      CHROME_DEFAULT_KEYS.panels.changes,
      CHROME_DEFAULT_KEYS.panels.config,
    ];
    const fromModel = new Set(alts.map(prefixTwinFor).filter((l): l is string => l !== null));
    expect(fromModel).toEqual(fromChrome);
  });
  it("shows prefix-first details from the LIVE config and skips twins for taken letters", () => {
    const rows = keybindingItems(CHROME_DEFAULT_KEYS);
    expect(rows.find((r) => r.label === "Actions menu")?.detail).toBe("prefix u · M-m");
    expect(rows.find((r) => r.label === "Session switcher")?.detail).toBe("prefix j · M-p");
    // a rebind to a taken letter loses its twin but still shows the alt key
    const rebound = { ...CHROME_DEFAULT_KEYS, home: "M-c" };
    expect(keybindingItems(rebound).find((r) => r.label === "Home cockpit")?.detail).toBe("M-c");
    // the app's fixed keys are listed after the chrome rows
    expect(rows.some((r) => r.id === "app:Command palette")).toBe(true);
  });
  it("appends the kitty ⌘K fast path to the palette row only when enabled (M24.4)", () => {
    const off = keybindingItems(CHROME_DEFAULT_KEYS);
    expect(off.find((r) => r.id === "app:Command palette")?.detail).toBe("F5 · ^p");
    const on = keybindingItems(CHROME_DEFAULT_KEYS, true);
    expect(on.find((r) => r.id === "app:Command palette")?.detail).toBe("F5 · ^p · ⌘K");
    // no other row changes
    expect(on.filter((r) => r.detail?.includes("⌘K"))).toHaveLength(1);
  });
});

describe("PALETTE_KEYCAPS (M24.4 — the palette rows' shortcut source)", () => {
  it("maps exactly the actions the viewer enumerates with palette keys", () => {
    expect(PALETTE_KEYCAPS).toEqual({
      "tab:home": "F1",
      "tab:terminal": "F2",
      "tab:files": "F3",
      "tab:diff": "F4",
      save: "^s",
      quit: "^q",
    });
  });
  it("agrees with the viewer rows (single source — no drift)", () => {
    const rows = keybindingItems(CHROME_DEFAULT_KEYS);
    for (const keycap of Object.values(PALETTE_KEYCAPS)) {
      expect(rows.some((r) => r.detail === keycap)).toBe(true);
    }
  });
});

describe("umbrella + reset", () => {
  it("summarizes every command with its current value; reset is the one danger row", () => {
    const rows = settingsRootItems(CFG, PREFS);
    expect(rows.map((r) => r.id)).toEqual([
      "settings-theme",
      "settings-notifications",
      "settings-quiet-hours",
      "settings-updates",
      "settings-restore",
      "settings-keys",
      "settings-reset",
    ]);
    expect(rows.find((r) => r.id === "settings-theme")?.detail).toBe("Sky blue");
    expect(rows.find((r) => r.id === "settings-quiet-hours")?.detail).toBe("off");
    expect(rows.filter((r) => r.danger).map((r) => r.id)).toEqual(["settings-reset"]);
  });
  it("reset DELETES the managed blocks but preserves keys and unknown fields", () => {
    const raw = {
      theme: { accent: "colour203" },
      notifications: { macos: true, quietHours: { start: "22:00", end: "08:00" } },
      updater: { tickMs: 5000 },
      updates: { check: false },
      restore: { resumeAgents: true },
      keys: { popup: "M-o" },
      somethingUserAdded: { keep: "me" },
    };
    const merged = mergeConfigPatch(raw, resetSettingsPatch());
    expect(merged).toEqual({ keys: { popup: "M-o" }, somethingUserAdded: { keep: "me" } });
    expect(parseAppConfig(merged).theme.accent).toBe(CFG.theme.accent);
    expect(parseAppConfig(merged).keys.popup).toBe("M-o");
  });
});

describe("M25.2 channel fields round-trip through the real config file", () => {
  let dir: string | null = null;
  const savedEnv = process.env.TMUX_IDE_CONFIG;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.TMUX_IDE_CONFIG;
    else process.env.TMUX_IDE_CONFIG = savedEnv;
    _resetForTests();
  });

  it("the dialogs' patches land in the file and read back through the live prefs path", () => {
    dir = mkdtempSync(join(tmpdir(), "settings-m252-"));
    process.env.TMUX_IDE_CONFIG = join(dir, "config.json");
    _resetForTests();
    updateAppConfig(notificationTogglePatch("terminal", DEFAULT_NOTIFICATION_PREFS));
    updateAppConfig(soundPatch("all"));
    updateAppConfig(delaySecondsPatch("7"));
    const prefs = readNotificationPrefs();
    expect(prefs.terminal).toBe(false);
    expect(prefs.sound).toBe("all");
    expect(prefs.delaySeconds).toBe(7);
    // and the settings rows render the persisted values
    const rows = notificationItems(prefs);
    expect(rows.find((r) => r.id === "terminal")?.detail).toBe("off");
    expect(rows.find((r) => r.id === "sound")?.detail).toBe("always");
    expect(rows.find((r) => r.id === "delaySeconds")?.detail).toBe("7 s");
  });
});
