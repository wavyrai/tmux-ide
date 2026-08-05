/**
 * Markdown, parsed to a typed tree.
 *
 * PURE — no DOM, no HTML string, no sanitiser. The renderer walks this tree and
 * creates elements, so there is no path by which document text becomes markup:
 * the usual "render markdown, then sanitise the HTML" hazard does not exist
 * here, and neither does the CSP exposure that comes with `innerHTML`.
 *
 * The dialect is the common subset an agent actually emits — headings, fenced
 * code, lists, quotes, rules, GFM tables, and inline emphasis/code/links. It is
 * deliberately not CommonMark-complete; anything unrecognised degrades to text
 * rather than being dropped.
 */

export type MarkdownAlignment = "left" | "center" | "right" | null;

export type MarkdownInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "emphasis"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "strike"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "link"; readonly href: string; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "break" };

export interface MarkdownListItem {
  readonly blocks: readonly MarkdownBlock[];
  /** `- [x] done` renders a real (disabled) checkbox; null when not a task item. */
  readonly checked: boolean | null;
}

export type MarkdownBlock =
  | {
      readonly kind: "heading";
      readonly level: number;
      readonly content: readonly MarkdownInline[];
    }
  | { readonly kind: "paragraph"; readonly content: readonly MarkdownInline[] }
  | { readonly kind: "code"; readonly language: string | null; readonly text: string }
  | { readonly kind: "quote"; readonly blocks: readonly MarkdownBlock[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly start: number;
      readonly items: readonly MarkdownListItem[];
    }
  | { readonly kind: "rule" }
  | {
      readonly kind: "table";
      readonly alignments: readonly MarkdownAlignment[];
      readonly head: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    };

/**
 * Link schemes a rendered document may navigate to.
 *
 * `javascript:` and `data:` are the two that turn a document into code, and
 * `file:` would let a pasted plan read the user's disk. A link with any other
 * scheme keeps its text and loses its href — visible, inert, and not silently
 * discarded.
 */
const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeMarkdownHref(href: string): boolean {
  const value = href.trim();
  if (value.length === 0) return false;
  // Relative and anchor links never leave the document and carry no scheme.
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./")) return true;
  try {
    return SAFE_LINK_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

const HEADING = /^(#{1,6})\s+(.*)$/u;
const FENCE = /^(?:```|~~~)\s*([A-Za-z0-9_+.-]*)\s*$/u;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const QUOTE = /^>\s?(.*)$/u;
const BULLET = /^([-*+])\s+(.*)$/u;
const ORDERED = /^(\d{1,9})[.)]\s+(.*)$/u;
const TASK = /^\[([ xX])\]\s+(.*)$/u;
const TABLE_DIVIDER = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/u;

/** Leading spaces, with a tab counted as four columns. */
function indentWidth(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") width += 1;
    else if (character === "\t") width += 4;
    else break;
  }
  return width;
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  return parseBlocks(source.replace(/\r\n?/gu, "\n").split("\n"));
}

function parseBlocks(lines: readonly string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(trimmed);
    if (fence) {
      const language = fence[1]!.length > 0 ? fence[1]! : null;
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the document rather than
      // reverting to paragraphs: a truncated stream should still read as code.
      while (index < lines.length && !FENCE.test(lines[index]!.trim())) {
        body.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    if (RULE.test(trimmed)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading) {
      // Trailing hashes are decoration in the closed-ATX style, not content.
      const text = heading[2]!.replace(/\s+#+\s*$/u, "");
      blocks.push({ kind: "heading", level: heading[1]!.length, content: parseInline(text) });
      index += 1;
      continue;
    }

    if (QUOTE.test(trimmed)) {
      const inner: string[] = [];
      while (index < lines.length) {
        const quote = QUOTE.exec(lines[index]!.trim());
        if (!quote) break;
        inner.push(quote[1]!);
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    const table = parseTableAt(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    if (BULLET.test(trimmed) || ORDERED.test(trimmed)) {
      const list = parseListAt(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index]!;
      const candidateTrimmed = candidate.trim();
      if (candidateTrimmed === "") break;
      // A paragraph ends where any other block begins, so a list or heading
      // written directly under a line of prose is not swallowed into it.
      if (
        HEADING.test(candidateTrimmed) ||
        FENCE.test(candidateTrimmed) ||
        RULE.test(candidateTrimmed) ||
        QUOTE.test(candidateTrimmed) ||
        BULLET.test(candidateTrimmed) ||
        ORDERED.test(candidateTrimmed)
      ) {
        break;
      }
      paragraph.push(candidate.trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", content: parseInline(paragraph.join("\n")) });
    }
  }

  return blocks;
}

function parseListAt(
  lines: readonly string[],
  start: number,
): { block: MarkdownBlock; next: number } {
  const first = lines[start]!.trim();
  const ordered = ORDERED.test(first) && !BULLET.test(first);
  const firstOrdered = ORDERED.exec(first);
  const startNumber = ordered && firstOrdered ? Number.parseInt(firstOrdered[1]!, 10) : 1;
  const baseIndent = indentWidth(lines[start]!);
  const items: MarkdownListItem[] = [];
  let index = start;
  let current: string[] | null = null;
  let currentChecked: boolean | null = null;

  const flush = (): void => {
    if (current === null) return;
    items.push({ blocks: parseBlocks(current), checked: currentChecked });
    current = null;
    currentChecked = null;
  };

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      // A blank line inside an item's continuation keeps the list open; two in
      // a row (or a blank line at the end) close it.
      const next = lines[index + 1];
      if (next === undefined || next.trim() === "") break;
      if (indentWidth(next) <= baseIndent && !isListMarker(next.trim())) break;
      current?.push("");
      index += 1;
      continue;
    }

    const indent = indentWidth(line);
    const marker = isListMarker(trimmed);
    if (marker && indent <= baseIndent) {
      if (indent < baseIndent) break;
      const bullet = BULLET.exec(trimmed);
      const numbered = ORDERED.exec(trimmed);
      const isOrdered = Boolean(numbered) && !bullet;
      // A change of list kind at the same indent starts a NEW list rather than
      // silently re-labelling the items already collected.
      if (isOrdered !== ordered) break;
      flush();
      let content = (bullet ? bullet[2] : numbered![2])!;
      const task = TASK.exec(content);
      if (task) {
        currentChecked = task[1]!.toLowerCase() === "x";
        content = task[2]!;
      }
      current = [content];
      index += 1;
      continue;
    }

    if (indent > baseIndent && current !== null) {
      // Continuation: strip the item's own indent so a nested list is measured
      // from its parent rather than from column zero.
      current.push(line.slice(Math.min(indent, baseIndent + 2)));
      index += 1;
      continue;
    }

    break;
  }

  flush();
  return { block: { kind: "list", ordered, start: startNumber, items }, next: index };
}

function isListMarker(trimmed: string): boolean {
  return BULLET.test(trimmed) || ORDERED.test(trimmed);
}

function parseTableAt(
  lines: readonly string[],
  start: number,
): { block: MarkdownBlock; next: number } | null {
  const header = lines[start]!.trim();
  const divider = lines[start + 1]?.trim();
  if (!header.includes("|") || divider === undefined || !TABLE_DIVIDER.test(divider)) return null;

  const headCells = splitTableRow(header);
  const alignments = splitTableRow(divider).map((cell): MarkdownAlignment => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
  if (headCells.length === 0 || alignments.length !== headCells.length) return null;

  const rows: MarkdownInline[][][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    if (line === "" || !line.includes("|")) break;
    const cells = splitTableRow(line);
    // Ragged rows are padded rather than rejected: a truncated stream should
    // still render the rows it did deliver.
    while (cells.length < headCells.length) cells.push("");
    rows.push(cells.slice(0, headCells.length).map((cell) => parseInline(cell)));
    index += 1;
  }

  return {
    block: {
      kind: "table",
      alignments,
      head: headCells.map((cell) => parseInline(cell)),
      rows,
    },
    next: index,
  };
}

function splitTableRow(line: string): string[] {
  const body = line.replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let buffer = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "\\" && body[index + 1] === "|") {
      buffer += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += character;
  }
  cells.push(buffer.trim());
  return cells;
}

interface InlineRule {
  readonly pattern: RegExp;
  readonly build: (match: RegExpExecArray) => MarkdownInline;
}

/**
 * Inline rules, in precedence order.
 *
 * Code spans come FIRST and their content is never re-scanned, so `` `**x**` ``
 * renders the asterisks the author typed rather than turning them into markup —
 * which for a document full of agent-emitted shell and JSON is the difference
 * between a readable plan and a mangled one.
 */
const INLINE_RULES: readonly InlineRule[] = [
  {
    pattern: /^`+([^`]+?)`+/u,
    build: (match) => ({ kind: "code", text: match[1]! }),
  },
  {
    pattern: /^!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/u,
    build: (match) => {
      const href = match[2]!;
      const content = parseInline(match[1]!);
      if (!isSafeMarkdownHref(href)) {
        return { kind: "text", text: match[1]!.length > 0 ? match[1]! : href };
      }
      return { kind: "link", href, content };
    },
  },
  {
    pattern: /^<((?:https?|mailto):[^>\s]+)>/u,
    build: (match) => ({
      kind: "link",
      href: match[1]!,
      content: [{ kind: "text", text: match[1]! }],
    }),
  },
  {
    pattern: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/u,
    build: (match) => ({ kind: "strong", content: parseInline(match[2]!) }),
  },
  {
    pattern: /^~~(?=\S)([\s\S]*?\S)~~/u,
    build: (match) => ({ kind: "strike", content: parseInline(match[1]!) }),
  },
  {
    pattern: /^(\*|_)(?=\S)([\s\S]*?\S)\1/u,
    build: (match) => ({ kind: "emphasis", content: parseInline(match[2]!) }),
  },
];

export function parseInline(source: string): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  let pending = "";
  let rest = source;

  const flush = (): void => {
    if (pending.length === 0) return;
    nodes.push({ kind: "text", text: pending });
    pending = "";
  };

  while (rest.length > 0) {
    if (rest.startsWith("\\") && rest.length > 1) {
      // A backslash escape is the author saying "this character is text".
      pending += rest[1]!;
      rest = rest.slice(2);
      continue;
    }
    if (rest.startsWith("\n")) {
      flush();
      nodes.push({ kind: "break" });
      rest = rest.slice(1);
      continue;
    }

    let matched = false;
    for (const rule of INLINE_RULES) {
      const match = rule.pattern.exec(rest);
      if (!match) continue;
      flush();
      nodes.push(rule.build(match));
      rest = rest.slice(match[0].length);
      matched = true;
      break;
    }
    if (matched) continue;

    pending += rest[0]!;
    rest = rest.slice(1);
  }

  flush();
  return nodes;
}

/** Plain text of an inline tree — for aria labels and test assertions. */
export function markdownInlineText(content: readonly MarkdownInline[]): string {
  return content
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return " ";
        default:
          return markdownInlineText(node.content);
      }
    })
    .join("");
}
