import { describe, expect, it } from "vitest";
import { navigatorEntryMatches, parseNavigatorQuery } from "./navigator.ts";

describe("parseNavigatorQuery", () => {
  it("extracts renderer-neutral scope and status tokens", () => {
    expect(parseNavigatorQuery("deploy @agents #blocked api")).toEqual({
      scope: "agents",
      status: "blocked",
      query: "deploy api",
    });
  });

  it("accepts singular aliases and leaves ordinary text intact", () => {
    expect(parseNavigatorQuery("@pane editor")).toEqual({
      scope: "panes",
      status: null,
      query: "editor",
    });
    expect(parseNavigatorQuery("claude code")).toEqual({
      scope: "all",
      status: null,
      query: "claude code",
    });
  });
});

describe("navigatorEntryMatches", () => {
  it("applies the same scope and status law to every renderer", () => {
    const blockedAgent = { scope: "agents" as const, status: "blocked" as const };
    expect(navigatorEntryMatches(blockedAgent, { scope: "agents", status: "blocked" })).toBe(true);
    expect(navigatorEntryMatches(blockedAgent, { scope: "panes", status: "blocked" })).toBe(false);
    expect(navigatorEntryMatches(blockedAgent, { scope: "all", status: "working" })).toBe(false);
  });
});
