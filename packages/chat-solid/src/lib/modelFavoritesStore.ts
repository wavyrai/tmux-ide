/**
 * localStorage-backed model-picker favorites.
 *
 * Favorites are a flat list of `(kind, slug)` pairs the user starred
 * in the picker. Persistence mirrors `composerDraftStore`: a single
 * JSON key, defensive parsing, and a no-op in non-DOM (test/SSR)
 * environments so callers don't have to guard.
 */

export interface ModelFavorite {
  kind: string;
  slug: string;
}

const STORAGE_KEY = "tmux-ide:chat:model-favorites:v1";

function hasStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function favoriteKey(fav: ModelFavorite): string {
  return `${fav.kind}:${fav.slug}`;
}

export function loadModelFavorites(): ModelFavorite[] {
  if (!hasStorage()) return [];
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ModelFavorite =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ModelFavorite).kind === "string" &&
        typeof (entry as ModelFavorite).slug === "string",
    );
  } catch {
    return [];
  }
}

function saveModelFavorites(favorites: ReadonlyArray<ModelFavorite>): void {
  if (!hasStorage()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Quota / disabled storage — favorites degrade to session-only.
  }
}

/**
 * Toggle a favorite and persist. Returns the next list so the caller
 * can drive a signal off it without re-reading storage.
 */
export function toggleModelFavorite(
  current: ReadonlyArray<ModelFavorite>,
  fav: ModelFavorite,
): ModelFavorite[] {
  const key = favoriteKey(fav);
  const exists = current.some((entry) => favoriteKey(entry) === key);
  const next = exists ? current.filter((entry) => favoriteKey(entry) !== key) : [...current, fav];
  saveModelFavorites(next);
  return next;
}

export const __MODEL_FAVORITES_STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
