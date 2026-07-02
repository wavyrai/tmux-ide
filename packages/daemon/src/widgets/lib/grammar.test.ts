/**
 * Unit tests for the shared interaction grammar — the key→action table and the
 * pure escape-precedence state machine.
 */
import { describe, expect, it } from "vitest";
import {
  matchGrammar,
  dismiss,
  GRAMMAR_KEYS,
  GRAMMAR_ACTION_ORDER,
  GRAMMAR_HELP,
  type GrammarAction,
} from "./grammar.ts";

describe("matchGrammar", () => {
  const cases: Array<[string, GrammarAction | null]> = [
    ["j", "navDown"],
    ["down", "navDown"],
    ["k", "navUp"],
    ["up", "navUp"],
    ["return", "activate"],
    ["/", "filter"],
    ["?", "help"],
    ["escape", "dismiss"],
    ["q", "quit"],
    // not part of the grammar → null (falls through to widget-specific keys)
    ["l", null],
    ["h", null],
    ["g", null],
    ["r", null],
    ["a", null],
    ["x", null],
    ["tab", null],
  ];

  for (const [name, expected] of cases) {
    it(`maps ${JSON.stringify(name)} → ${expected}`, () => {
      expect(matchGrammar({ name })).toBe(expected);
    });
  }

  it("lets `?` through even when it arrives shifted (shift+/ on most layouts)", () => {
    expect(matchGrammar({ name: "?", shift: true })).toBe("help");
  });

  it("never claims a ctrl/alt/meta combo — those namespaces belong to widgets", () => {
    expect(matchGrammar({ name: "j", ctrl: true })).toBeNull();
    expect(matchGrammar({ name: "q", meta: true })).toBeNull();
    expect(matchGrammar({ name: "k", alt: true })).toBeNull();
    // ctrl+c stays a widget concern, not the grammar's quit.
    expect(matchGrammar({ name: "c", ctrl: true })).toBeNull();
  });

  it("keys are mutually exclusive — no key belongs to two actions", () => {
    const seen = new Map<string, GrammarAction>();
    for (const action of GRAMMAR_ACTION_ORDER) {
      for (const key of GRAMMAR_KEYS[action]) {
        expect(seen.has(key)).toBe(false);
        seen.set(key, action);
      }
    }
  });

  it("GRAMMAR_ACTION_ORDER covers exactly the bound actions", () => {
    expect([...GRAMMAR_ACTION_ORDER].sort()).toEqual(
      (Object.keys(GRAMMAR_KEYS) as GrammarAction[]).sort(),
    );
  });
});

describe("dismiss (escape precedence)", () => {
  it("closes the filter first when a filter is open", () => {
    expect(dismiss({ filterOpen: true })).toBe("filter");
    // filter wins even if a detail is also open (topmost-first).
    expect(dismiss({ filterOpen: true, detailOpen: true })).toBe("filter");
  });

  it("closes an open detail before quitting the widget", () => {
    expect(dismiss({ detailOpen: true })).toBe("detail");
  });

  it("falls through to the widget when nothing is layered", () => {
    expect(dismiss({})).toBe("widget");
    expect(dismiss({ filterOpen: false, detailOpen: false })).toBe("widget");
  });
});

describe("GRAMMAR_HELP", () => {
  it("has a row for every action so the docs stay complete", () => {
    // one visible row per grammar verb (nav up/down share arrows but are two rows)
    expect(GRAMMAR_HELP.length).toBe(GRAMMAR_ACTION_ORDER.length);
  });
});
