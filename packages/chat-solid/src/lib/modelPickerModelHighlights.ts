/**
 * Models flagged with a gold "NEW" chip in the picker list. Keyed by
 * `${driverKind}:${slug}` so two providers can ship a same-named
 * model without clobbering each other.
 *
 * Edit this set when a freshly released model lands — the row reads
 * the badge purely from this static map. Mark it stale by deleting
 * the entry once the model is no longer "new" enough to highlight.
 *
 * Examples (left commented as anchors for the next bump):
 *
 *   "claude-code:claude-opus-4-7"
 *   "codex:gpt-5-codex"
 */

const NEW_MODEL_KEYS: ReadonlySet<string> = new Set<string>([
  "claude-code:claude-opus-4-7",
  "claude-code:claude-sonnet-4-6",
]);

/**
 * Optional companion set for "RECOMMENDED" badges. Same key format
 * as the new-model set. Surfaces a quieter blue chip — used as the
 * editorial nudge for default-pick guidance ("we suggest this one").
 */
const RECOMMENDED_MODEL_KEYS: ReadonlySet<string> = new Set<string>([
  "claude-code:claude-opus-4-7",
  "codex:gpt-5-codex",
  "gemini:gemini-2.5-pro",
]);

export function isModelPickerNewModel(driverKind: string, slug: string): boolean {
  return NEW_MODEL_KEYS.has(`${driverKind}:${slug}`);
}

export function isModelPickerRecommendedModel(driverKind: string, slug: string): boolean {
  return RECOMMENDED_MODEL_KEYS.has(`${driverKind}:${slug}`);
}
