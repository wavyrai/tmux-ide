import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import yaml from "js-yaml";

export function readConfig(dir) {
  const configPath = resolve(dir, "ide.yml");
  const raw = readFileSync(configPath, "utf-8");
  const config = yaml.load(raw);
  return { config, configPath };
}

export function writeConfig(dir, config) {
  const configPath = resolve(dir, "ide.yml");
  const out = yaml.dump(config, { lineWidth: -1, noRefs: true, quotingType: '"' });
  writeFileSync(configPath, out);
  return configPath;
}

export function getSessionName(dir) {
  try {
    const { config } = readConfig(dir);
    return { name: config.name ?? basename(dir), source: config.name ? "config" : "fallback" };
  } catch {
    return { name: basename(dir), source: "fallback" };
  }
}
