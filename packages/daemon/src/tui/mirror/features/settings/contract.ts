import type { AppConfig, AppConfigPatch, AppTheme } from "../../../../lib/app-config.ts";
import type { NotificationPrefs } from "../../../chrome/notify-prefs.ts";
import type { DialogFeatureSession } from "../dialogs/contract.ts";
import type { SettingsCommandId } from "./catalog.ts";

export type SettingsAccentRgb = readonly [red: number, green: number, blue: number];

export interface SettingsFeatureHost {
  readonly dialogs: DialogFeatureSession;
  /** Fresh reads: settings never depend on the process config cache. */
  readonly readConfig: () => AppConfig;
  readonly readNotificationPrefs: () => NotificationPrefs;
  readonly writeConfig: (patch: AppConfigPatch) => AppConfig | void | Promise<AppConfig | void>;
  readonly configureTheme: (theme: AppTheme) => void;
  readonly setPreviewAccent: (rgb: SettingsAccentRgb | null) => void;
  readonly setStatusNote: (note: string) => void;
  readonly kittyKeys: boolean;
  readonly beforeRun?: () => void;
  readonly onError?: (error: Error) => void;
}

export type SettingsRunResult =
  | {
      readonly status: "completed" | "cancelled" | "disposed";
      readonly command: SettingsCommandId;
      readonly changed: boolean;
    }
  | {
      readonly status: "error";
      readonly command: SettingsCommandId;
      readonly changed: boolean;
      readonly error: Error;
    };

export interface SettingsFeatureSession {
  readonly busy: () => boolean;
  readonly disposed: () => boolean;
  readonly run: (command: SettingsCommandId) => Promise<SettingsRunResult>;
  /** Application-teardown disposal; clears the shared modal stack. */
  readonly dispose: () => void;
}
