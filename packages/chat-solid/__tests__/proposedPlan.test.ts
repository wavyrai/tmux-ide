/**
 * Pure helpers — title extraction, collapsed preview, filename
 * derivation, normalization, and the collapse heuristic. These pin
 * the contract `ProposedPlanCard` relies on so a future tweak to
 * the card can't silently change the saved/downloaded payload.
 */

import { describe, expect, it } from "vitest";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  isProposedPlanCollapsible,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../src/lib/proposedPlan";

describe("proposedPlanTitle", () => {
  it("returns the first `#` heading stripped of pound signs", () => {
    expect(proposedPlanTitle("# Implement OAuth\n- step")).toBe("Implement OAuth");
  });

  it("handles `##` headings", () => {
    expect(proposedPlanTitle("## Refactor auth\n")).toBe("Refactor auth");
  });

  it("falls back to the first non-heading line", () => {
    expect(proposedPlanTitle("just a paragraph\nrest")).toBe("just a paragraph");
  });

  it("truncates long non-heading first lines", () => {
    const long = "x".repeat(120);
    const result = proposedPlanTitle(long);
    expect(result).not.toBe(null);
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result!.endsWith("...")).toBe(true);
  });

  it("returns null for empty input", () => {
    expect(proposedPlanTitle("")).toBeNull();
    expect(proposedPlanTitle("\n\n   ")).toBeNull();
  });
});

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  const sample = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n");

  it("returns the source when below the line cap", () => {
    expect(buildCollapsedProposedPlanPreviewMarkdown("a\nb\nc")).toBe("a\nb\nc");
  });

  it("clips to maxLines when above the cap", () => {
    const preview = buildCollapsedProposedPlanPreviewMarkdown(sample, { maxLines: 5 });
    expect(preview.split("\n").length).toBe(5);
    expect(preview).toBe("line 1\nline 2\nline 3\nline 4\nline 5");
  });

  it("defaults to 10 lines", () => {
    const preview = buildCollapsedProposedPlanPreviewMarkdown(sample);
    expect(preview.split("\n").length).toBe(10);
  });

  it("returns an empty string for maxLines <= 0", () => {
    expect(buildCollapsedProposedPlanPreviewMarkdown(sample, { maxLines: 0 })).toBe("");
  });
});

describe("buildProposedPlanMarkdownFilename", () => {
  it("kebab-cases the title and appends .md", () => {
    expect(buildProposedPlanMarkdownFilename("# Implement OAuth")).toBe("implement-oauth.md");
  });

  it("strips non-alphanumerics", () => {
    expect(buildProposedPlanMarkdownFilename("# Refactor: auth (v2)!")).toBe("refactor-auth-v2.md");
  });

  it("falls back to the default when no title is recoverable", () => {
    expect(buildProposedPlanMarkdownFilename("")).toBe("proposed-plan.md");
    expect(buildProposedPlanMarkdownFilename("# 🌈")).toBe("proposed-plan.md");
  });

  it("clips long titles to 64 chars", () => {
    const long = `# ${"x".repeat(120)}`;
    const result = buildProposedPlanMarkdownFilename(long);
    expect(result.endsWith(".md")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(64 + ".md".length);
  });
});

describe("normalizePlanMarkdownForExport", () => {
  it("strips trailing whitespace per line and forces a single trailing newline", () => {
    expect(normalizePlanMarkdownForExport("a   \nb\t  \n\n\n")).toBe("a\nb\n");
  });

  it("returns a single newline for empty input", () => {
    expect(normalizePlanMarkdownForExport("")).toBe("\n");
  });
});

describe("stripDisplayedPlanMarkdown", () => {
  it("currently identity — guards against a regression that would drop content", () => {
    const md = "# title\n- a\n- b\n";
    expect(stripDisplayedPlanMarkdown(md)).toBe(md);
  });
});

describe("isProposedPlanCollapsible", () => {
  it("returns true past the 900-char threshold", () => {
    expect(isProposedPlanCollapsible("x".repeat(901))).toBe(true);
  });

  it("returns true past the 20-line threshold", () => {
    const md = Array.from({ length: 21 }, () => "line").join("\n");
    expect(isProposedPlanCollapsible(md)).toBe(true);
  });

  it("returns false for short plans", () => {
    expect(isProposedPlanCollapsible("# tiny\nstep a")).toBe(false);
  });
});
