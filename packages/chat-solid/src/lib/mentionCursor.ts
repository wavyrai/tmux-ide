/**
 * Locates the @-mention token under the caret, if any.
 *
 * Active when the caret sits inside a `@<query>` token whose `@` is
 * either at the start of the input or preceded by whitespace.  The token
 * ends at the next whitespace or end-of-input.  The caret may be at the
 * `@` itself (empty query) or anywhere up to the end of the token.
 *
 * Mirrors the symmetry of `detectSlashContext`: the regex for sent-
 * message rendering lives in t3code's composer-editor-mentions.ts as
 * `/(^|\s)@([^\s@]+)(?=\s)/g` — that's the parser. This is the cursor-
 * aware variant the composer uses for autocomplete.
 */

export type MentionContext = { active: false } | { active: true; atIndex: number; query: string };

export function detectMentionContext(value: string, caret: number): MentionContext {
  const boundedCaret = Math.max(0, Math.min(caret, value.length));
  if (boundedCaret === 0) return { active: false };

  const atIndex = value.lastIndexOf("@", boundedCaret - 1);
  if (atIndex < 0) return { active: false };
  if (atIndex > 0 && !/\s/.test(value[atIndex - 1] ?? "")) {
    return { active: false };
  }

  const query = value.slice(atIndex + 1, boundedCaret);
  if (/\s/.test(query)) return { active: false };
  // Disallow nested @ to keep the regex narrow.
  if (query.includes("@")) return { active: false };

  return { active: true, atIndex, query };
}
