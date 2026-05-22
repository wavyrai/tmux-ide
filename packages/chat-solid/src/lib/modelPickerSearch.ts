/**
 * Search/ranking helpers for the model picker. Ported from the
 * upstream chat surface; the upstream version composes
 * `@t3tools/shared/searchRanking` which isn't published for our
 * tree, so we inline a minimal compatible subset:
 *
 *   - `normalizeSearchQuery` — trim + lowercase
 *   - `scoreQueryMatch`     — tiered match (exact > prefix > boundary
 *                              > includes > fuzzy subsequence) with
 *                              configurable base costs (LOWER score is
 *                              BETTER — matches the upstream contract).
 *   - `scoreModelPickerSearch` / `buildModelPickerSearchText` —
 *     model-aware wrappers that look at name + shortName +
 *     subProvider + driverKind + providerDisplayName, then apply a
 *     small favorite boost so favourited models sort first on ties.
 *
 * Returns `null` to mean "no match" — callers filter on that. A
 * score of 0 means perfect-exact match.
 */

export interface ModelPickerSearchableModel {
  driverKind: string;
  providerDisplayName: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isFavorite?: boolean;
}

const FAVORITE_SCORE_BOOST = 24;

export function normalizeSearchQuery(input: string): string {
  return input.trim().toLowerCase();
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  markers: readonly string[],
): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    const idx = value.indexOf(`${marker}${query}`);
    if (idx === -1) continue;
    const matchIdx = idx + marker.length;
    if (best === null || matchIdx < best) best = matchIdx;
  }
  return best;
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatch = -1;
  let prevMatch = -1;
  let gap = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== query[queryIndex]) continue;
    if (firstMatch === -1) firstMatch = i;
    if (prevMatch !== -1) gap += i - prevMatch - 1;
    prevMatch = i;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const span = i - firstMatch + 1 - query.length;
      return firstMatch * 2 + gap * 3 + span + Math.min(64, value.length - query.length);
    }
  }
  return null;
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
    const idx = findBoundaryMatchIndex(value, query, input.boundaryMarkers ?? [" ", "-", "_", "/"]);
    if (idx !== null) return input.boundaryBase + idx * 2 + lengthPenalty(value, query);
  }
  if (input.includesBase !== undefined) {
    const idx = value.indexOf(query);
    if (idx !== -1) return input.includesBase + idx * 2 + lengthPenalty(value, query);
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) return input.fuzzyBase + fuzzy;
  }
  return null;
}

function getModelPickerSearchFields(model: ModelPickerSearchableModel): string[] {
  return [
    normalizeSearchQuery(model.name),
    ...(model.shortName ? [normalizeSearchQuery(model.shortName)] : []),
    ...(model.subProvider ? [normalizeSearchQuery(model.subProvider)] : []),
    normalizeSearchQuery(model.driverKind),
    normalizeSearchQuery(model.providerDisplayName),
    buildModelPickerSearchText(model),
  ];
}

function scoreToken(field: string, token: string, fieldBase: number): number | null {
  return scoreQueryMatch({
    value: field,
    query: token,
    exactBase: fieldBase,
    prefixBase: fieldBase + 2,
    boundaryBase: fieldBase + 4,
    includesBase: fieldBase + 6,
    ...(token.length >= 3 ? { fuzzyBase: fieldBase + 100 } : {}),
  });
}

export function buildModelPickerSearchText(model: ModelPickerSearchableModel): string {
  return normalizeSearchQuery(
    [model.name, model.shortName, model.subProvider, model.driverKind, model.providerDisplayName]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" "),
  );
}

export function scoreModelPickerSearch(
  model: ModelPickerSearchableModel,
  query: string,
): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;

  const fields = getModelPickerSearchFields(model);
  let score = 0;
  for (const token of tokens) {
    const tokenScores = fields
      .map((field, index) => scoreToken(field, token, index * 10))
      .filter((s): s is number => s !== null);
    if (tokenScores.length === 0) return null;
    score += Math.min(...tokenScores);
  }
  return model.isFavorite ? score - FAVORITE_SCORE_BOOST : score;
}
