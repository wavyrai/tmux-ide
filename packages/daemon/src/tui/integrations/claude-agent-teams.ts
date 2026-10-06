/**
 * Claude Code agent teams — opt-out enablement in the user's Claude settings.
 *
 * Agent teams let one Claude Code session spawn teammates; with
 * `teammateMode: "auto"` Claude puts them in split panes when it runs inside
 * tmux (in-process elsewhere), which is exactly what tmux-ide shows and
 * routes. The installer enables this by default and `tmux-ide integration
 * agent-teams enable|disable|status` manages it explicitly.
 *
 * Rules (pure, in {@link mergeAgentTeams}):
 * - `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is set to "1" only when absent.
 *   An explicit off value ("0", "false", false, 0…) is the user's opt-out: the
 *   installer never overrides it and touches nothing else. Only an explicit
 *   `tmux-ide integration agent-teams enable` (overrideOptOut) turns it back on.
 * - `teammateMode: "auto"` is set only when `teammateMode` is absent.
 * - Every other key is preserved. Nothing changed → nothing written.
 *
 * Writes (io) reuse the hooks integration's settings path resolution, including
 * the `TMUX_IDE_CLAUDE_SETTINGS` override: one-time timestamped backup before
 * the first modification, then an atomic temp-file + rename. Invalid JSON is
 * reported and never rewritten.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  copyFileSync,
  unlinkSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { resolveRuntimeNamespace, runtimeOwnedPath } from "../../lib/runtime-namespace.ts";

export const AGENT_TEAMS_ENV = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS";
export const DEFAULT_TEAMMATE_MODE = "auto";
const BACKUP_INFIX = ".tmux-ide-backup-";

type Settings = Record<string, unknown>;

export type AgentTeamsSetting = "enabled" | "disabled-by-user" | "not-configured";

/** PURE — an explicit off value is the user's opt-out. */
export function isOptOut(value: unknown): boolean {
  if (value === false || value === 0) return true;
  return typeof value === "string" && /^\s*(0|false|off|no)\s*$/iu.test(value);
}

function envOf(settings: Settings): Record<string, unknown> | undefined {
  const env = settings.env;
  if (env === undefined) return undefined;
  if (!env || typeof env !== "object" || Array.isArray(env))
    throw new Error("settings env must be an object");
  return env as Record<string, unknown>;
}

/** PURE — how the settings currently stand for agent teams. */
export function agentTeamsSetting(settings: Settings): AgentTeamsSetting {
  const value = envOf(settings)?.[AGENT_TEAMS_ENV];
  if (value === undefined) return "not-configured";
  return isOptOut(value) ? "disabled-by-user" : "enabled";
}

export interface AgentTeamsMerge {
  readonly settings: Settings;
  /** Human-readable `key=value` list of what was set; empty when unchanged. */
  readonly changes: readonly string[];
  readonly setting: AgentTeamsSetting;
}

/**
 * PURE — enable agent teams without overriding anything the user chose, unless
 * `overrideOptOut` (the user explicitly asked to enable) replaces their "0".
 */
export function mergeAgentTeams(
  settings: Settings,
  { overrideOptOut = false }: { readonly overrideOptOut?: boolean } = {},
): AgentTeamsMerge {
  const setting = agentTeamsSetting(settings);
  if (setting === "disabled-by-user" && !overrideOptOut) return { settings, changes: [], setting };
  const changes: string[] = [];
  let next: Settings = settings;
  if (setting !== "enabled") {
    next = { ...next, env: { ...(envOf(settings) ?? {}), [AGENT_TEAMS_ENV]: "1" } };
    changes.push(`env.${AGENT_TEAMS_ENV}=1`);
  }
  if (!("teammateMode" in settings)) {
    next = { ...next, teammateMode: DEFAULT_TEAMMATE_MODE };
    changes.push(`teammateMode=${DEFAULT_TEAMMATE_MODE}`);
  }
  return { settings: next, changes, setting: "enabled" };
}

/** PURE — record an explicit opt-out ("0"), which later enables respect. */
export function disableAgentTeams(settings: Settings): AgentTeamsMerge {
  if (agentTeamsSetting(settings) === "disabled-by-user")
    return { settings, changes: [], setting: "disabled-by-user" };
  return {
    settings: { ...settings, env: { ...(envOf(settings) ?? {}), [AGENT_TEAMS_ENV]: "0" } },
    changes: [`env.${AGENT_TEAMS_ENV}=0`],
    setting: "disabled-by-user",
  };
}

export interface AgentTeamsPaths {
  /** Claude Code's user settings file. */
  readonly settingsPath: string;
  /** Claude Code's home (~/.claude); its presence means Claude is installed. */
  readonly claudeDir: string;
}

export function agentTeamsPaths(): AgentTeamsPaths {
  const namespace = resolveRuntimeNamespace();
  return { settingsPath: namespace.claudeSettingsPath, claudeDir: namespace.claudeDir };
}

/** `claude` on PATH, without spawning anything. */
export function claudeOnPath(path = process.env.PATH ?? ""): boolean {
  return path
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        accessSync(join(dir, "claude"), constants.X_OK);
        return statSync(join(dir, "claude")).isFile();
      } catch {
        return false;
      }
    });
}

export class InvalidClaudeSettingsError extends Error {}

function readSettings(path: string): { settings: Settings; exists: boolean } {
  if (!existsSync(path)) return { settings: {}, exists: false };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    envOf(parsed as Settings);
    return { settings: parsed as Settings, exists: true };
  } catch {
    throw new InvalidClaudeSettingsError(
      `${path} is not valid settings JSON — fix or move it, then retry`,
    );
  }
}

/** Existing one-time backup, if tmux-ide already made one for this file. */
function existingBackup(settingsPath: string): string | null {
  const dir = dirname(settingsPath);
  const prefix = `${basename(settingsPath)}${BACKUP_INFIX}`;
  try {
    const found = readdirSync(dir).find((name) => name.startsWith(prefix));
    return found ? join(dir, found) : null;
  } catch {
    return null;
  }
}

function writeSettings(path: string, settings: Settings, exists: boolean): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (exists) {
    backup = existingBackup(path);
    if (!backup) {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/gu, "")
        .replace(/\.\d+Z$/u, "Z");
      backup = `${path}${BACKUP_INFIX}${stamp}`;
      copyFileSync(path, backup);
    }
  }
  const temporary = join(dirname(path), `.${basename(path)}.tmux-ide-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    if (exists) chmodSync(temporary, statSync(path).mode & 0o777);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* already renamed or never written */
    }
    throw error;
  }
  return backup;
}

export interface AgentTeamsResult {
  readonly action:
    | "enabled"
    | "disabled"
    | "unchanged"
    | "disabled-by-user"
    | "skipped"
    | "invalid";
  readonly settingsPath: string;
  readonly changes: readonly string[];
  readonly backup: string | null;
  readonly claudeDetected: boolean;
  readonly message: string;
}

function detected(paths: AgentTeamsPaths, onPath: () => boolean): boolean {
  return existsSync(paths.claudeDir) || onPath();
}

function guarded(paths: AgentTeamsPaths | undefined): AgentTeamsPaths {
  if (!paths && resolveRuntimeNamespace().development)
    throw new Error("Development agent-teams changes require explicit fixture paths");
  const resolved = paths ?? agentTeamsPaths();
  runtimeOwnedPath(resolved.settingsPath);
  return resolved;
}

/** Enable agent teams when Claude Code is installed and the user hasn't opted out. */
export function enableClaudeAgentTeams(
  paths?: AgentTeamsPaths,
  onPath: () => boolean = () => claudeOnPath(),
  { overrideOptOut = false }: { readonly overrideOptOut?: boolean } = {},
): AgentTeamsResult {
  const resolved = guarded(paths);
  const { settingsPath } = resolved;
  const base = { settingsPath, changes: [], backup: null } as const;
  if (!detected(resolved, onPath))
    return {
      ...base,
      action: "skipped",
      claudeDetected: false,
      message: `Claude Code not found (no ${resolved.claudeDir}, no claude on PATH); agent teams not configured.`,
    };
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(settingsPath);
  } catch (error) {
    return { ...base, action: "invalid", claudeDetected: true, message: (error as Error).message };
  }
  const merged = mergeAgentTeams(read.settings, { overrideOptOut });
  if (merged.setting === "disabled-by-user")
    return {
      ...base,
      action: "disabled-by-user",
      claudeDetected: true,
      message:
        `Claude Code agent teams are disabled by user in ${settingsPath} (${AGENT_TEAMS_ENV}); ` +
        "left unchanged. Enable explicitly: tmux-ide integration agent-teams enable",
    };
  if (merged.changes.length === 0)
    return {
      ...base,
      action: "unchanged",
      claudeDetected: true,
      message: `Claude Code agent teams already enabled in ${settingsPath}.`,
    };
  const backup = writeSettings(settingsPath, merged.settings, read.exists);
  return {
    settingsPath,
    changes: merged.changes,
    backup,
    action: "enabled",
    claudeDetected: true,
    message:
      `Enabled Claude Code agent teams in ${settingsPath} (${merged.changes.join(", ")}` +
      `${backup ? `; backup: ${backup}` : ""}). Disable: tmux-ide integration agent-teams disable`,
  };
}

/** Record the user's opt-out so neither the installer nor `enable` turns it back on silently. */
export function disableClaudeAgentTeams(paths?: AgentTeamsPaths): AgentTeamsResult {
  const resolved = guarded(paths);
  const { settingsPath } = resolved;
  const base = { settingsPath, changes: [], backup: null, claudeDetected: true } as const;
  let read: ReturnType<typeof readSettings>;
  try {
    read = readSettings(settingsPath);
  } catch (error) {
    return { ...base, action: "invalid", message: (error as Error).message };
  }
  const next = disableAgentTeams(read.settings);
  if (next.changes.length === 0)
    return {
      ...base,
      action: "unchanged",
      message: `Claude Code agent teams already disabled in ${settingsPath}.`,
    };
  const backup = writeSettings(settingsPath, next.settings, read.exists);
  return {
    ...base,
    changes: next.changes,
    backup,
    action: "disabled",
    message:
      `Disabled Claude Code agent teams in ${settingsPath} (${next.changes.join(", ")}` +
      `${backup ? `; backup: ${backup}` : ""}). Re-enable: tmux-ide integration agent-teams enable`,
  };
}

export interface AgentTeamsStatus {
  readonly settingsPath: string;
  readonly claudeDetected: boolean;
  readonly setting: AgentTeamsSetting | "invalid-settings";
  readonly teammateMode: string | null;
}

export function claudeAgentTeamsStatus(
  paths: AgentTeamsPaths = agentTeamsPaths(),
  onPath: () => boolean = () => claudeOnPath(),
): AgentTeamsStatus {
  const claudeDetected = detected(paths, onPath);
  try {
    const { settings } = readSettings(paths.settingsPath);
    const mode = settings.teammateMode;
    return {
      settingsPath: paths.settingsPath,
      claudeDetected,
      setting: agentTeamsSetting(settings),
      teammateMode: typeof mode === "string" ? mode : null,
    };
  } catch {
    return {
      settingsPath: paths.settingsPath,
      claudeDetected,
      setting: "invalid-settings",
      teammateMode: null,
    };
  }
}
