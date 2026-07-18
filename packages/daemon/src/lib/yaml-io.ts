import type { IdeConfig } from "../types.ts";
import {
  getSessionNameCompatSync,
  readConfigCompatSync,
  writeLaunchProjectionConfig,
} from "./resolved-config.ts";

export function readConfig(dir: string): { config: IdeConfig; configPath: string } {
  return readConfigCompatSync(dir);
}

export function writeConfig(dir: string, config: IdeConfig): string {
  return writeLaunchProjectionConfig(dir, config);
}

export function getSessionName(dir: string): { name: string; source: "config" | "fallback" } {
  return getSessionNameCompatSync(dir);
}
