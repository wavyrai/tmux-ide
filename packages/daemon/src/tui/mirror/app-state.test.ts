import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APP_STATE,
  appStateHome,
  appStatePath,
  isTab,
  parseAppState,
  serializeAppState,
  type AppState,
} from "./app-state.ts";

describe("isTab", () => {
  it("accepts the four surface keys and rejects anything else", () => {
    expect(isTab("home")).toBe(true);
    expect(isTab("terminal")).toBe(true);
    expect(isTab("files")).toBe(true);
    expect(isTab("diff")).toBe(true);
    expect(isTab("mirror")).toBe(false);
    expect(isTab(2)).toBe(false);
    expect(isTab(null)).toBe(false);
  });
});

describe("parseAppState", () => {
  it("round-trips a full state", () => {
    const state: AppState = {
      lastTab: "files",
      contextSession: "zz-demo",
      openFile: "/tmp/a.ts",
      diffFile: "src/x.ts",
    };
    expect(parseAppState(serializeAppState(state))).toEqual(state);
  });

  it("falls back to defaults on invalid JSON", () => {
    expect(parseAppState("{not json")).toEqual(DEFAULT_APP_STATE);
    expect(parseAppState("null")).toEqual(DEFAULT_APP_STATE);
    expect(parseAppState("[]")).toEqual(DEFAULT_APP_STATE);
  });

  it("defaults an unknown tab back to home but keeps valid siblings", () => {
    const parsed = parseAppState(
      JSON.stringify({ lastTab: "bogus", contextSession: "s", openFile: "/f", diffFile: "d" }),
    );
    expect(parsed).toEqual({
      lastTab: "home",
      contextSession: "s",
      openFile: "/f",
      diffFile: "d",
    });
  });

  it("coerces empty strings and wrong types to null", () => {
    const parsed = parseAppState(
      JSON.stringify({ lastTab: "diff", contextSession: "", openFile: 42, diffFile: null }),
    );
    expect(parsed).toEqual({
      lastTab: "diff",
      contextSession: null,
      openFile: null,
      diffFile: null,
    });
  });
});

describe("serializeAppState", () => {
  it("emits exactly the four keys and drops extras", () => {
    const parsed = JSON.parse(
      serializeAppState({
        lastTab: "terminal",
        contextSession: "s",
        openFile: null,
        diffFile: null,
        // @ts-expect-error — runtime extra keys must not leak into the file
        junk: "x",
      }),
    );
    expect(Object.keys(parsed).sort()).toEqual([
      "contextSession",
      "diffFile",
      "lastTab",
      "openFile",
    ]);
  });
});

describe("appStateHome / appStatePath", () => {
  const prev = process.env.TMUX_IDE_HOME;
  beforeEach(() => {
    delete process.env.TMUX_IDE_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TMUX_IDE_HOME;
    else process.env.TMUX_IDE_HOME = prev;
  });

  it("honors TMUX_IDE_HOME as the whole home dir", () => {
    process.env.TMUX_IDE_HOME = "/tmp/zz-home";
    expect(appStateHome()).toBe("/tmp/zz-home");
    expect(appStatePath()).toBe("/tmp/zz-home/app-state.json");
  });

  it("defaults under the user home when unset", () => {
    expect(appStatePath().endsWith("/.tmux-ide/app-state.json")).toBe(true);
  });
});
