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
import type { DialogSelectItem } from "./dialog-model.ts";

/** The "Custom command…" picker row — resolves to a DialogPrompt, not a kind. */
export const CUSTOM_KIND_ID = "custom-command";

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

/**
 * PURE — the "where should it run" rows. Splits are offered only when there is
 * a concrete pane to split (the Terminal surface's focused pane); the home /
 * sidebar entry points target a session, where a new window is the honest
 * placement. A single-row list still shows, so the flow always says where the
 * agent will land before anything runs.
 */
export function placementItems(opts: { split: boolean }): DialogSelectItem[] {
  const items: DialogSelectItem[] = [{ id: "window", label: "New window", detail: "its own tab" }];
  if (opts.split) {
    items.push({ id: "split-h", label: "Split right", detail: "beside this pane" });
    items.push({ id: "split-v", label: "Split below", detail: "under this pane" });
  }
  return items;
}

/** The spawn target: the owning session, plus the concrete pane for splits. */
export interface SpawnTarget {
  session: string;
  /** Required for `split-h`/`split-v`; ignored for `window`. */
  paneId?: string;
}

/**
 * PURE — the tmux argv that spawns `command` at `placement`. New windows
 * target `<session>:` (tmux appends); splits target the pane. `dir` becomes
 * `-c` when known. The command is passed as tmux's shell-command argument —
 * a bare binary is exec'd directly, so `pane_current_command` is the agent
 * itself and detection picks it up with no extra wiring.
 */
export function spawnAgentArgs(
  placement: SpawnPlacement,
  target: SpawnTarget,
  dir: string | null,
  command: string,
): string[] {
  const cd = dir ? ["-c", dir] : [];
  if (placement === "window") return ["new-window", "-t", `${target.session}:`, ...cd, command];
  const flag = placement === "split-h" ? "-h" : "-v";
  return ["split-window", flag, "-t", target.paneId ?? `${target.session}:`, ...cd, command];
}

/**
 * PURE — the tmux argv that creates a fresh detached session running
 * `command` (the home PROJECT-row spawn: no live session exists yet, so the
 * agent gets one, named for the project).
 */
export function spawnSessionArgs(name: string, dir: string | null, command: string): string[] {
  return ["new-session", "-d", "-s", name, ...(dir ? ["-c", dir] : []), command];
}

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
