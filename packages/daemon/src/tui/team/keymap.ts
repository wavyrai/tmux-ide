/**
 * Central, configurable keymap for the team TUI.
 *
 * `DEFAULT_KEYMAP` holds the built-in bindings; `mergeKeymap`/`resolveAction`
 * are pure so they can be reasoned about (and tested) without io. `loadKeymap`
 * is the thin io wrapper that reads `~/.tmux-ide/team-keys.json` overrides and
 * falls back to the defaults on any error.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ActionId =
  | "up"
  | "down"
  | "enter"
  | "launch"
  | "new"
  | "rename"
  | "split"
  | "register"
  | "unregister"
  | "kill"
  | "filter"
  | "refresh"
  | "help"
  | "quit";

export interface KeyBinding {
  keys: string[];
  description: string;
}

/** Deterministic action order — drives `resolveAction` iteration + help listing. */
export const ACTION_ORDER: ActionId[] = [
  "up",
  "down",
  "enter",
  "launch",
  "new",
  "rename",
  "split",
  "register",
  "unregister",
  "kill",
  "filter",
  "refresh",
  "help",
  "quit",
];

export const DEFAULT_KEYMAP: Record<ActionId, KeyBinding> = {
  up: { keys: ["up", "k"], description: "move up" },
  down: { keys: ["down", "j"], description: "move down" },
  enter: { keys: ["return"], description: "launch / attach" },
  launch: { keys: ["l"], description: "launch project" },
  new: { keys: ["n"], description: "new session" },
  rename: { keys: ["R"], description: "rename session" },
  split: { keys: ["s"], description: "split pane" },
  register: { keys: ["a"], description: "add project" },
  unregister: { keys: ["d"], description: "unregister project" },
  kill: { keys: ["x"], description: "kill (confirm)" },
  filter: { keys: ["/"], description: "fuzzy filter" },
  refresh: { keys: ["r"], description: "refresh" },
  help: { keys: ["?"], description: "toggle help" },
  quit: { keys: ["q"], description: "quit" },
};

/** Deep-copy a single binding so callers can't mutate the shared defaults. */
function cloneBinding(binding: KeyBinding): KeyBinding {
  return { keys: [...binding.keys], description: binding.description };
}

/**
 * Return a copy of `DEFAULT_KEYMAP` with `keys` replaced for any action present
 * in `overrides` (descriptions are always kept from the defaults). Unknown
 * action ids in `overrides` are ignored. Pure — never touches the filesystem.
 */
export function mergeKeymap(
  overrides: Partial<Record<ActionId, string[]>> | undefined,
): Record<ActionId, KeyBinding> {
  const merged = {} as Record<ActionId, KeyBinding>;
  for (const action of ACTION_ORDER) {
    merged[action] = cloneBinding(DEFAULT_KEYMAP[action]);
  }
  if (!overrides) return merged;
  for (const action of ACTION_ORDER) {
    const keys = overrides[action];
    if (keys && Array.isArray(keys)) {
      merged[action] = { keys: [...keys], description: DEFAULT_KEYMAP[action].description };
    }
  }
  return merged;
}

/**
 * Read `~/.tmux-ide/team-keys.json` overrides (JSON of `{ actionId: [key,…] }`)
 * and merge them onto the defaults. Any error — missing file, bad JSON, wrong
 * shape — falls back to `DEFAULT_KEYMAP`.
 */
export function loadKeymap(): Record<ActionId, KeyBinding> {
  try {
    const path = join(homedir(), ".tmux-ide", "team-keys.json");
    if (!existsSync(path)) return mergeKeymap(undefined);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return mergeKeymap(undefined);
    return mergeKeymap(parsed as Partial<Record<ActionId, string[]>>);
  } catch {
    return mergeKeymap(undefined);
  }
}

/**
 * Resolve a pressed key name to the first `ActionId` whose binding includes it,
 * iterating in `ACTION_ORDER` for determinism. Returns null when unbound.
 */
export function resolveAction(
  keymap: Record<ActionId, KeyBinding>,
  keyName: string,
): ActionId | null {
  for (const action of ACTION_ORDER) {
    if (keymap[action].keys.includes(keyName)) return action;
  }
  return null;
}
