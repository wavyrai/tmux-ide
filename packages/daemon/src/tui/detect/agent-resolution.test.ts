import { describe, expect, it } from "vitest";
import { agentDisplayMetadata, resolveAgentStatus } from "./agent-resolution.ts";

const NOW = 1_000_000;

describe("resolveAgentStatus (the shared authority-first decision)", () => {
  it("takes fresh authority and never calls the scrape fallback", () => {
    let scraped = false;
    const result = resolveAgentStatus({
      authorityRaw: `working:${NOW}`,
      nowSec: NOW,
      scrape: () => {
        scraped = true;
        return "idle";
      },
    });
    expect(result).toEqual({ status: "working", source: "authority", since: NOW });
    expect(scraped).toBe(false);
  });

  it("carries the authority epoch as `since` for every fresh state", () => {
    expect(resolveAgentStatus({ authorityRaw: `blocked:${NOW - 5}`, nowSec: NOW, scrape: () => "idle" })).toEqual(
      { status: "blocked", source: "authority", since: NOW - 5 },
    );
    // done/idle never go stale.
    expect(
      resolveAgentStatus({ authorityRaw: `done:${NOW - 100_000}`, nowSec: NOW, scrape: () => "idle" }),
    ).toEqual({ status: "done", source: "authority", since: NOW - 100_000 });
  });

  it("falls back to the scrape verdict when authority is stale", () => {
    const result = resolveAgentStatus({
      authorityRaw: `working:${NOW - 700}`,
      nowSec: NOW,
      scrape: () => "blocked",
    });
    expect(result).toEqual({ status: "blocked", source: "scrape", since: null });
  });

  it("falls back to scrape when there is no authority stamp", () => {
    expect(resolveAgentStatus({ authorityRaw: undefined, nowSec: NOW, scrape: () => "working" })).toEqual({
      status: "working",
      source: "scrape",
      since: null,
    });
    expect(resolveAgentStatus({ authorityRaw: "", nowSec: NOW, scrape: () => "idle" })).toEqual({
      status: "idle",
      source: "scrape",
      since: null,
    });
  });

  it("reports source `unknown` when the scrape itself cannot classify", () => {
    expect(resolveAgentStatus({ authorityRaw: undefined, nowSec: NOW, scrape: () => "unknown" })).toEqual({
      status: "unknown",
      source: "unknown",
      since: null,
    });
  });
});

describe("agentDisplayMetadata (freshness-gated sanitized metadata)", () => {
  it("sanitizes and returns metadata only when authority is fresh", () => {
    expect(agentDisplayMetadata("building the daemon", "Fable", true)).toEqual({
      statusText: "building the daemon",
      displayName: "Fable",
    });
  });

  it("drops metadata entirely when authority is not fresh", () => {
    expect(agentDisplayMetadata("building", "Fable", false)).toEqual({});
  });

  it("strips ANSI + control chars and omits values that sanitize to empty", () => {
    const hostile = "\x1b[31mrun\x1b[0m\ttext";
    const meta = agentDisplayMetadata(hostile, "\x1b[0m", true);
    expect(meta.statusText).toBe("run text");
    // A value that is only control/escape bytes sanitizes away and is omitted.
    expect(meta.displayName).toBeUndefined();
  });
});
