import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import yaml from "js-yaml";
import type { IdeConfig } from "../types.ts";

export function readConfig(dir: string): { config: IdeConfig; configPath: string } {
  const configPath = resolve(dir, "ide.yml");
  const raw = readFileSync(configPath, "utf-8");
  const config = yaml.load(raw) as IdeConfig;
  return { config, configPath };
}

export function writeConfig(dir: string, config: IdeConfig): string {
  const configPath = resolve(dir, "ide.yml");
  const out = yaml.dump(config, { lineWidth: -1, noRefs: true, quotingType: '"' });
  writeFileSync(configPath, out);
  return configPath;
}

export function getSessionName(dir: string): { name: string; source: "config" | "fallback" } {
  try {
    const { config } = readConfig(dir);
    return { name: config.name ?? basename(dir), source: config.name ? "config" : "fallback" };
  } catch {
    return { name: basename(dir), source: "fallback" };
  }
}
