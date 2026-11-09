/**
 * `<state home>/logs/plugins.log`: one JSON line per plugin log entry, with
 * the same one-generation rotation as the fleet events log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginLogLevel } from "./protocol.ts";

export const PLUGIN_LOG_MAX_BYTES = 1024 * 1024;

export interface PluginLogEntry {
  readonly ts: string;
  readonly plugin: string;
  readonly level: PluginLogLevel;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

export function pluginLogPath(stateHome: string): string {
  return join(stateHome, "logs", "plugins.log");
}

export function appendPluginLog(path: string, entry: PluginLogEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size > PLUGIN_LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // A lost log line is never fatal to the daemon.
  }
}

/** The last `limit` entries, oldest first, optionally for one plugin. */
export function readPluginLog(path: string, options: { limit?: number; plugin?: string } = {}) {
  const limit = options.limit ?? 200;
  const out: PluginLogEntry[] = [];
  for (const file of [`${path}.1`, path]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as PluginLogEntry;
        if (!options.plugin || entry.plugin === options.plugin) out.push(entry);
      } catch {
        // Skip a torn line.
      }
    }
  }
  return out.slice(-limit);
}

export function formatPluginLogEntry(entry: PluginLogEntry): string {
  const time = /T(\d{2}:\d{2}:\d{2})/u.exec(entry.ts)?.[1] ?? entry.ts;
  const fields = entry.fields ? ` ${JSON.stringify(entry.fields)}` : "";
  return `${time} ${entry.plugin} ${entry.level.padEnd(5)} ${entry.message}${fields}`;
}
