/**
 * Dependency-free fuzzy subsequence matcher for the team TUI's quick-jump
 * filter. Pure so it can be unit-tested in isolation from `index.tsx` (which
 * runs `render(...)` on import).
 *
 * The match is a case-insensitive SUBSEQUENCE test: every char of the query
 * must appear in the target in order (not necessarily contiguously). Scoring
 * rewards matches that feel "meaningful" to a human — contiguous runs, matches
 * anchored at the start of the string, and matches right after a separator
 * (so typing "web" ranks the "web" in `wavyr-website` well).
 */

/** A char that starts a new "word" — a match right after one scores a bonus. */
const SEPARATORS = new Set(["/", "-", "_", " ", "."]);

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

/** Per-char position bonuses. */
const START_BONUS = 10; // matched char is the first char of the target
const SEPARATOR_BONUS = 8; // matched char follows a separator (word start)
const CONTIGUOUS_BONUS = 5; // matched char is adjacent to the previous match
const BASE = 1; // every matched char is worth at least this
// Whole-alignment extra when the query is a contiguous PREFIX of the target
// (M24.4): typing a label's start must rank that label above mid-word runs
// AND above scattered matches that rack up several word-start bonuses —
// measured: "save" scored 29 on "Save file" but 30 on "swap pane view east"
// (three word-start hits). Sized to dominate realistic competitors (a
// non-prefix alignment outscores a prefix only past ~8 all-word-start chars);
// word-boundary preference WITHIN non-prefix matches is untouched ("web"
// still anchors on the "web" of `wavyr-website`, not the leading "w").
const PREFIX_EXTRA = 24;

/**
 * Case-insensitive subsequence match of `query` against `target`.
 *
 * Returns `null` when `query` is not a subsequence of `target`. An empty query
 * matches everything with score 0 and no positions. Otherwise returns the
 * matched indices in `target` plus a heuristic score (higher is better).
 *
 * Uses a small dynamic program to find the highest-scoring alignment among all
 * valid subsequences — a greedy leftmost scan would anchor on the first
 * occurrence of each char and miss word-boundary matches (e.g. "web" should
 * favour the "web" after the "-" in `wavyr-website`, not the leading "w").
 */
export function fuzzyMatch(
  query: string,
  target: string,
): { score: number; positions: number[] } | null {
  if (query.length === 0) return { score: 0, positions: [] };

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const m = q.length;
  const n = t.length;

  /** Position-context bonus for placing a matched char at target index j. */
  const positionBonus = (j: number): number => {
    if (j === 0) return START_BONUS;
    if (SEPARATORS.has(t[j - 1]!)) return SEPARATOR_BONUS;
    return 0;
  };

  const NEG = Number.NEGATIVE_INFINITY;
  // f[i][j] = best score for matching q[i..] with q[i] placed at target index j
  // (only meaningful when t[j] === q[i]); nextPos[i][j] = chosen index for q[i+1].
  const f: number[][] = [];
  const nextPos: number[][] = [];
  for (let i = 0; i < m; i++) {
    f.push(new Array<number>(n).fill(NEG));
    nextPos.push(new Array<number>(n).fill(-1));
  }

  const last = m - 1;
  for (let j = 0; j < n; j++) {
    if (t[j] === q[last]) f[last]![j] = BASE + positionBonus(j);
  }

  for (let i = m - 2; i >= 0; i--) {
    const ch = q[i]!;
    const fi = f[i]!;
    const fnext = f[i + 1]!;
    const ni = nextPos[i]!;
    for (let j = 0; j < n; j++) {
      if (t[j] !== ch) continue;
      let best = NEG;
      let bestNext = -1;
      for (let j2 = j + 1; j2 < n; j2++) {
        const sub = fnext[j2]!;
        if (sub === NEG) continue;
        const val = (j2 === j + 1 ? CONTIGUOUS_BONUS : 0) + sub;
        if (val > best) {
          best = val;
          bestNext = j2;
        }
      }
      if (best === NEG) continue; // q[i+1..] cannot be placed after j
      fi[j] = BASE + positionBonus(j) + best;
      ni[j] = bestNext;
    }
  }

  // Best starting placement for q[0] (leftmost on ties, keeping it deterministic).
  let bestScore = NEG;
  let start = -1;
  const f0 = f[0]!;
  for (let j = 0; j < n; j++) {
    if (f0[j]! > bestScore) {
      bestScore = f0[j]!;
      start = j;
    }
  }
  if (start === -1) return null;

  // The exact/prefix tier (M24.4): when the query IS the target's start, that
  // alignment (positions 0..m-1) + PREFIX_EXTRA competes with the DP's best —
  // and effectively always wins, so prefix matches rank first however many
  // word-start bonuses a scattered alignment collected.
  if (t.startsWith(q)) {
    const prefixScore = m * BASE + START_BONUS + (m - 1) * CONTIGUOUS_BONUS + PREFIX_EXTRA;
    if (prefixScore >= bestScore) {
      return { score: prefixScore, positions: Array.from({ length: m }, (_, i) => i) };
    }
  }

  const positions: number[] = [];
  let j = start;
  for (let i = 0; i < m && j !== -1; i++) {
    positions.push(j);
    j = nextPos[i]![j]!;
  }
  return { score: bestScore, positions };
}

/**
 * Filter `items` by `query`, keeping only fuzzy matches, sorted by score
 * descending. The sort is STABLE — items with equal scores keep their input
 * order. An empty query returns every item (score 0) in original order.
 */
export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string): FuzzyMatch<T>[] {
  const matches: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const m = fuzzyMatch(query, key(item));
    if (m) matches.push({ item, score: m.score, positions: m.positions });
  }
  // Stable sort by score desc: Array.prototype.sort is stable in modern JS, so
  // equal scores preserve the push (input) order.
  matches.sort((a, b) => b.score - a.score);
  return matches;
}
