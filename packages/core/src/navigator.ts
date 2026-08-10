/** Renderer-neutral scopes shared by every tmux-ide navigator surface. */
export const NAVIGATOR_SCOPES = ["all", "workspaces", "agents", "panes", "commands"] as const;

export type NavigatorScope = (typeof NAVIGATOR_SCOPES)[number];
export type NavigatorEntryScope = Exclude<NavigatorScope, "all">;

export const NAVIGATOR_STATUSES = ["blocked", "working", "done", "idle"] as const;
export type NavigatorStatus = (typeof NAVIGATOR_STATUSES)[number];

export interface NavigatorQuery {
  readonly scope: NavigatorScope;
  readonly status: NavigatorStatus | null;
  readonly query: string;
}

export interface ScopedNavigatorEntry {
  readonly scope: NavigatorEntryScope;
  readonly status?: NavigatorStatus | null;
}

const SCOPE_TOKENS: Readonly<Record<string, NavigatorScope>> = Object.freeze({
  "@all": "all",
  "@workspace": "workspaces",
  "@workspaces": "workspaces",
  "@agent": "agents",
  "@agents": "agents",
  "@pane": "panes",
  "@panes": "panes",
  "@command": "commands",
  "@commands": "commands",
});

const STATUS_TOKENS: Readonly<Record<string, NavigatorStatus>> = Object.freeze({
  "#blocked": "blocked",
  "#working": "working",
  "#done": "done",
  "#idle": "idle",
});

/**
 * Parse optional scope/status tokens without leaking either renderer's input
 * model into the core. Tokens can appear in any order and are removed from the
 * fuzzy-search query; the last token of each kind wins deterministically.
 */
export function parseNavigatorQuery(raw: string): NavigatorQuery {
  let scope: NavigatorScope = "all";
  let status: NavigatorStatus | null = null;
  const query: string[] = [];
  for (const token of raw.trim().split(/\s+/u)) {
    if (!token) continue;
    const normalized = token.toLocaleLowerCase();
    const tokenScope = SCOPE_TOKENS[normalized];
    if (tokenScope) {
      scope = tokenScope;
      continue;
    }
    const tokenStatus = STATUS_TOKENS[normalized];
    if (tokenStatus) {
      status = tokenStatus;
      continue;
    }
    query.push(token);
  }
  return { scope, status, query: query.join(" ") };
}

/** One filtering law for GUI cards, OpenTUI rows, and future SDK clients. */
export function navigatorEntryMatches(
  entry: ScopedNavigatorEntry,
  filter: Pick<NavigatorQuery, "scope" | "status">,
): boolean {
  if (filter.scope !== "all" && entry.scope !== filter.scope) return false;
  return filter.status === null || entry.status === filter.status;
}
