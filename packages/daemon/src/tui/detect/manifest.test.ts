/**
 * Unit tests for the pure manifest rule engine.
 *
 * Covers matcher/region resolution, rule boolean logic, manifest precedence,
 * command → manifest selection, and a few realistic claude snapshots.
 */
import { describe, expect, it } from "vitest";
import type { AgentManifest, Matcher } from "./manifest.ts";
import { evaluateManifest, explain, matchMatcher, matchRule, pickManifest } from "./manifest.ts";
import { BUNDLED_MANIFESTS } from "./manifests.ts";
import type { PaneSnapshot } from "./snapshot.ts";

function snap(bottom: string[], extra: Partial<PaneSnapshot & { title?: string }> = {}) {
  const text = extra.text ?? bottom.join("\n");
  return {
    bottomNonEmpty: bottom,
    text,
    raw: extra.raw ?? text,
    ...(extra.title !== undefined ? { title: extra.title } : {}),
  };
}

const claude = BUNDLED_MANIFESTS.find((m) => m.id === "claude")!;

describe("matchMatcher", () => {
  it("matches contains in the bottom region by default", () => {
    expect(matchMatcher(snap(["hello world"]), { contains: "world" })).toBe(true);
    expect(matchMatcher(snap(["hello world"]), { contains: "nope" })).toBe(false);
  });

  it("respects caseInsensitive for contains", () => {
    expect(matchMatcher(snap(["Hello"]), { contains: "hello" })).toBe(false);
    expect(matchMatcher(snap(["Hello"]), { contains: "hello", caseInsensitive: true })).toBe(true);
  });

  it("matches a regex", () => {
    expect(matchMatcher(snap(["item 42"]), { regex: "\\d+" })).toBe(true);
    expect(matchMatcher(snap(["no digits"]), { regex: "\\d+" })).toBe(false);
  });

  it("respects caseInsensitive for regex", () => {
    expect(matchMatcher(snap(["ABC"]), { regex: "abc" })).toBe(false);
    expect(matchMatcher(snap(["ABC"]), { regex: "abc", caseInsensitive: true })).toBe(true);
  });

  it("selects the text region", () => {
    const s = snap(["bottom line"], { text: "full body text" });
    expect(matchMatcher(s, { region: "text", contains: "body" })).toBe(true);
    expect(matchMatcher(s, { region: "bottom", contains: "body" })).toBe(false);
  });

  it("selects the title region and tolerates its absence", () => {
    expect(matchMatcher(snap(["x"], { title: "spinner ⠋" }), { region: "title", contains: "spinner" })).toBe(true);
    expect(matchMatcher(snap(["x"]), { region: "title", contains: "spinner" })).toBe(false);
  });

  it("returns false for an invalid regex without throwing", () => {
    expect(matchMatcher(snap(["anything"]), { regex: "([" })).toBe(false);
  });

  it("returns false for a matcher with neither contains nor regex", () => {
    expect(matchMatcher(snap(["anything"]), {} as Matcher)).toBe(false);
  });
});

describe("matchRule", () => {
  it("all[] requires every matcher (AND)", () => {
    const s = snap(["alpha beta"]);
    expect(matchRule(s, { all: [{ contains: "alpha" }, { contains: "beta" }] })).toBe(true);
    expect(matchRule(s, { all: [{ contains: "alpha" }, { contains: "gamma" }] })).toBe(false);
  });

  it("any[] requires at least one matcher (OR)", () => {
    const s = snap(["alpha"]);
    expect(matchRule(s, { any: [{ contains: "zzz" }, { contains: "alpha" }] })).toBe(true);
    expect(matchRule(s, { any: [{ contains: "zzz" }, { contains: "yyy" }] })).toBe(false);
  });

  it("empty or absent rule never matches", () => {
    const s = snap(["alpha"]);
    expect(matchRule(s, {})).toBe(false);
    expect(matchRule(s, { all: [], any: [] })).toBe(false);
  });
});

describe("evaluateManifest", () => {
  const manifest: AgentManifest = {
    id: "test",
    commands: ["test"],
    states: {
      blocked: { any: [{ contains: "BLOCK" }] },
      working: { any: [{ contains: "WORK" }] },
    },
  };

  it("returns null when nothing matches", () => {
    expect(evaluateManifest(snap(["idle prompt $"]), manifest).state).toBe(null);
  });

  it("returns the matching state with the matcher", () => {
    const result = evaluateManifest(snap(["WORK in progress"]), manifest);
    expect(result.state).toBe("working");
    expect(result.matched?.matcher.contains).toBe("WORK");
  });

  it("gives blocked precedence over working when both match", () => {
    expect(evaluateManifest(snap(["BLOCK and WORK"]), manifest).state).toBe("blocked");
  });
});

describe("explain", () => {
  it("reports each state and the winner", () => {
    const s = snap(["Do you want to proceed?"]);
    const result = explain(s, claude);
    expect(result.state).toBe("blocked");
    expect(result.checked.map((c) => c.state)).toEqual(["blocked", "working", "done"]);
    expect(result.checked.find((c) => c.state === "blocked")?.matched).toBe(true);
  });
});

describe("pickManifest", () => {
  it("matches a manifest by command", () => {
    expect(pickManifest("claude", BUNDLED_MANIFESTS)?.id).toBe("claude");
    expect(pickManifest("codex", BUNDLED_MANIFESTS)?.id).toBe("codex");
    expect(pickManifest("zsh", BUNDLED_MANIFESTS)?.id).toBe("shell");
  });

  it("is case-insensitive and tolerant of substrings", () => {
    expect(pickManifest("CLAUDE", BUNDLED_MANIFESTS)?.id).toBe("claude");
  });

  it("returns undefined for an unknown command", () => {
    expect(pickManifest("emacs", BUNDLED_MANIFESTS)).toBeUndefined();
    expect(pickManifest("", BUNDLED_MANIFESTS)).toBeUndefined();
  });
});

describe("claude manifest against realistic snapshots", () => {
  it("classifies an approval prompt as blocked", () => {
    expect(evaluateManifest(snap(["Do you want to proceed?", "❯ 1. Yes"]), claude).state).toBe(
      "blocked",
    );
  });

  it("classifies a spinner line as working", () => {
    expect(evaluateManifest(snap(["⠹ Thinking… (esc to interrupt)"]), claude).state).toBe(
      "working",
    );
  });

  it("returns null for a plain idle prompt", () => {
    expect(evaluateManifest(snap(["› "]), claude).state).toBe(null);
  });
});
