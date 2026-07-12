/**
 * Unit tests for the persisted notification-debounce map — the pure
 * serialize/parse pair (round-trip, pruning, garbage tolerance) plus the io
 * wrappers against a TMUX_IDE_HOME-scoped temp dir.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTIFY_DEBOUNCE_MS } from "./notify.ts";
import {
  loadLastNotified,
  notifyStatePath,
  parseLastNotified,
  saveLastNotified,
  serializeLastNotified,
} from "./notify-state.ts";

describe("serializeLastNotified / parseLastNotified", () => {
  it("round-trips fresh entries", () => {
    const map = new Map([
      ["%1:blocked", 1000],
      ["%2:done", 2000],
    ]);
    expect(parseLastNotified(serializeLastNotified(map, 3000), 3000)).toEqual(map);
  });

  it("prunes entries outside the debounce window on BOTH ends of the trip", () => {
    const now = 100_000;
    const map = new Map([
      ["%1:blocked", now - NOTIFY_DEBOUNCE_MS], // exactly expired
      ["%2:blocked", now - NOTIFY_DEBOUNCE_MS + 1], // still alive
    ]);
    expect([...parseLastNotified(serializeLastNotified(map, now), now).keys()]).toEqual([
      "%2:blocked",
    ]);
    // An already-serialized stale entry is also dropped at parse time.
    const stale = JSON.stringify({ lastNotified: { "%1:blocked": 0 } });
    expect(parseLastNotified(stale, now).size).toBe(0);
  });

  it("drops absurd future timestamps (clock skew) and non-numeric values", () => {
    const now = 1000;
    const body = JSON.stringify({
      lastNotified: { future: now + NOTIFY_DEBOUNCE_MS + 1, bad: "x", ok: now },
    });
    expect([...parseLastNotified(body, now).keys()]).toEqual(["ok"]);
  });

  it("never throws on garbage", () => {
    expect(parseLastNotified("not json", 0).size).toBe(0);
    expect(parseLastNotified("[]", 0).size).toBe(0);
    expect(parseLastNotified(JSON.stringify({ lastNotified: [1] }), 0).size).toBe(0);
  });
});

describe("load/save (io, TMUX_IDE_HOME-scoped)", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tmux-ide-notify-state-"));
    prevHome = process.env.TMUX_IDE_HOME;
    process.env.TMUX_IDE_HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.TMUX_IDE_HOME;
    else process.env.TMUX_IDE_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("resolves the path under TMUX_IDE_HOME and round-trips a map", () => {
    expect(notifyStatePath()).toBe(join(home, "notify-state.json"));
    const map = new Map([["%1:blocked", 5000]]);
    saveLastNotified(map, 6000);
    expect(loadLastNotified(6000)).toEqual(map);
    // The file is real JSON on disk.
    expect(JSON.parse(readFileSync(notifyStatePath(), "utf-8"))).toEqual({
      lastNotified: { "%1:blocked": 5000 },
    });
  });

  it("returns an empty map for a missing or unreadable file", () => {
    expect(loadLastNotified().size).toBe(0);
    writeFileSync(notifyStatePath(), "garbage");
    expect(loadLastNotified().size).toBe(0);
  });
});
