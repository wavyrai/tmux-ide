/**
 * Character-range authorship tracking for plan files.
 *
 * Follows the @proof/core marks model: each mark tracks authorship at the
 * character range level with quote-based re-anchoring when positions shift.
 *
 * @module authorship
 */

// ============================================================================
// Types (following @proof/core marks model)
// ============================================================================

export type MarkKind =
  | "authored"
  | "approved"
  | "flagged"
  | "comment"
  | "insert"
  | "delete"
  | "replace";

export interface MarkRange {
  from: number;
  to: number;
}

export interface Mark {
  id: string;
  kind: MarkKind;
  by: string; // "ai:François" or "human:thijs"
  at: string; // ISO timestamp
  range: MarkRange; // character positions in the clean content
  quote: string; // text content for re-anchoring
  orphaned?: boolean;
}

export interface MarksDocument {
  version: number;
  marks: Record<string, Mark>;
}

export interface AuthorshipStats {
  aiPercent: number;
  humanPercent: number;
  totalChars: number;
}

// ============================================================================
// Comment block format
// ============================================================================

const MARKS_START = "<!-- TMUX-IDE:MARKS";
const MARKS_END = "-->";

// ============================================================================
// ID generation
// ============================================================================

let markIdCounter = 0;

export function generateMarkId(): string {
  return `m${Date.now()}_${++markIdCounter}`;
}

// ============================================================================
// Quote normalization (matches @proof/core)
// ============================================================================

export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ============================================================================
// Extract / Embed
// ============================================================================

/**
 * Extract marks from a markdown file.
 * Returns clean content (without the comment block) and parsed marks.
 */
export function extractMarks(markdown: string): {
  content: string;
  marks: MarksDocument | null;
} {
  const startIdx = markdown.lastIndexOf(MARKS_START);
  if (startIdx === -1) {
    return { content: markdown, marks: null };
  }

  const endIdx = markdown.indexOf(MARKS_END, startIdx + MARKS_START.length);
  if (endIdx === -1) {
    return { content: markdown, marks: null };
  }

  const jsonStr = markdown.slice(startIdx + MARKS_START.length, endIdx).trim();
  const content = (
    markdown.slice(0, startIdx) + markdown.slice(endIdx + MARKS_END.length)
  ).trimEnd();

  try {
    const data = JSON.parse(jsonStr) as MarksDocument;
    return { content, marks: data };
  } catch {
    return { content, marks: null };
  }
}

/**
 * Embed marks into a markdown file.
 * Strips any existing marks comment and appends a new one at the end.
 */
export function embedMarks(markdown: string, doc: MarksDocument): string {
  const { content } = extractMarks(markdown);
  const json = JSON.stringify(doc, null, 2);
  return `${content}\n\n${MARKS_START}\n${json}\n${MARKS_END}\n`;
}

// ============================================================================
// Mark creation helpers
// ============================================================================

export function createAuthored(by: string, range: MarkRange, quote: string): Mark {
  return {
    id: generateMarkId(),
    kind: "authored",
    by,
    at: new Date().toISOString(),
    range,
    quote: normalizeQuote(quote),
  };
}

// ============================================================================
// Stats calculation
// ============================================================================

/**
 * Calculate AI vs human authorship percentages from marks.
 * Only counts 'authored' marks. Uses character range lengths.
 */
export function calculateStats(marks: Record<string, Mark>): AuthorshipStats {
  let aiChars = 0;
  let humanChars = 0;

  for (const mark of Object.values(marks)) {
    if (mark.kind !== "authored") continue;
    if (mark.orphaned) continue;
    const chars = mark.range.to - mark.range.from;
    if (mark.by.startsWith("ai:") || mark.by === "ai") {
      aiChars += chars;
    } else {
      humanChars += chars;
    }
  }

  const totalChars = aiChars + humanChars;
  if (totalChars === 0) {
    return { aiPercent: 0, humanPercent: 0, totalChars: 0 };
  }

  return {
    aiPercent: Math.round((aiChars / totalChars) * 100),
    humanPercent: Math.round((humanChars / totalChars) * 100),
    totalChars,
  };
}

// ============================================================================
// Re-anchoring: recover positions when content shifts
// ============================================================================

/**
 * Find the position of a quote in content text.
 * Returns { from, to } or null if not found.
 */
function findQuotePosition(content: string, quote: string): MarkRange | null {
  if (!quote) return null;
  const normalized = normalizeQuote(quote);
  const normalizedContent = normalizeQuote(content);
  const idx = normalizedContent.indexOf(normalized);
  if (idx === -1) return null;

  // Map back to original content positions (approximate — whitespace may differ)
  // Walk through original content counting normalized chars
  let origFrom = -1;
  let normalizedPos = 0;
  for (let i = 0; i < content.length; i++) {
    if (/\s/.test(content[i]!) && (i === 0 || /\s/.test(content[i - 1]!))) continue;
    if (normalizedPos === idx && origFrom === -1) origFrom = i;
    if (normalizedPos === idx + normalized.length) {
      return { from: origFrom, to: i };
    }
    normalizedPos++;
  }

  // Fallback: simple indexOf on original
  const simpleIdx = content.indexOf(quote);
  if (simpleIdx !== -1) {
    return { from: simpleIdx, to: simpleIdx + quote.length };
  }

  return null;
}

/**
 * Re-anchor marks whose ranges may have shifted due to content edits.
 * Uses quote text to find new positions. Marks orphaned if quote not found.
 */
export function reanchorMarks(content: string, marks: Record<string, Mark>): Record<string, Mark> {
  const result: Record<string, Mark> = {};

  for (const [id, mark] of Object.entries(marks)) {
    // Check if current range still matches quote
    const currentText = content.slice(mark.range.from, mark.range.to);
    if (normalizeQuote(currentText) === normalizeQuote(mark.quote)) {
      result[id] = mark;
      continue;
    }

    // Try to re-anchor using quote
    const newRange = findQuotePosition(content, mark.quote);
    if (newRange) {
      result[id] = { ...mark, range: newRange, orphaned: false };
    } else {
      result[id] = { ...mark, orphaned: true };
    }
  }

  return result;
}

// ============================================================================
// Tagging: tag entire content as authored by a given actor
// ============================================================================

/**
 * Tag the full content as authored by the given actor.
 * Preserves existing marks and only adds a mark for uncovered ranges.
 */
export function tagContent(markdown: string, by: string): string {
  const { content, marks: existingDoc } = extractMarks(markdown);
  const existingMarks = existingDoc?.marks ?? {};

  // Re-anchor existing marks against current content
  const anchored =
    Object.keys(existingMarks).length > 0 ? reanchorMarks(content, existingMarks) : {};

  // Find uncovered character ranges
  const covered = new Set<number>();
  for (const mark of Object.values(anchored)) {
    if (mark.kind !== "authored" || mark.orphaned) continue;
    for (let i = mark.range.from; i < mark.range.to && i < content.length; i++) {
      covered.add(i);
    }
  }

  // Build marks for uncovered ranges (coalesce adjacent)
  const newMarks: Record<string, Mark> = { ...anchored };
  let rangeStart = -1;

  for (let i = 0; i <= content.length; i++) {
    const isCovered = covered.has(i);
    const atEnd = i === content.length;

    if (!isCovered && !atEnd && rangeStart === -1) {
      rangeStart = i;
    } else if ((isCovered || atEnd) && rangeStart !== -1) {
      const quote = content.slice(rangeStart, i);
      if (quote.trim().length > 0) {
        const mark = createAuthored(by, { from: rangeStart, to: i }, quote);
        newMarks[mark.id] = mark;
      }
      rangeStart = -1;
    }
  }

  const doc: MarksDocument = { version: 2, marks: newMarks };
  return embedMarks(content, doc);
}
