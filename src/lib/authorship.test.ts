import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractAuthorship,
  embedAuthorship,
  calculateStats,
  parseMarkdownSections,
  tagAuthorship,
  type SectionAuthorship,
  type AuthorshipData,
} from "./authorship.ts";

describe("parseMarkdownSections", () => {
  it("splits markdown by headings", () => {
    const md = `# Title

Intro text here.

## Section One

Content of section one.

## Section Two

Content of section two.
`;
    const sections = parseMarkdownSections(md);
    assert.strictEqual(sections.length, 3);
    assert.strictEqual(sections[0]!.heading, "Title");
    assert.strictEqual(sections[1]!.heading, "Section One");
    assert.strictEqual(sections[2]!.heading, "Section Two");
    assert.ok(sections[1]!.content.includes("Content of section one"));
    assert.ok(sections[1]!.charCount > 0);
  });

  it("handles intro content before first heading", () => {
    const md = `Some intro text.

## First Section

Content here.
`;
    const sections = parseMarkdownSections(md);
    assert.strictEqual(sections.length, 2);
    assert.strictEqual(sections[0]!.heading, "(intro)");
    assert.ok(sections[0]!.content.includes("Some intro text"));
  });

  it("returns empty for empty markdown", () => {
    assert.deepStrictEqual(parseMarkdownSections(""), []);
    assert.deepStrictEqual(parseMarkdownSections("   \n\n  "), []);
  });

  it("handles h3 headings", () => {
    const md = `### Sub heading\n\nContent.`;
    const sections = parseMarkdownSections(md);
    assert.strictEqual(sections.length, 1);
    assert.strictEqual(sections[0]!.heading, "Sub heading");
  });
});

describe("calculateStats", () => {
  it("calculates AI vs human percentages", () => {
    const sections: Record<string, SectionAuthorship> = {
      Intro: { author: "ai:François", at: "2026-01-01T00:00:00Z", charCount: 300 },
      Plan: { author: "human:thijs", at: "2026-01-01T00:00:00Z", charCount: 200 },
    };
    const stats = calculateStats(sections);
    assert.strictEqual(stats.totalChars, 500);
    assert.strictEqual(stats.aiPercent, 60);
    assert.strictEqual(stats.humanPercent, 40);
  });

  it("returns 100% AI when all sections are AI", () => {
    const sections: Record<string, SectionAuthorship> = {
      A: { author: "ai:Amélie", at: "2026-01-01T00:00:00Z", charCount: 100 },
      B: { author: "ai:Louis", at: "2026-01-01T00:00:00Z", charCount: 100 },
    };
    const stats = calculateStats(sections);
    assert.strictEqual(stats.aiPercent, 100);
    assert.strictEqual(stats.humanPercent, 0);
  });

  it("returns zeros for empty sections", () => {
    const stats = calculateStats({});
    assert.strictEqual(stats.totalChars, 0);
    assert.strictEqual(stats.aiPercent, 0);
    assert.strictEqual(stats.humanPercent, 0);
  });

  it("treats 'human' (without colon) as human", () => {
    const sections: Record<string, SectionAuthorship> = {
      A: { author: "human", at: "2026-01-01T00:00:00Z", charCount: 100 },
    };
    assert.strictEqual(calculateStats(sections).humanPercent, 100);
  });

  it("treats 'ai' (without colon) as AI", () => {
    const sections: Record<string, SectionAuthorship> = {
      A: { author: "ai", at: "2026-01-01T00:00:00Z", charCount: 100 },
    };
    assert.strictEqual(calculateStats(sections).aiPercent, 100);
  });
});

describe("extractAuthorship", () => {
  it("extracts authorship from markdown with comment block", () => {
    const authorship: AuthorshipData = {
      sections: {
        Plan: { author: "ai:François", at: "2026-01-01T00:00:00Z", charCount: 100 },
      },
      stats: { aiPercent: 100, humanPercent: 0, totalChars: 100 },
    };
    const md = `## Plan\n\nContent here.\n\n<!-- TMUX-IDE:AUTHORSHIP\n${JSON.stringify(authorship)}\n-->\n`;

    const result = extractAuthorship(md);
    assert.ok(result.authorship);
    assert.strictEqual(result.authorship!.stats.aiPercent, 100);
    assert.ok(result.content.includes("Content here"));
    assert.ok(!result.content.includes("TMUX-IDE:AUTHORSHIP"));
  });

  it("returns null authorship when no comment block", () => {
    const md = "## Plan\n\nJust content.";
    const result = extractAuthorship(md);
    assert.strictEqual(result.authorship, null);
    assert.strictEqual(result.content, md);
  });

  it("handles malformed JSON gracefully", () => {
    const md = "Content.\n\n<!-- TMUX-IDE:AUTHORSHIP\nnot json\n-->\n";
    const result = extractAuthorship(md);
    assert.strictEqual(result.authorship, null);
  });
});

describe("embedAuthorship", () => {
  it("appends authorship comment to markdown", () => {
    const md = "## Plan\n\nContent.";
    const authorship: AuthorshipData = {
      sections: {
        Plan: { author: "ai:François", at: "2026-01-01T00:00:00Z", charCount: 8 },
      },
      stats: { aiPercent: 100, humanPercent: 0, totalChars: 8 },
    };

    const result = embedAuthorship(md, authorship);
    assert.ok(result.includes("Content."));
    assert.ok(result.includes("TMUX-IDE:AUTHORSHIP"));
    assert.ok(result.includes('"ai:François"'));
  });

  it("replaces existing authorship comment", () => {
    const oldAuthorship: AuthorshipData = {
      sections: {},
      stats: { aiPercent: 0, humanPercent: 0, totalChars: 0 },
    };
    const md = `## Plan\n\nContent.\n\n<!-- TMUX-IDE:AUTHORSHIP\n${JSON.stringify(oldAuthorship)}\n-->\n`;

    const newAuthorship: AuthorshipData = {
      sections: {
        Plan: { author: "human:thijs", at: "2026-01-01T00:00:00Z", charCount: 8 },
      },
      stats: { aiPercent: 0, humanPercent: 100, totalChars: 8 },
    };

    const result = embedAuthorship(md, newAuthorship);
    // Should have only one authorship block
    const count = (result.match(/TMUX-IDE:AUTHORSHIP/g) || []).length;
    assert.strictEqual(count, 1);
    assert.ok(result.includes('"human:thijs"'));
  });
});

describe("tagAuthorship", () => {
  it("tags all sections with the given author", () => {
    const md = "## Plan\n\nContent here.\n\n## Risks\n\nSome risks.";
    const result = tagAuthorship(md, "ai:François");

    const { authorship } = extractAuthorship(result);
    assert.ok(authorship);
    assert.strictEqual(Object.keys(authorship!.sections).length, 2);
    assert.strictEqual(authorship!.sections["Plan"]!.author, "ai:François");
    assert.strictEqual(authorship!.sections["Risks"]!.author, "ai:François");
    assert.strictEqual(authorship!.stats.aiPercent, 100);
  });

  it("preserves existing authorship for tagged sections", () => {
    const existingAuthorship: AuthorshipData = {
      sections: {
        Plan: { author: "human:thijs", at: "2025-01-01T00:00:00Z", charCount: 50 },
      },
      stats: { aiPercent: 0, humanPercent: 100, totalChars: 50 },
    };
    const md = `## Plan\n\nExisting content.\n\n## New Section\n\nNew stuff.\n\n<!-- TMUX-IDE:AUTHORSHIP\n${JSON.stringify(existingAuthorship)}\n-->\n`;

    const result = tagAuthorship(md, "ai:Amélie");
    const { authorship } = extractAuthorship(result);
    assert.ok(authorship);
    // Plan should keep human:thijs
    assert.strictEqual(authorship!.sections["Plan"]!.author, "human:thijs");
    // New Section should be tagged as ai:Amélie
    assert.strictEqual(authorship!.sections["New Section"]!.author, "ai:Amélie");
  });

  it("handles markdown with no headings", () => {
    const md = "Just some plain text without headings.";
    const result = tagAuthorship(md, "human");
    const { authorship } = extractAuthorship(result);
    assert.ok(authorship);
    assert.strictEqual(authorship!.sections["(intro)"]!.author, "human");
  });
});
