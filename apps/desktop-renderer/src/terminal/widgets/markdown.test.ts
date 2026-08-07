import { describe, expect, it } from "vitest";

import {
  isSafeMarkdownHref,
  markdownInlineText,
  parseInline,
  parseMarkdown,
  type MarkdownBlock,
} from "./markdown.ts";

function kinds(blocks: readonly MarkdownBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

describe("markdown blocks", () => {
  it("parses the shapes an agent actually emits", () => {
    const blocks = parseMarkdown(
      [
        "# Plan",
        "",
        "Two things, then a check.",
        "",
        "1. Build it",
        "2. Test it",
        "",
        "> Careful with the second one.",
        "",
        "```bash",
        "pnpm test",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(kinds(blocks)).toEqual(["heading", "paragraph", "list", "quote", "code", "rule"]);
  });

  it("keeps a fenced block's text verbatim, including its markdown characters", () => {
    const [block] = parseMarkdown("```ts\nconst x = `**not bold**`;\n  indented\n```");
    expect(block).toEqual({
      kind: "code",
      language: "ts",
      text: "const x = `**not bold**`;\n  indented",
    });
  });

  it("closes an unterminated fence at the end of the document", () => {
    // A streamed document can be cut off mid-code; it should still read as code.
    const [block] = parseMarkdown("```\nhalf a comm");
    expect(block).toEqual({ kind: "code", language: null, text: "half a comm" });
  });

  it("starts an ordered list at the number the author wrote", () => {
    const [block] = parseMarkdown("4. four\n5. five");
    expect(block).toMatchObject({ kind: "list", ordered: true, start: 4 });
  });

  it("reads task list items as checkboxes", () => {
    const [block] = parseMarkdown("- [x] done\n- [ ] pending\n- plain");
    expect(block).toMatchObject({ kind: "list", ordered: false });
    expect((block as Extract<MarkdownBlock, { kind: "list" }>).items.map((i) => i.checked)).toEqual(
      [true, false, null],
    );
  });

  it("nests a sublist under its parent item", () => {
    const [block] = parseMarkdown("- outer\n  - inner\n- second");
    const list = block as Extract<MarkdownBlock, { kind: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(kinds(list.items[0]!.blocks)).toEqual(["paragraph", "list"]);
  });

  it("does not swallow a list written directly under a paragraph", () => {
    expect(kinds(parseMarkdown("Steps:\n- one\n- two"))).toEqual(["paragraph", "list"]);
  });

  it("parses a GFM table with its column alignments", () => {
    const [block] = parseMarkdown(
      ["| Key | Value |", "| :-- | ----: |", "| a | 1 |", "| b | 2 |"].join("\n"),
    );
    const table = block as Extract<MarkdownBlock, { kind: "table" }>;
    expect(table.kind).toBe("table");
    expect(table.alignments).toEqual(["left", "right"]);
    expect(table.head.map(markdownInlineText)).toEqual(["Key", "Value"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]!.map(markdownInlineText)).toEqual(["b", "2"]);
  });

  it("treats a pipe-bearing line without a divider as a paragraph", () => {
    expect(kinds(parseMarkdown("a | b | c"))).toEqual(["paragraph"]);
  });

  it("produces nothing at all for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});

describe("markdown inline", () => {
  it("parses emphasis, strong, strike and code", () => {
    expect(parseInline("*a* **b** ~~c~~ `d`").map((node) => node.kind)).toEqual([
      "emphasis",
      "text",
      "strong",
      "text",
      "strike",
      "text",
      "code",
    ]);
  });

  /*
   * Bug this catches: a plan that documents a shell command in backticks gets
   * its asterisks eaten as emphasis, and the user is shown a command they
   * cannot copy. Code spans win, and their contents are never re-scanned.
   */
  it("never reinterprets the inside of a code span", () => {
    expect(parseInline("`rm -rf **/*.log`")).toEqual([{ kind: "code", text: "rm -rf **/*.log" }]);
  });

  it("honours backslash escapes", () => {
    expect(parseInline("\\*not emphasis\\*")).toEqual([{ kind: "text", text: "*not emphasis*" }]);
  });

  it("keeps a safe link and strips an unsafe one to its text", () => {
    expect(parseInline("[docs](https://example.com/x)")).toEqual([
      { kind: "link", href: "https://example.com/x", content: [{ kind: "text", text: "docs" }] },
    ]);
    // The unsafe target keeps its label and produces no link node at all, so
    // there is nothing for a user to click and nothing carrying the scheme.
    const unsafe = parseInline("[click](javascript:alert(1))");
    expect(unsafe.some((node) => node.kind === "link")).toBe(false);
    expect(markdownInlineText(unsafe)).toContain("click");
  });

  it("turns a soft newline inside a paragraph into a line break", () => {
    expect(parseInline("one\ntwo").map((node) => node.kind)).toEqual(["text", "break", "text"]);
  });

  it("leaves unmatched punctuation as ordinary text", () => {
    expect(parseInline("2 * 3 * 4 = 24")).toEqual([{ kind: "text", text: "2 * 3 * 4 = 24" }]);
  });
});

describe("link safety", () => {
  it("permits only schemes that cannot execute or read the disk", () => {
    for (const href of ["https://a.test", "http://a.test", "mailto:a@b.test", "#anchor", "./rel"]) {
      expect(isSafeMarkdownHref(href), href).toBe(true);
    }
    for (const href of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "vbscript:x",
      "",
    ]) {
      expect(isSafeMarkdownHref(href), href).toBe(false);
    }
  });
});
