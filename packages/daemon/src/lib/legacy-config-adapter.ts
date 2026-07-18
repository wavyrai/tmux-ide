import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { IdeConfigSchema } from "../schemas/ide-config.ts";
import type { IdeConfig } from "../types.ts";

export function legacyConfigPath(dir: string): string {
  return resolve(dir, "ide.yml");
}

export function hasLegacyConfigAt(dir: string): boolean {
  return existsSync(legacyConfigPath(dir));
}

export function readLegacyConfigFile(path: string): { config: IdeConfig; raw: string } {
  const raw = readFileSync(path, "utf-8");
  return { raw, config: IdeConfigSchema.parse(yaml.load(raw)) };
}

export function readLegacyConfigAt(dir: string): {
  config: IdeConfig;
  configPath: string;
  raw: string;
} {
  const configPath = legacyConfigPath(dir);
  const { raw, config } = readLegacyConfigFile(configPath);
  return { config, configPath, raw };
}
