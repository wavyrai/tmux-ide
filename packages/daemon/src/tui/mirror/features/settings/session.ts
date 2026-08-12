import type { AppConfigPatch } from "../../../../lib/app-config.ts";
import {
  HINT_CHROME_RESTART,
  HINT_LIVE,
  HINT_READOPT,
  delaySecondsPatch,
  keybindingItems,
  notificationItems,
  notificationTogglePatch,
  presetRgb,
  quietHoursItems,
  quietHoursOffPatch,
  quietHoursPatch,
  resetSettingsPatch,
  restoreItems,
  restorePatch,
  settingsRootItems,
  snapshotEveryPatch,
  soundItems,
  soundPatch,
  themeItems,
  themePatch,
  tickMsPatch,
  updatesCheckPatch,
  updatesItems,
  validateDelaySeconds,
  validateQuietTime,
  validateSnapshotEvery,
  validateTickMs,
  type NotificationToggleId,
} from "../../settings-model.ts";
import type { DialogSelectResult } from "../../dialog-model.ts";
import type { SettingsCommandId } from "./catalog.ts";
import type { SettingsFeatureHost, SettingsFeatureSession, SettingsRunResult } from "./contract.ts";

const DISPOSED = Symbol("settings-feature-disposed");

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value || "Settings failed"));
}

/** Async settings flow controller. All IO and modal authority are injected. */
export function createSettingsFeatureSession(host: SettingsFeatureHost): SettingsFeatureSession {
  let isDisposed = false;
  let generation = 0;
  let activeRun: Promise<SettingsRunResult> | null = null;

  const current = (runGeneration: number) => !isDisposed && generation === runGeneration;

  const execute = async (
    command: SettingsCommandId,
    runGeneration: number,
  ): Promise<SettingsRunResult> => {
    let changed = false;
    const assertCurrent = () => {
      if (!current(runGeneration)) throw DISPOSED;
    };
    const waitFor = async <Value>(promise: Promise<Value>): Promise<Value> => {
      const value = await promise;
      assertCurrent();
      return value;
    };
    const persist = async (patch: AppConfigPatch): Promise<void> => {
      assertCurrent();
      await host.writeConfig(patch);
      assertCurrent();
      changed = true;
    };

    const runThemePicker = async (): Promise<boolean> => {
      const config = host.readConfig();
      const before = config.theme.accent;
      const rgbOf = (accent: string) => presetRgb(accent);
      host.setPreviewAccent(rgbOf(before));
      let committed = false;
      try {
        const choice = await waitFor(
          host.dialogs.select({
            title: "Accent color",
            items: themeItems(config),
            footerHint: "live preview · updates chrome + terminal palette",
            onMove: (item) => {
              if (!current(runGeneration)) return;
              host.setPreviewAccent(rgbOf(item.id));
              host.configureTheme({ ...config.theme, accent: item.id });
            },
          }),
        );
        if (!choice) {
          host.configureTheme(config.theme);
          return false;
        }
        if (choice.item.id !== before) {
          await persist(themePatch(choice.item.id));
          host.configureTheme({ ...config.theme, accent: choice.item.id });
          host.setStatusNote("accent saved — chrome and terminals updated");
        }
        committed = true;
        return true;
      } finally {
        host.setPreviewAccent(null);
        if (!committed) host.configureTheme(config.theme);
      }
    };

    const runQuietHours = async (): Promise<boolean> => {
      const prefs = host.readNotificationPrefs();
      const choice = await waitFor(
        host.dialogs.select({
          title: "Quiet hours",
          items: quietHoursItems(prefs),
          footerHint: "silences banners, sounds & bells during the window",
        }),
      );
      if (!choice) return false;
      if (choice.item.id === "off") {
        await persist(quietHoursOffPatch());
        host.setStatusNote(`quiet hours off — ${HINT_LIVE}`);
        return true;
      }
      const start = await waitFor(
        host.dialogs.prompt({
          title: "Quiet hours — start time",
          placeholder: "22:00",
          initial: prefs.quietHours?.start ?? "",
          validate: validateQuietTime,
          footerHint: "24-hour clock, HH:MM",
        }),
      );
      if (start === null) return false;
      const end = await waitFor(
        host.dialogs.prompt({
          title: "Quiet hours — end time",
          placeholder: "08:00",
          initial: prefs.quietHours?.end ?? "",
          validate: validateQuietTime,
          footerHint: "24-hour clock, HH:MM",
        }),
      );
      if (end === null) return false;
      await persist(quietHoursPatch(start, end));
      host.setStatusNote(`quiet hours ${start.trim()}–${end.trim()} — ${HINT_LIVE}`);
      return true;
    };

    const runNotificationToggles = async (): Promise<boolean> => {
      let selected: number | undefined;
      for (;;) {
        const prefs = host.readNotificationPrefs();
        const items = notificationItems(prefs);
        const choice = await waitFor(
          host.dialogs.select({
            title: "Notifications",
            items,
            initialSel: selected,
            footerHint: `enter toggles · ${HINT_LIVE}`,
          }),
        );
        if (!choice) return false;
        selected = items.findIndex((item) => item.id === choice.item.id);
        if (choice.item.id === "quietHours") {
          await runQuietHours();
          continue;
        }
        if (choice.item.id === "sound") {
          const picked = await waitFor(
            host.dialogs.select({
              title: "Notification sound",
              items: soundItems(prefs),
              footerHint: HINT_LIVE,
            }),
          );
          if (picked) {
            await persist(soundPatch(picked.item.id));
            host.setStatusNote(`sound: ${picked.item.label} — ${HINT_LIVE}`);
          }
          continue;
        }
        if (choice.item.id === "delaySeconds") {
          const value = await waitFor(
            host.dialogs.prompt({
              title: "Alert delay (seconds)",
              initial: String(prefs.delaySeconds),
              validate: validateDelaySeconds,
              footerHint: `waits, then re-checks the agent still needs you · ${HINT_LIVE}`,
            }),
          );
          if (value !== null) {
            await persist(delaySecondsPatch(value));
            host.setStatusNote(`alert delay ${value.trim()} s — ${HINT_LIVE}`);
          }
          continue;
        }
        const id = choice.item.id as NotificationToggleId;
        await persist(notificationTogglePatch(id, prefs));
        host.setStatusNote(`${choice.item.label}: ${prefs[id] ? "off" : "on"} — ${HINT_LIVE}`);
      }
    };

    const runUpdatesSettings = async (): Promise<boolean> => {
      let selected: number | undefined;
      for (;;) {
        const config = host.readConfig();
        const items = updatesItems(config);
        const choice = await waitFor(
          host.dialogs.select({
            title: "Updates & background refresh",
            items,
            initialSel: selected,
            footerHint: HINT_CHROME_RESTART,
          }),
        );
        if (!choice) return false;
        selected = items.findIndex((item) => item.id === choice.item.id);
        if (choice.item.id === "check") {
          await persist(updatesCheckPatch(config));
          host.setStatusNote(
            `update checks ${config.updates.check ? "off" : "on"} — ${HINT_CHROME_RESTART}`,
          );
          continue;
        }
        if (choice.item.id === "tickMs") {
          const value = await waitFor(
            host.dialogs.prompt({
              title: "Background refresh interval (ms)",
              initial: String(config.updater.tickMs),
              validate: validateTickMs,
              footerHint: HINT_CHROME_RESTART,
            }),
          );
          if (value !== null) {
            await persist(tickMsPatch(value));
            host.setStatusNote(`refresh every ${value.trim()} ms — ${HINT_CHROME_RESTART}`);
          }
          continue;
        }
        if (choice.item.id === "snapshotEvery") {
          const value = await waitFor(
            host.dialogs.prompt({
              title: "Save a crash snapshot every … refreshes",
              initial: String(config.updater.snapshotEvery),
              validate: validateSnapshotEvery,
              footerHint: HINT_CHROME_RESTART,
            }),
          );
          if (value !== null) {
            await persist(snapshotEveryPatch(value));
            host.setStatusNote(`snapshot every ${value.trim()} refreshes — ${HINT_CHROME_RESTART}`);
          }
          continue;
        }
      }
    };

    const runRestoreSetting = async (): Promise<boolean> => {
      const choice = await waitFor(
        host.dialogs.select({
          title: "Crash restore",
          items: restoreItems(host.readConfig()),
          footerHint: "used by tmux-ide restore — takes effect next restore",
        }),
      );
      if (!choice) return false;
      await persist(restorePatch(choice.item.id));
      host.setStatusNote(
        choice.item.id === "on"
          ? "restore will revive agents — takes effect next restore"
          : "restore rebuilds sessions only — takes effect next restore",
      );
      return true;
    };

    const runKeybindViewer = async (): Promise<boolean> => {
      await waitFor(
        host.dialogs.select({
          title: "Keyboard shortcuts",
          items: keybindingItems(host.readConfig().keys, host.kittyKeys),
          footerHint: "read-only — edit keys.* in ~/.tmux-ide/config.json",
        }),
      );
      return false;
    };

    const runSettingsReset = async (): Promise<boolean> => {
      const confirmed = await waitFor(
        host.dialogs.confirm({
          title: "Reset settings to defaults?",
          body:
            "Theme, notifications, updates and restore go back to their defaults. " +
            "Your key bindings and anything else in config.json stay as they are.",
          yesLabel: "Reset settings",
          noLabel: "Keep my settings",
          defaultNo: true,
        }),
      );
      if (!confirmed) return false;
      await persist(resetSettingsPatch());
      host.setStatusNote(`settings reset to defaults — ${HINT_READOPT}`);
      return true;
    };

    const runLeaf = (id: SettingsCommandId): Promise<boolean> => {
      switch (id) {
        case "settings-theme":
          return runThemePicker();
        case "settings-notifications":
          return runNotificationToggles();
        case "settings-quiet-hours":
          return runQuietHours();
        case "settings-updates":
          return runUpdatesSettings();
        case "settings-restore":
          return runRestoreSetting();
        case "settings-keys":
          return runKeybindViewer();
        case "settings-reset":
          return runSettingsReset();
        default:
          return Promise.resolve(true);
      }
    };

    try {
      host.beforeRun?.();
      if (command !== "settings") {
        const completed = await runLeaf(command);
        return { status: completed ? "completed" : "cancelled", command, changed };
      }
      for (;;) {
        const choice: DialogSelectResult | null = await waitFor(
          host.dialogs.select({
            title: "Settings",
            items: settingsRootItems(host.readConfig(), host.readNotificationPrefs()),
            footerHint: "type to filter",
          }),
        );
        if (!choice) return { status: "cancelled", command, changed };
        if (await runLeaf(choice.item.id as SettingsCommandId)) {
          return { status: "completed", command, changed };
        }
      }
    } catch (error) {
      if (error === DISPOSED) return { status: "disposed", command, changed };
      const normalized = asError(error);
      host.setPreviewAccent(null);
      host.onError?.(normalized);
      return { status: "error", command, changed, error: normalized };
    }
  };

  const session: SettingsFeatureSession = {
    busy: () => activeRun !== null,
    disposed: () => isDisposed,
    run(command) {
      if (isDisposed) {
        return Promise.resolve({ status: "disposed", command, changed: false });
      }
      if (activeRun) return activeRun;
      const runGeneration = ++generation;
      activeRun = execute(command, runGeneration).finally(() => {
        if (generation === runGeneration) activeRun = null;
      });
      return activeRun;
    },
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      generation += 1;
      if (activeRun) host.dialogs.clear();
      activeRun = null;
      host.setPreviewAccent(null);
    },
  };
  return Object.freeze(session);
}
