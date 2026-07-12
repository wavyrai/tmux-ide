/**
 * Agent lifecycle verbs — the PURE model (M23.1). The app can finally MANAGE
 * the fleet it watches: spawn a new agent (home chips / palette / sidebar
 * session menu / Terminal split), restart one, stop one, close its pane. The
 * kind list, the kind→launch-command map, the placement rows, and the exact
 * tmux argv every verb runs all live here so they unit-test without OpenTUI;
 * app.tsx supplies the dialog flows and the async execFile calls.
 *
 * KIND SOURCING: the detection manifests (manifest-loader) are the single
 * source of WHICH kinds exist — a user override manifest automatically shows
 * up in the "New agent" picker. Manifests carry `commands` (process names to
 * MATCH, e.g. `codex.exe`), not a command to LAUNCH, so the launch command is
 * a small map here keyed by manifest id, falling back to the manifest's first
 * command token (right for every current bundle and for user overrides).
 *
 * CONTRACT HYGIENE: the claude integration's SessionEnd hook stamps
 * `@agent_state idle:<epoch>` when the agent exits on its own. When WE kill it
 * out-of-band (stop/restart) no hook fires, and a `working`/`blocked` stamp
 * would keep lying for AUTHORITY_STALE_SECONDS (10 min) before the staleness
 * guard falls back to scraping. So stop/restart UNSET the pane's authority
 * options (`@agent_state`, `@agent_session_id`) — the same end state as a
 * clean exit, without inventing a fake idle epoch.
 */
import type { AgentManifest } from "../detect/manifest.ts";
import type { DialogRowAction, DialogSelectItem } from "./dialog-model.ts";
import { agentAgeLabel, agentDisplayKind, type AgentRowInput } from "./agent-rows.ts";

/** The "Custom command…" picker row — resolves to a DialogPrompt, not a kind. */
export const CUSTOM_KIND_ID = "custom-command";

/** The kind picker's front-loaded repeat row (M24.1) — pre-selected, so a
 *  repeat spawn is Enter·Enter from the palette. */
export const AGAIN_ID = "again";

/** Prefix for the custom-command RECENTS rows beneath "Custom command…". */
const CUSTOM_RECENT_PREFIX = "custom-recent:";

/**
 * Launch command per manifest id. Manifest `commands` are process-match
 * tokens; this is what actually gets typed/executed to START the agent. Only
 * ids whose launch spelling differs from (or shouldn't trust) the first match
 * token need an entry — {@link launchCommandFor} falls back for the rest.
 */
export const AGENT_LAUNCH_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  aider: "aider",
  copilot: "copilot",
  cursor: "cursor-agent",
  goose: "goose",
  amp: "amp",
  // M25.4 breadth — real installable CLIs only (spawn-picker honesty), each
  // verified against an installer/package: devin (curl cli.devin.ai), kimi
  // (curl code.kimi.com), pi (npm @mariozechner/pi-coding-agent), grok (npm
  // @vibe-kit/grok-cli), kiro (curl cli.kiro.dev → kiro-cli), cline (npm
  // cline), droid (verified live — Factory CLI, own process), kilo (npm
  // @kilocode/cli; the manifest matches its ".kilo" platform binary too).
  devin: "devin",
  kimi: "kimi",
  pi: "pi",
  grok: "grok",
  kiro: "kiro-cli",
  cline: "cline",
  droid: "droid",
  kilo: "kilo",
};

/**
 * PURE — the command that launches an agent of `kind`: the map entry when we
 * ship one, else the kind's manifest's first `commands` token (user-override
 * manifests land here), else the kind itself.
 */
export function launchCommandFor(kind: string, manifests: readonly AgentManifest[]): string {
  const mapped = AGENT_LAUNCH_COMMANDS[kind];
  if (mapped) return mapped;
  const m = manifests.find((x) => x.id === kind);
  return m?.commands[0] ?? kind;
}

/**
 * PURE — the "New agent" picker rows: one per manifest id (the `shell`
 * catch-all is not an agent and is excluded), detail showing the command that
 * will run, then the "Custom command…" escape hatch last.
 */
export function agentKindItems(manifests: readonly AgentManifest[]): DialogSelectItem[] {
  const items: DialogSelectItem[] = manifests
    .filter((m) => m.id !== "shell")
    .map((m) => ({ id: m.id, label: m.id, detail: launchCommandFor(m.id, manifests) }));
  items.push({ id: CUSTOM_KIND_ID, label: "Custom command…", detail: "type your own" });
  return items;
}

/** Where a spawned agent lands, relative to the target session/pane. */
export type SpawnPlacement = "window" | "split-h" | "split-v";

/** Every place a spawn can land — the pane placements plus a fresh detached
 *  session (home project rows). The "again" memory remembers one of these. */
export type SpawnWhere = SpawnPlacement | "session";

const SPAWN_WHERES: readonly SpawnWhere[] = ["window", "split-h", "split-v", "session"];

/** PURE — is `x` a persistable spawn placement? (app-state sanitizing). */
export function isSpawnWhere(x: unknown): x is SpawnWhere {
  return typeof x === "string" && (SPAWN_WHERES as readonly string[]).includes(x);
}

/** One remembered spawn — enough to repeat it exactly (M24.1). Persisted per
 *  project/session-dir in app-state; `command` carries custom argv verbatim. */
export interface LastSpawn {
  /** Manifest id, or {@link CUSTOM_KIND_ID} for a typed command. */
  kind: string;
  /** The exact command the spawn ran (the resolved launch command / custom argv). */
  command: string;
  /** Where it landed. */
  placement: SpawnWhere;
}

/** What the spawn flow knows about its entry point: is there a concrete pane
 *  to split (Terminal surface), and is there a live session at all? */
export interface SpawnContextShape {
  pane: boolean;
  session: boolean;
}

/**
 * PURE — where a spawn lands when the user just presses Enter (M24.1: the flow
 * never ASKS where). Terminal surface (a focused pane exists) → split right of
 * it; a live session without a concrete pane (home/sidebar session rows) → a
 * new window in it; no session (home project rows) → a fresh detached session.
 */
export function defaultSpawnPlacement(ctx: SpawnContextShape): SpawnWhere {
  if (ctx.pane) return "split-h";
  if (ctx.session) return "window";
  return "session";
}

/** PURE — can a remembered placement replay in this context? Splits need a
 *  concrete pane; window needs a live session; a fresh session always can. */
export function compatiblePlacement(placement: SpawnWhere, ctx: SpawnContextShape): boolean {
  if (placement === "session") return true;
  if (placement === "window") return ctx.session;
  return ctx.pane;
}

/** PURE — plain language for a placement (footer hints, the again row). */
export function placementLabel(placement: SpawnWhere): string {
  if (placement === "split-h") return "split right";
  if (placement === "split-v") return "split below";
  if (placement === "window") return "new window";
  return "new session";
}

/**
 * PURE — the kind picker's footer ACTIONS: placement ALTERNATIVES as ctrl-key
 * chords, never a second dialog (M24.1). Offered only where they differ from
 * the default and are honest in this context: with a focused pane the default
 * is split-right, so ^w (new window) and ^d (split below) are the escapes; a
 * session-only context defaults to a new window with nothing else honest to
 * offer; no session means a fresh one — no alternatives.
 */
export function placementActions(ctx: SpawnContextShape): DialogRowAction[] {
  if (ctx.pane) {
    return [
      { key: "w", label: "in a new window" },
      { key: "d", label: "split below" },
    ];
  }
  return [];
}

/** PURE — the placement a dialog result maps to: an action key overrides the
 *  default (`^w` → window, `^d` → split below); Enter keeps the default. */
export function resolvePlacement(fallback: SpawnWhere, actionKey?: string): SpawnWhere {
  if (actionKey === "w") return "window";
  if (actionKey === "d") return "split-v";
  return fallback;
}

/** PURE — a custom-recent row id for `index` into the recents list. */
export function customRecentId(index: number): string {
  return `${CUSTOM_RECENT_PREFIX}${index}`;
}

/** PURE — the recents index a row id encodes, or null for any other row. */
export function customRecentIndex(id: string): number | null {
  if (!id.startsWith(CUSTOM_RECENT_PREFIX)) return null;
  const n = Number(id.slice(CUSTOM_RECENT_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** PURE — what a remembered spawn is called: the kind, or the custom argv
 *  verbatim (labels for the again row + the palette's again action). */
export function lastSpawnName(last: LastSpawn): string {
  return last.kind === CUSTOM_KIND_ID ? last.command : last.kind;
}

/**
 * PURE — the ONE dialog's rows (M24.1): the "again" repeat row FIRST (when a
 * spawn is remembered for this context — pre-selected, so repeat = Enter), then
 * the manifest kinds, then "Custom command…", then the recent custom commands
 * as directly selectable rows beneath it. The again row names what it repeats
 * and where it will land.
 */
export function newAgentItems(opts: {
  manifests: readonly AgentManifest[];
  last: LastSpawn | null;
  /** The placement the again row will actually use (memory, context-checked). */
  againPlacement?: SpawnWhere;
  customRecents: readonly string[];
}): DialogSelectItem[] {
  const items: DialogSelectItem[] = [];
  if (opts.last) {
    const where = opts.againPlacement ?? opts.last.placement;
    items.push({
      id: AGAIN_ID,
      label: `${lastSpawnName(opts.last)} — again`,
      detail: placementLabel(where),
    });
  }
  items.push(...agentKindItems(opts.manifests));
  opts.customRecents.forEach((cmd, i) => {
    items.push({ id: customRecentId(i), label: cmd, detail: "recent" });
  });
  return items;
}

/** PURE — the label a spawned pane/window gets: the kind, or a custom
 *  command's first token stripped to its basename (`/us/bin/my-agent -x` →
 *  `my-agent`). Empty input falls back to "agent". */
export function spawnLabelFor(kind: string, command: string): string {
  if (kind !== CUSTOM_KIND_ID) return kind;
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? "";
  return base.length > 0 ? base : "agent";
}

/** The spawn target: the owning session, plus the concrete pane for splits. */
export interface SpawnTarget {
  session: string;
  /** Required for `split-h`/`split-v`; ignored for `window`. */
  paneId?: string;
}

/** `-P -F` — every spawn PRINTS its new pane id, so the flow can label the
 *  pane/window and stamp `@agent_launch` without a lookup race. */
const PRINT_PANE_ID = ["-P", "-F", "#{pane_id}"];

/**
 * PURE — the tmux argv that spawns `command` at `placement`. New windows
 * target `<session>:` (tmux appends); splits target the pane. `dir` becomes
 * `-c` when known. The command is passed as tmux's shell-command argument —
 * a bare binary is exec'd directly, so `pane_current_command` is the agent
 * itself and detection picks it up with no extra wiring. `-P -F "#{pane_id}"`
 * prints the spawned pane's id (M24.1 — the label/stamp follow-ups target it).
 */
export function spawnAgentArgs(
  placement: SpawnPlacement,
  target: SpawnTarget,
  dir: string | null,
  command: string,
): string[] {
  const cd = dir ? ["-c", dir] : [];
  if (placement === "window") {
    return ["new-window", "-t", `${target.session}:`, ...PRINT_PANE_ID, ...cd, command];
  }
  const flag = placement === "split-h" ? "-h" : "-v";
  return [
    "split-window",
    flag,
    "-t",
    target.paneId ?? `${target.session}:`,
    ...PRINT_PANE_ID,
    ...cd,
    command,
  ];
}

/**
 * PURE — the tmux argv that creates a fresh detached session running
 * `command` (the home PROJECT-row spawn: no live session exists yet, so the
 * agent gets one, named for the project). Prints the new pane id like
 * {@link spawnAgentArgs}.
 */
export function spawnSessionArgs(name: string, dir: string | null, command: string): string[] {
  return ["new-session", "-d", "-s", name, ...PRINT_PANE_ID, ...(dir ? ["-c", dir] : []), command];
}

/** PURE — title the spawned pane after its agent (`select-pane -T`), so the
 *  pane is named without the user being asked (M24.1 auto-label). */
export function labelPaneArgs(paneId: string, label: string): string[] {
  return ["select-pane", "-t", paneId, "-T", label];
}

/** PURE — name a spawned WINDOW after its agent. Targets the spawned pane's
 *  id, which tmux resolves to the window that holds it. */
export function labelWindowArgs(paneId: string, label: string): string[] {
  return ["rename-window", "-t", paneId, label];
}

/** PURE — stamp the spawned pane with the exact command that launched it
 *  (`@agent_launch`, pane-local) — restart's preferred relaunch source (better
 *  than `pane_start_command`, which tmux rewrites for respawned panes). */
export function stampLaunchArgs(paneId: string, command: string): string[] {
  return ["set-option", "-p", "-t", paneId, "@agent_launch", command];
}

// ── The team dialog (M24.1 — "manage your team" in one surface) ─────────────

/** The team dialog's pinned "+ new agent" row id. */
export const TEAM_NEW_ID = "team-new";

/** Prefix for the team dialog's per-agent rows: `agent:<index>` into the
 *  caller's (already sorted) fleet agent list. */
const TEAM_AGENT_PREFIX = "agent:";

/** PURE — a team row id for `index` into the fleet agent list. */
export function teamAgentId(index: number): string {
  return `${TEAM_AGENT_PREFIX}${index}`;
}

/** PURE — the fleet-agent index a team row id encodes, or null. */
export function teamAgentIndex(id: string): number | null {
  if (!id.startsWith(TEAM_AGENT_PREFIX)) return null;
  const n = Number(id.slice(TEAM_AGENT_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * PURE — the Team dialog rows: a pinned "+ new agent" first (the same one-
 * dialog kind picker), then one row per fleet agent — "<kind> · <session>",
 * detail its state (+ dwell when stamped). Enter/click jumps; the footer's
 * ctrl-actions (restart/stop) ride the DialogRowAction channel.
 */
export function teamItems(agents: readonly AgentRowInput[], nowSec: number): DialogSelectItem[] {
  const items: DialogSelectItem[] = [
    { id: TEAM_NEW_ID, label: "+ new agent", detail: "kind picker" },
  ];
  agents.forEach((a, i) => {
    items.push({
      id: teamAgentId(i),
      // Display-name precedence (M25.4): the Team dialog names an agent the
      // same way the sidebar rows do.
      label: `${agentDisplayKind(a)} · ${a.session}`,
      detail: agentAgeLabel(a.state, a.since, nowSec) ?? a.state,
    });
  });
  return items;
}

/** The Team dialog's footer ctrl-actions (restart/stop the selected agent). */
export const TEAM_ACTIONS: DialogRowAction[] = [
  { key: "r", label: "restart" },
  { key: "s", label: "stop" },
];

/** Interactive shells beyond the shell manifest's `commands` — a login shell
 *  hosting an agent can surface as any of these in `pane_current_command`. */
const EXTRA_SHELLS = ["dash", "ksh", "tcsh", "csh"];

/**
 * PURE — is `command` an interactive shell? Login-shell dashes and paths are
 * stripped (`-zsh`, `/bin/zsh` → `zsh`); sourced from the `shell` manifest's
 * command list plus a few shells it doesn't track.
 */
export function isShellCommand(command: string, manifests: readonly AgentManifest[]): boolean {
  const name = command.replace(/^-/, "").split("/").pop() ?? command;
  const shell = manifests.find((m) => m.id === "shell");
  return [...(shell?.commands ?? []), ...EXTRA_SHELLS].includes(name);
}

/**
 * PURE — does the pane HOST A SHELL underneath whatever runs in it? Decides
 * the RESTART strategy: shell-hosted agents are ctrl-c'd and relaunched via
 * send-keys (the shell survives to type into); an agent that IS the pane's
 * own process (our spawn verb's panes) has no shell underneath — ctrl-c would
 * end the pane — so it is respawned in place instead.
 *
 * The input is `#{pane_start_command}`, NOT `pane_current_command`: the
 * current command reflects the FOREGROUND process, so a user-typed `claude`
 * under zsh reads as `claude` too — indistinguishable from a pane-command
 * agent (measured). The start command is the pane's ROOT: empty means tmux's
 * default shell (every plain user pane), a shell word means an explicit shell
 * pane, anything else means the pane dies with that process.
 */
export function paneHostsShell(startCommand: string, manifests: readonly AgentManifest[]): boolean {
  const first = startCommand.trim().split(/\s+/)[0] ?? "";
  if (first.length === 0) return true; // default-shell pane
  return isShellCommand(first, manifests);
}

/**
 * PURE — the tmux argv that relaunches `command` as the pane's own process:
 * `respawn-pane -k` kills what runs there and restarts IN PLACE — same pane
 * id, same geometry. `dir` rides as an explicit `-c` (the flow reads the
 * pane's current path first) so the cwd is preserved on every tmux version.
 */
export function respawnArgs(paneId: string, command: string, dir: string | null): string[] {
  return ["respawn-pane", "-k", "-t", paneId, ...(dir ? ["-c", dir] : []), command];
}

/** PURE — one interrupt (ctrl-c) to the pane. Sent TWICE by the flows: TUI
 *  agents (claude, codex) treat a single ctrl-c as "clear input / cancel turn"
 *  and only a quick second one as "exit"; a plain process ignores the repeat. */
export function interruptArgs(paneId: string): string[] {
  return ["send-keys", "-t", paneId, "C-c"];
}

/** PURE — relaunch `command` in the pane's (still-running) shell: the literal
 *  command text, then Enter as a key. Two calls — `-l` must not eat "Enter". */
export function relaunchArgs(paneId: string, command: string): string[][] {
  return [
    ["send-keys", "-t", paneId, "-l", command],
    ["send-keys", "-t", paneId, "Enter"],
  ];
}

/**
 * PURE — unset the pane's authority stamps after an out-of-band stop/restart
 * (see the header: no hook fires, so a stale `working:<epoch>` would lie for
 * 10 minutes). `-u` on a pane-local (`-p`) option removes it, which is exactly
 * the "no authority present" state the classifier falls back to scraping from.
 */
export function clearAuthorityArgs(paneId: string): string[][] {
  return [
    ["set-option", "-p", "-t", paneId, "-u", "@agent_state"],
    ["set-option", "-p", "-t", paneId, "-u", "@agent_session_id"],
  ];
}

/** Gap between the two interrupts — inside claude/codex's "press again to
 *  exit" window, long enough for the first ^c to be processed. */
export const INTERRUPT_TAP_GAP_MS = 250;
/** Grace after the interrupts before relaunching in the same pane — lets the
 *  agent process die and its shell repaint the prompt. */
export const RESTART_GRACE_MS = 1000;
