/**
 * Declarative detection manifests — a pure, data-driven rule engine.
 *
 * A manifest describes, per agent command (claude, codex, shell, …), the
 * textual evidence that indicates a `blocked`/`working`/`done` state. The
 * evaluator resolves matcher regions from a `PaneSnapshot`, tests them, and
 * returns the first state (by precedence) whose rule matches. Everything here
 * is pure and never throws — invalid regexes simply fail to match. The 4-state
 * classifier layers `idle` + seen-tracking on top of this.
 */
import type { PaneSnapshot } from "./snapshot.ts";

/** Which slice of a snapshot a matcher tests against. */
export type Region = "bottom" | "text" | "title";

/** A single evidence probe. Exactly one of `contains`/`regex` is required. */
export interface Matcher {
  /** Region to resolve (default `bottom`). */
  region?: Region;
  /** Substring test. */
  contains?: string;
  /** Regex source string (compiled safely; invalid → no match). */
  regex?: string;
  /** Case-insensitive contains/regex (default false). */
  caseInsensitive?: boolean;
}

/** A boolean clause: `all` matchers AND-ed, `any` matchers OR-ed. */
export interface Rule {
  /** Every matcher must match. */
  all?: Matcher[];
  /** At least one matcher must match. */
  any?: Matcher[];
}

/** Per-state rules. `idle` is the fallback and has no rule. */
export interface StateRules {
  blocked?: Rule;
  working?: Rule;
  done?: Rule;
}

/**
 * How much trust the manifest's rules earn.
 * - `tuned`: built from REAL captured screens (or the agent's own source
 *   strings) — the markers are verbatim, not guessed.
 * - `conservative`: best-effort from public knowledge; high-precision only, so
 *   it can never false-positive on a plain prompt, but it may miss real states.
 */
export type ManifestConfidence = "tuned" | "conservative";

/** A detection manifest for one or more pane commands. */
export interface AgentManifest {
  /** Stable manifest id. */
  id: string;
  /** Pane `current_command` names this manifest applies to. */
  commands: string[];
  /** Evidence rules per detectable state. */
  states: StateRules;
  /**
   * Evidence confidence (default `conservative` when omitted). Surfaced by
   * `agent explain` so a user can see whether a verdict rests on real evidence
   * or a best-effort heuristic. Purely informational — never affects matching.
   */
  confidence?: ManifestConfidence;
}

/** The states a manifest can positively detect (idle is inferred elsewhere). */
export type DetectedState = "blocked" | "working" | "done";

/** Snapshot plus the optional pane title used by the `title` region. */
type SnapshotWithTitle = PaneSnapshot & { title?: string };

/** Precedence order — the first matching state wins. */
const PRECEDENCE: DetectedState[] = ["blocked", "working", "done"];

/** Resolve the text a matcher tests against, tolerating an absent title. */
function resolveRegion(snapshot: SnapshotWithTitle, region: Region): string {
  switch (region) {
    case "text":
      return snapshot.text;
    case "title":
      return snapshot.title ?? "";
    case "bottom":
    default:
      return snapshot.bottomNonEmpty.join("\n");
  }
}

/** Compile a regex safely — returns undefined on invalid source. */
function safeRegex(source: string, caseInsensitive?: boolean): RegExp | undefined {
  try {
    return new RegExp(source, caseInsensitive ? "i" : "");
  } catch {
    return undefined;
  }
}

/**
 * Test a single matcher against a snapshot. Pure — never throws.
 * A matcher with neither `contains` nor `regex` never matches.
 */
export function matchMatcher(snapshot: SnapshotWithTitle, matcher: Matcher): boolean {
  const haystack = resolveRegion(snapshot, matcher.region ?? "bottom");

  if (matcher.contains !== undefined) {
    if (matcher.caseInsensitive) {
      return haystack.toLowerCase().includes(matcher.contains.toLowerCase());
    }
    return haystack.includes(matcher.contains);
  }

  if (matcher.regex !== undefined) {
    const re = safeRegex(matcher.regex, matcher.caseInsensitive);
    return re ? re.test(haystack) : false;
  }

  return false;
}

/**
 * Test a rule: all present `all` matchers must match AND at least one present
 * `any` matcher must match. An empty or absent rule never matches.
 */
export function matchRule(snapshot: SnapshotWithTitle, rule: Rule): boolean {
  const hasAll = rule.all !== undefined && rule.all.length > 0;
  const hasAny = rule.any !== undefined && rule.any.length > 0;
  if (!hasAll && !hasAny) return false;

  if (hasAll && !rule.all!.every((m) => matchMatcher(snapshot, m))) return false;
  if (hasAny && !rule.any!.some((m) => matchMatcher(snapshot, m))) return false;

  return true;
}

/**
 * Evaluate a manifest against a snapshot in precedence order
 * (blocked → working → done). Returns the first matching state, or
 * `{ state: null }` when no rule matches. Detection is strict: blocked
 * requires explicit evidence.
 */
export function evaluateManifest(
  snapshot: SnapshotWithTitle,
  manifest: AgentManifest,
): { state: DetectedState | null; matched?: { state: DetectedState; matcher: Matcher } } {
  for (const state of PRECEDENCE) {
    const rule = manifest.states[state];
    if (rule && matchRule(snapshot, rule)) {
      const matcher = firstMatchingMatcher(snapshot, rule);
      return matcher ? { state, matched: { state, matcher } } : { state };
    }
  }
  return { state: null };
}

/** Find the first matcher in a rule that matched, for reporting. */
function firstMatchingMatcher(snapshot: SnapshotWithTitle, rule: Rule): Matcher | undefined {
  const matchers = [...(rule.all ?? []), ...(rule.any ?? [])];
  return matchers.find((m) => matchMatcher(snapshot, m));
}

/**
 * Debug helper — evaluate every state and report which matched, alongside the
 * winning state (by precedence).
 */
export function explain(
  snapshot: SnapshotWithTitle,
  manifest: AgentManifest,
): { state: DetectedState | null; checked: Array<{ state: DetectedState; matched: boolean }> } {
  const checked = PRECEDENCE.map((state) => {
    const rule = manifest.states[state];
    return { state, matched: rule ? matchRule(snapshot, rule) : false };
  });
  const winner = checked.find((c) => c.matched);
  return { state: winner ? winner.state : null, checked };
}

/** Escape a string for literal use inside a RegExp source. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `haystack` contain `needle` as a WHOLE alphanumeric segment (delimited
 * by start/end or any non-alphanumeric)? `grok-build` contains the segment
 * `grok`; `pip` does NOT contain the segment `pi`. This is what keeps short
 * manifest command tokens (pi, devin, kimi — M25.4) from substring-matching
 * unrelated commands (`pip`, `vi`, `api-server`).
 */
function containsSegment(haystack: string, needle: string): boolean {
  if (!haystack.includes(needle)) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`).test(haystack);
}

/**
 * Pick the manifest whose `commands` best match a pane's current command.
 * Prefers an exact (case-insensitive) match, then a SEGMENT match in either
 * direction — the command contains a manifest token as a whole segment
 * (`grok-build` → `grok`, `.kilo` → `kilo`) or vice versa (`cursor` →
 * `cursor-agent`). Raw substring matching was retired in M25.4: it made every
 * short token a false-positive machine (`pi` ⊂ `pip`, `vi` ⊂ `devin`).
 * Returns undefined when nothing applies.
 */
export function pickManifest(
  command: string,
  manifests: AgentManifest[],
): AgentManifest | undefined {
  const cmd = command.trim().toLowerCase();
  if (cmd.length === 0) return undefined;

  const exact = manifests.find((m) => m.commands.some((c) => c.toLowerCase() === cmd));
  if (exact) return exact;

  return manifests.find((m) =>
    m.commands.some((c) => {
      const name = c.toLowerCase();
      return containsSegment(cmd, name) || containsSegment(name, cmd);
    }),
  );
}
