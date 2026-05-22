import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface AppSettings {
  remoteAccess: {
    enabled: boolean;
    token: string | null;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  remoteAccess: {
    enabled: false,
    token: null,
  },
};

function settingsDir(): string {
  return process.env.TMUX_IDE_SETTINGS_DIR ?? join(homedir(), ".tmux-ide");
}

export function appSettingsPath(): string {
  return join(settingsDir(), "app-settings.json");
}

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const remote = (value as { remoteAccess?: unknown }).remoteAccess;
  if (!remote || typeof remote !== "object") return structuredClone(DEFAULT_SETTINGS);
  const enabled = (remote as { enabled?: unknown }).enabled === true;
  const rawToken = (remote as { token?: unknown }).token;
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;
  return { remoteAccess: { enabled, token } };
}

export function readAppSettings(): AppSettings {
  const path = appSettingsPath();
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function writeAppSettings(next: AppSettings): void {
  const path = appSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeSettings(next), null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}
