/**
 * Tiered query-match scoring helpers, ported from t3
 * (context/t3code/packages/shared/src/searchRanking.ts).
 *
 * Used by the command palette (and any future search surface) to rank
 * results across heterogeneous categories with consistent semantics:
 *   - lower score = better match
 *   - exact > prefix > word-boundary > includes > fuzzy-subsequence
 * Inputs MUST be pre-normalized (trimmed + lowercased) via
 * `normalizeSearchQuery` or equivalent.
 */

export type RankedSearchResult<T> = {
  item: T;
  score: number;
  tieBreaker: string;
};

export function normalizeSearchQuery(
  input: string,
  options?: {
    trimLeadingPattern?: RegExp;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return options?.trimLeadingPattern
    ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase()
    : trimmed.toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[],
): number | null {
  let bestIndex: number | null = null;
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) bestIndex = matchIndex;
  }
  return bestIndex;
}

export function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) return null;

  if (value === query) return input.exactBase;

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/"],
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) return input.fuzzyBase + fuzzyScore;
  }

  return null;
}

export function compareRankedSearchResults<T>(
  left: RankedSearchResult<T>,
  right: RankedSearchResult<T>,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function findInsertionIndex<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
): number {
  let low = 0;
  let high = rankedEntries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) break;
    if (compareRankedSearchResults(candidate, current) < 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function insertRankedSearchResult<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
  limit: number,
): void {
  if (limit <= 0) return;
  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }
  if (insertionIndex >= limit) return;
  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

/**
 * Generic palette-item ranker: scores `label` then `description` then
 * `keywords` joined by spaces. Returns null when nothing matches.
 *
 * Mirrors the tiered scoring in t3's `providerSkillSearch.scoreProviderSkill`
 * but with category-agnostic field bases so it applies to any palette row.
 */
export function scorePaletteFields(input: {
  label: string;
  description?: string | null;
  keywords?: ReadonlyArray<string>;
  query: string;
  boundaryMarkers?: readonly string[];
}): number | null {
  const label = input.label.toLowerCase();
  const description = input.description?.toLowerCase() ?? "";
  const keywords = (input.keywords ?? []).join(" ").toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: label,
      query: input.query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: input.boundaryMarkers,
    }),
    scoreQueryMatch({
      value: description,
      query: input.query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: keywords,
      query: input.query,
      exactBase: 15,
      prefixBase: 17,
      boundaryBase: 19,
      includesBase: 21,
    }),
  ].filter((s): s is number => s !== null);

  if (scores.length === 0) return null;
  return Math.min(...scores);
}
