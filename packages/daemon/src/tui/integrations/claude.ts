/**
 * Claude Code integration — the authoritative detection layer.
 *
 * Claude Code has a first-class hooks system. `tmux-ide integration install
 * claude` writes a tiny POSIX hook script and registers it in the user's
 * `~/.claude/settings.json` for the lifecycle events we care about. Each hook
 * invocation stamps the CURRENT tmux pane with a pane-local user option:
 *
 *   @agent_state       "<working|blocked|done|idle>:<unix epoch>"
 *   @agent_session_id  the Claude session id (future: --resume on restore)
 *
 * The detector treats a fresh `@agent_state` as GROUND TRUTH and only falls
 * back to screen-manifest scraping when no authority is present — the same
 * two-layer model the best agent terminals use. Any other agent can join the
 * authority layer by writing the same option (`tmux -S "$socket" set-option -p
 * @agent_state working:$(date +%s)`) — no integration required.
 *
 * The settings merge is surgical and reversible: entries are tagged by the
 * hook-script path, a one-time backup is written next to settings.json, and
 * uninstall removes exactly our entries.
 */
import {
  accessSync,
  constants,
  statSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { shellEscape } from "../../lib/shell.ts";

/** Marker every installed hook command contains — the removal key. */
export const HOOK_SCRIPT_RELPATH = ".tmux-ide/hooks/claude-state.sh";

export function hookScriptPath(): string {
  return join(homedir(), HOOK_SCRIPT_RELPATH);
}

/**
 * Absolute path to Claude Code's settings file: `TMUX_IDE_CLAUDE_SETTINGS` when
 * set (tests / per-run overrides), else `~/.claude/settings.json`. The override
 * lets install/offer flows be exercised against a scratch file so a test never
 * reads or rewrites the user's real settings.
 */
export function claudeSettingsPath(): string {
  return process.env.TMUX_IDE_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

/**
 * The hook script. POSIX sh, no dependencies. Claude Code passes the event
 * payload as JSON on stdin; the state to report comes in as $1 (each settings
 * entry passes its own state, so the script never parses the event name).
 * Outside tmux ($TMUX_PANE unset) it exits quietly. The session id is
 * extracted with sed — good enough for a flat JSON string field.
 */
export const HOOK_SCRIPT = `#!/bin/sh
# tmux-ide agent-state hook (installed by: tmux-ide integration install claude)
# $1 = state to report: working | blocked | done | idle
state="\${1:-idle}"
case "$state" in working|blocked|done|idle) ;; *) exit 0 ;; esac
# Hooks run without a controlling terminal. Never guess the default server.
[ -n "$TMUX_PANE" ] || exit 0
case "$TMUX_PANE" in %*) pane_number="\${TMUX_PANE#%}" ;; *) exit 0 ;; esac
case "$pane_number" in ''|*[!0-9]*) exit 0 ;; esac
index="\${TMUX##*,}"
rest="\${TMUX%,*}"
server_pid="\${rest##*,}"
socket="\${rest%,*}"
case "$index" in ''|*[!0-9]*) exit 0 ;; esac
case "$server_pid" in ''|*[!0-9]*) exit 0 ;; esac
case "$socket" in /*) ;; *) exit 0 ;; esac
[ "$rest" != "$TMUX" ] && [ "$socket" != "$rest" ] || exit 0
# A reused socket and pane number must not accept a hook from the old server.
observed_pid="$(tmux -S "$socket" display-message -p -t "$TMUX_PANE" '#{pid}' 2>/dev/null)" || exit 0
[ "$observed_pid" = "$server_pid" ] || exit 0
payload="$(cat 2>/dev/null || true)"
tmux -S "$socket" set-option -p -t "$TMUX_PANE" @agent_state "\${state}:$(date +%s)" 2>/dev/null || exit 0
tmux -S "$socket" set-option -p -t "$TMUX_PANE" @agent_hint "claude" 2>/dev/null || true
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
case "$sid" in ''|*[!A-Za-z0-9_-]*) exit 0 ;; esac
tmux -S "$socket" set-option -p -t "$TMUX_PANE" @agent_session_id "$sid" 2>/dev/null
exit 0
`;

/** Claude Code lifecycle events → the state each reports. */
export const EVENT_STATES: Array<{ event: string; state: string; matcher?: string }> = [
  { event: "UserPromptSubmit", state: "working" },
  { event: "PreToolUse", state: "working", matcher: "*" },
  // Notification also includes idle/auth/completion messages, which are not blocked.
  {
    event: "Notification",
    state: "blocked",
    matcher: "^(permission_prompt|elicitation_dialog|elicitation_url_dialog)$",
  },
  { event: "Stop", state: "done" },
  { event: "SessionEnd", state: "idle" },
];

interface HookCommand {
  type: string;
  command?: string;
  [key: string]: unknown;
}
interface HookGroup {
  [key: string]: unknown;
  matcher?: string;
  hooks: HookCommand[];
}
type HooksConfig = Record<string, HookGroup[]>;
export type ClaudeSettings = Record<string, unknown> & { hooks?: HooksConfig };

/** Match only generated direct commands, never a substring in someone else's hook. */
function ownedCommand(hook: HookCommand, scriptPath?: string): boolean {
  if (hook.type !== "command" || typeof hook.command !== "string") return false;
  const match = /^(.*) (working|blocked|done|idle)$/u.exec(hook.command);
  if (!match) return false;
  const word = match[1]!;
  // Repair the exact old unquoted command, including broken space-containing paths.
  if (scriptPath && (word === scriptPath || word === shellEscape(scriptPath))) return true;
  const decoded =
    word.startsWith("'") && word.endsWith("'") ? word.slice(1, -1).replaceAll("'\\''", "'") : word;
  if (!isAbsolute(decoded) || !decoded.endsWith(`/${HOOK_SCRIPT_RELPATH}`)) return false;
  return word === shellEscape(decoded) || (!/[\s'";$`\\|&<>]/u.test(word) && word === decoded);
}

function strippedGroup(group: HookGroup, scriptPath?: string): HookGroup | null {
  const hooks = group.hooks.filter((hook) => !ownedCommand(hook, scriptPath));
  return hooks.length ? { ...group, hooks } : null;
}

/** PURE — repair only our commands, retaining mixed groups and their metadata. */
export function mergeHooks(settings: ClaudeSettings, scriptPath: string): ClaudeSettings {
  const clean = removeHooks(settings, scriptPath);
  const next: ClaudeSettings = { ...clean, hooks: { ...(clean.hooks ?? {}) } };
  for (const { event, state, matcher } of EVENT_STATES) {
    next.hooks![event] = [
      ...(next.hooks![event] ?? []),
      {
        ...(matcher !== undefined ? { matcher } : {}),
        hooks: [{ type: "command", command: `${shellEscape(scriptPath)} ${state}`, timeout: 5 }],
      },
    ];
  }
  return next;
}

/** PURE — remove our commands, preserving unrelated commands in the same group. */
export function removeHooks(settings: ClaudeSettings, scriptPath?: string): ClaudeSettings {
  if (!settings.hooks) return { ...settings };
  const hooks: HooksConfig = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map((group) => strippedGroup(group, scriptPath))
      .filter((group): group is HookGroup => group !== null);
    if (kept.length) hooks[event] = kept;
  }
  const next: ClaudeSettings = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/** Registration presence only; use claudeIntegrationStatus for readiness. */
export function isInstalled(settings: ClaudeSettings, scriptPath?: string): boolean {
  return Object.values(settings.hooks ?? {}).some((groups) =>
    groups.some((group) => group.hooks.some((hook) => ownedCommand(hook, scriptPath))),
  );
}

export interface ClaudeIntegrationPaths {
  scriptPath: string;
  settingsPath: string;
}
function integrationPaths(): ClaudeIntegrationPaths {
  return { scriptPath: hookScriptPath(), settingsPath: claudeSettingsPath() };
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("settings must be an object");
    if (parsed.hooks !== undefined) {
      if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks))
        throw new Error("invalid hooks");
      for (const groups of Object.values(parsed.hooks)) {
        if (
          !Array.isArray(groups) ||
          groups.some(
            (group) =>
              !group ||
              typeof group !== "object" ||
              !Array.isArray(group.hooks) ||
              group.hooks.some((hook) => !hook || typeof hook !== "object"),
          )
        )
          throw new Error("invalid hooks");
      }
    }
    return parsed;
  } catch {
    throw new Error(`${path} is not valid settings JSON — fix or move it, then retry`);
  }
}

/**
 * Install: write the hook script, back up settings.json once, merge our
 * entries. Verify registration in Claude /hooks; supported versions watch settings
 * edits, while older versions may require a new session.
 */
export function installClaudeIntegration(paths = integrationPaths()): ClaudeIntegrationPaths {
  const { scriptPath: script, settingsPath } = paths;
  const settings = readSettings(settingsPath);
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, HOOK_SCRIPT, "utf8");
  chmodSync(script, 0o755);

  mkdirSync(dirname(settingsPath), { recursive: true });
  const backup = `${settingsPath}.tmux-ide.bak`;
  if (existsSync(settingsPath) && !existsSync(backup)) copyFileSync(settingsPath, backup);
  writeFileSync(settingsPath, `${JSON.stringify(mergeHooks(settings, script), null, 2)}\n`, "utf8");
  return { scriptPath: script, settingsPath };
}

/** Uninstall: remove exactly our entries (script file is left, it's inert). */
export function uninstallClaudeIntegration(paths = integrationPaths()): {
  settingsPath: string;
  wasInstalled: boolean;
} {
  const { settingsPath } = paths;
  const settings = readSettings(settingsPath);
  const wasInstalled = isInstalled(settings, paths.scriptPath);
  if (wasInstalled) {
    writeFileSync(
      settingsPath,
      `${JSON.stringify(removeHooks(settings, paths.scriptPath), null, 2)}\n`,
      "utf8",
    );
  }
  return { settingsPath, wasInstalled };
}

export function claudeIntegrationStatus(paths = integrationPaths()) {
  let settings: ClaudeSettings = {};
  const issues: string[] = [];
  try {
    settings = readSettings(paths.settingsPath);
  } catch {
    issues.push("settings_invalid");
  }
  const registered = isInstalled(settings, paths.scriptPath);
  const missingEvents = EVENT_STATES.filter(
    ({ event, state, matcher }) =>
      !(settings.hooks?.[event] ?? []).some(
        (group) =>
          (matcher === undefined || matcher === "*"
            ? group.matcher === undefined || group.matcher === "" || group.matcher === "*"
            : group.matcher === matcher) &&
          group.hooks.some(
            (hook) =>
              hook.type === "command" &&
              (hook.command === `${shellEscape(paths.scriptPath)} ${state}` ||
                (!/[\s'";$`\\|&<>]/u.test(paths.scriptPath) &&
                  hook.command === `${paths.scriptPath} ${state}`)),
          ),
      ),
  ).map(({ event }) => event);
  if (missingEvents.length) issues.push("registration_incomplete");
  if (settings.disableAllHooks === true) issues.push("hooks_disabled");
  let scriptExists = false;
  let scriptCurrent = false;
  let scriptExecutable = false;
  try {
    scriptExists = statSync(paths.scriptPath).isFile();
    if (scriptExists) {
      scriptCurrent = readFileSync(paths.scriptPath, "utf8") === HOOK_SCRIPT;
      accessSync(paths.scriptPath, constants.X_OK);
      scriptExecutable = true;
    }
  } catch {
    /* Report safe categories, never raw settings or script content. */
  }
  if (!scriptExists) issues.push("script_missing");
  else {
    if (!scriptCurrent) issues.push("script_outdated");
    if (!scriptExecutable) issues.push("script_not_executable");
  }
  return {
    installed: issues.length === 0,
    registered,
    scriptExists,
    scriptCurrent,
    scriptExecutable,
    registrationComplete: missingEvents.length === 0,
    missingEvents,
    issues,
    scope: "user-settings" as const,
    deliveryVerified: false,
    repairCommand:
      issues.includes("settings_invalid") || issues.includes("hooks_disabled")
        ? null
        : "tmux-ide integration install claude",
    guidance: issues.includes("settings_invalid")
      ? "Fix invalid user settings JSON before installing hooks."
      : issues.includes("hooks_disabled")
        ? "Hooks are disabled in user settings. Enable them there if intended, then repair registration."
        : "Verify active-session registration in Claude /hooks; runtime delivery is not verified.",
  };
}
