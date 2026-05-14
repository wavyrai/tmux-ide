/**
 * Filters/scores mention candidates for the @-autocomplete menu.
 *
 * Lighter-weight than [[slashCommandSearch]] — the candidate set is
 * already curated (host pushes files + thread index + agents in via
 * props) and the typical query is a path fragment, not a command name.
 *
 * Scoring prefers exact prefix matches, then substring matches, then
 * subsequence matches with a gap penalty. Mirrors the slash-command
 * scoring shape so the menu UI can use the same `matched: number[]`
 * highlight contract.
 */

export type MentionKind = "file" | "thread" | "agent";

export interface MentionCandidate {
  kind: MentionKind;
  /** The token inserted into the prompt after `@`. For files, the path. */
  value: string;
  /** What the user sees in the menu row. */
  label: string;
  /** Optional secondary line under the label. */
  hint?: string;
}

export interface MentionSearchResult {
  candidate: MentionCandidate;
  score: number;
  matched: number[];
}

const DEFAULT_LIMIT = 12;

function matchSubsequence(
  name: string,
  query: string,
): { score: number; matched: number[] } | null {
  const matched: number[] = [];
  let qi = 0;
  let prev = -1;
  let gap = 0;
  for (let i = 0; i < name.length && qi < query.length; i++) {
    if (name[i] !== query[qi]) continue;
    matched.push(i);
    if (prev >= 0) gap += i - prev - 1;
    prev = i;
    qi += 1;
  }
  if (qi !== query.length) return null;
  return { score: 500 - gap - name.length, matched };
}

function scoreCandidate(
  candidate: MentionCandidate,
  q: string,
): { score: number; matched: number[] } | null {
  const lbl = candidate.label.toLowerCase();
  if (lbl === q) return { score: 1_000 - lbl.length, matched: range(0, q.length) };
  if (lbl.startsWith(q)) return { score: 900 - lbl.length, matched: range(0, q.length) };
  const subIndex = lbl.indexOf(q);
  if (subIndex >= 0)
    return { score: 750 - subIndex - lbl.length, matched: range(subIndex, q.length) };
  return matchSubsequence(lbl, q);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

/**
 * Stable ordering for non-query (empty) state: files first (most common
 * mention target), then threads, then agents, then alphabetical inside
 * each kind.
 */
const KIND_ORDER: Record<MentionKind, number> = { file: 0, thread: 1, agent: 2 };

export function searchMentions(
  candidates: ReadonlyArray<MentionCandidate>,
  query: string,
  limit = DEFAULT_LIMIT,
): MentionSearchResult[] {
  const boundedLimit = Math.max(0, limit);
  if (boundedLimit === 0) return [];

  const q = query.toLowerCase();
  if (!q) {
    return [...candidates]
      .sort((a, b) => {
        const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        return k === 0 ? a.label.localeCompare(b.label) : k;
      })
      .slice(0, boundedLimit)
      .map((candidate) => ({ candidate, score: -candidate.label.length, matched: [] }));
  }

  const out: MentionSearchResult[] = [];
  for (const candidate of candidates) {
    const m = scoreCandidate(candidate, q);
    if (!m) continue;
    out.push({ candidate, score: m.score, matched: m.matched });
  }
  return out
    .sort((a, b) => {
      const s = b.score - a.score;
      return s === 0 ? a.candidate.label.localeCompare(b.candidate.label) : s;
    })
    .slice(0, boundedLimit);
}
