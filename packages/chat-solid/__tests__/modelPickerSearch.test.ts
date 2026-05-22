/**
 * Search/ranking helpers for the model picker. Lower score = better
 * match; `null` = no match. Tests pin the ordering invariants the
 * picker depends on (exact > prefix > boundary > includes > fuzzy)
 * and the favorite-boost contract.
 */

import { describe, expect, it } from "vitest";
import {
  buildModelPickerSearchText,
  normalizeSearchQuery,
  scoreModelPickerSearch,
  scoreQueryMatch,
} from "../src/lib/modelPickerSearch";

describe("normalizeSearchQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeSearchQuery("  Opus  ")).toBe("opus");
  });

  it("collapses to empty for whitespace-only input", () => {
    expect(normalizeSearchQuery("   ")).toBe("");
  });
});

describe("scoreQueryMatch", () => {
  it("returns exactBase on exact match", () => {
    expect(scoreQueryMatch({ value: "opus", query: "opus", exactBase: 10 })).toBe(10);
  });

  it("prefers prefix over boundary over includes when bases differ", () => {
    const prefix = scoreQueryMatch({
      value: "opus-4-7",
      query: "opus",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 100,
      includesBase: 1000,
    });
    const includes = scoreQueryMatch({
      value: "claude-opus",
      query: "opus",
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 100,
      includesBase: 1000,
    });
    expect(prefix).not.toBeNull();
    expect(includes).not.toBeNull();
    expect(prefix!).toBeLessThan(includes!);
  });

  it("returns null when the query is missing entirely", () => {
    expect(scoreQueryMatch({ value: "opus", query: "zzz", exactBase: 10 })).toBeNull();
  });

  it("matches via fuzzy subsequence when fuzzyBase provided", () => {
    expect(
      scoreQueryMatch({
        value: "claude-opus-4-7",
        query: "co47",
        exactBase: 0,
        fuzzyBase: 1000,
      }),
    ).not.toBeNull();
  });
});

describe("scoreModelPickerSearch", () => {
  const claude = {
    driverKind: "claude-code",
    providerDisplayName: "Claude Code",
    name: "Claude Opus 4.7",
    shortName: "opus-4-7",
  } as const;

  const codex = {
    driverKind: "codex",
    providerDisplayName: "Codex",
    name: "GPT-5 Codex",
  } as const;

  it("returns 0 for an empty query (no filtering)", () => {
    expect(scoreModelPickerSearch(claude, "")).toBe(0);
  });

  it("matches against the model name", () => {
    expect(scoreModelPickerSearch(claude, "opus")).not.toBeNull();
  });

  it("matches against the provider display name", () => {
    expect(scoreModelPickerSearch(claude, "claude code")).not.toBeNull();
  });

  it("returns null when no token matches any field", () => {
    expect(scoreModelPickerSearch(claude, "gemini")).toBeNull();
  });

  it("requires every token to match", () => {
    expect(scoreModelPickerSearch(codex, "codex opus")).toBeNull();
    expect(scoreModelPickerSearch(codex, "codex gpt")).not.toBeNull();
  });

  it("favorite-boosts the score so favourites tie-break first", () => {
    const plain = scoreModelPickerSearch({ ...claude, isFavorite: false }, "opus");
    const favorite = scoreModelPickerSearch({ ...claude, isFavorite: true }, "opus");
    expect(plain).not.toBeNull();
    expect(favorite).not.toBeNull();
    expect(favorite!).toBeLessThan(plain!);
  });
});

describe("buildModelPickerSearchText", () => {
  it("joins every non-empty searchable field", () => {
    const text = buildModelPickerSearchText({
      driverKind: "codex",
      providerDisplayName: "Codex",
      name: "GPT-5 Codex",
      shortName: "gpt-5",
      subProvider: "OpenAI",
    });
    expect(text).toContain("gpt-5 codex");
    expect(text).toContain("openai");
    expect(text).toContain("codex");
  });
});
