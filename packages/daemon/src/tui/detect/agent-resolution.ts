/**
 * The ONE authority-first status decision every surface shares.
 *
 * "What is an agent's status" is decided here and nowhere else: a fresh
 * `@agent_state` stamp (parsed with the staleness guard in {@link parseAuthority})
 * OUTRANKS scraping; otherwise the caller's own scrape verdict is used. The
 * caller supplies that verdict via a callback because the IO and any surface-
 * specific bookkeeping differ — the cockpit folds its scrape through the
 * cross-tick {@link StatusTracker}; the desktop projection reads a pre-resolved
 * probe verdict — but the DECISION (authority beats scrape, plus the `since`
 * stamp and the status source) is identical, so it lives once, here.
 *
 * Everything in this module is PURE. The scrape callback may do IO, but it is
 * invoked ONLY when authority is absent or stale, which is exactly where the
 * expensive capture/scrape is wanted.
 */
import {
  parseAuthority,
  parseAuthorityEpoch,
  sanitizeAgentText,
  type AgentStatus,
} from "./classify.ts";

/** Where a resolved status came from — an authority stamp, scraping, or neither. */
export type AgentStatusSource = "authority" | "scrape" | "unknown";

/** The resolved status plus its provenance and (authority-only) `since` stamp. */
export interface ResolvedAgentStatus {
  readonly status: AgentStatus;
  readonly source: AgentStatusSource;
  /** The authority state's own epoch ("since"); null for a scraped status. */
  readonly since: number | null;
}

/**
 * Resolve a pane's status authority-first. PURE.
 *
 * - A fresh `@agent_state` stamp wins → `source: "authority"`, `since` = its epoch.
 * - Otherwise `scrape()` is invoked and its verdict is used → `source: "scrape"`,
 *   or `source: "unknown"` when the scrape itself couldn't classify the pane.
 *
 * `scrape` is only called on the authority-absent/stale path, so a fresh stamp
 * never triggers a capture round-trip.
 */
export function resolveAgentStatus(input: {
  readonly authorityRaw: string | undefined;
  readonly nowSec: number;
  readonly scrape: () => AgentStatus;
}): ResolvedAgentStatus {
  const authority = parseAuthority(input.authorityRaw, input.nowSec);
  if (authority !== null) {
    return { status: authority, source: "authority", since: parseAuthorityEpoch(input.authorityRaw) };
  }
  const status = input.scrape();
  return { status, source: status === "unknown" ? "unknown" : "scrape", since: null };
}

/**
 * The sanitized self-reported display metadata a pane surfaces, gated on
 * authority freshness. PURE.
 *
 * `@agent_status_text` / `@agent_display_name` carry no epoch of their own — they
 * ride the pane's `@agent_state` stamp — so they are trusted ONLY while that
 * stamp is fresh (`authorityFresh`). A stale/absent stamp drops them rather than
 * letting them lie beside a scraped status. Each value passes through
 * {@link sanitizeAgentText} (ANSI stripped, controls collapsed, clamped). Fields
 * are omitted (not null) so callers can spread them additively.
 */
export function agentDisplayMetadata(
  statusTextRaw: string | undefined,
  displayNameRaw: string | undefined,
  authorityFresh: boolean,
): { statusText?: string; displayName?: string } {
  if (!authorityFresh) return {};
  const statusText = sanitizeAgentText(statusTextRaw);
  const displayName = sanitizeAgentText(displayNameRaw);
  return {
    ...(statusText !== undefined ? { statusText } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}
