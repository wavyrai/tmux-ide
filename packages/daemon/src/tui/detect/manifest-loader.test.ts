/**
 * Unit tests for manifest override loading: the pure merge + validator, and
 * the io wrapper reading a real temp override directory.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentManifest } from "./manifest.ts";
import { mergeManifests, readOverrideManifests, validateManifestShape } from "./manifest-loader.ts";

const bundled: AgentManifest[] = [
  { id: "claude", commands: ["claude"], states: { working: { any: [{ contains: "x" }] } } },
  { id: "codex", commands: ["codex"], states: {} },
  { id: "shell", commands: ["zsh"], states: {} },
];

describe("validateManifestShape", () => {
  it("accepts a well-formed manifest", () => {
    expect(
      validateManifestShape({
        id: "x",
        commands: ["x"],
        states: { working: { any: [{ contains: "esc to interrupt" }] } },
      }),
    ).toBe(true);
  });

  it("accepts a regex matcher and an empty states object", () => {
    expect(
      validateManifestShape({
        id: "x",
        commands: ["x"],
        states: { blocked: { all: [{ regex: "\\d" }] } },
      }),
    ).toBe(true);
    expect(validateManifestShape({ id: "x", commands: ["x"], states: {} })).toBe(true);
  });

  it("rejects missing/empty id", () => {
    expect(validateManifestShape({ commands: ["x"], states: {} })).toBe(false);
    expect(validateManifestShape({ id: "  ", commands: ["x"], states: {} })).toBe(false);
  });

  it("rejects missing/empty/non-string commands", () => {
    expect(validateManifestShape({ id: "x", states: {} })).toBe(false);
    expect(validateManifestShape({ id: "x", commands: [], states: {} })).toBe(false);
    expect(validateManifestShape({ id: "x", commands: [1], states: {} })).toBe(false);
  });

  it("rejects a missing states object", () => {
    expect(validateManifestShape({ id: "x", commands: ["x"] })).toBe(false);
  });

  it("rejects a malformed rule / matcher", () => {
    // a rule that isn't {all?,any?} of matchers
    expect(
      validateManifestShape({ id: "x", commands: ["x"], states: { working: { any: [{}] } } }),
    ).toBe(false);
    expect(
      validateManifestShape({ id: "x", commands: ["x"], states: { working: { any: "nope" } } }),
    ).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateManifestShape(null)).toBe(false);
    expect(validateManifestShape("claude")).toBe(false);
    expect(validateManifestShape(42)).toBe(false);
  });
});

describe("mergeManifests", () => {
  it("replaces a bundled manifest by id, preserving position", () => {
    const override: AgentManifest = {
      id: "claude",
      commands: ["claude", "claude-dev"],
      states: { working: { any: [{ contains: "esc to interrupt" }] } },
    };
    const merged = mergeManifests(bundled, [override]);
    expect(merged.map((m) => m.id)).toEqual(["claude", "codex", "shell"]);
    expect(merged[0]).toBe(override);
    expect(merged[0]!.commands).toContain("claude-dev");
  });

  it("appends a new id after the bundled entries", () => {
    const fresh: AgentManifest = { id: "aider", commands: ["aider"], states: {} };
    const merged = mergeManifests(bundled, [fresh]);
    expect(merged.map((m) => m.id)).toEqual(["claude", "codex", "shell", "aider"]);
  });

  it("last override wins among duplicates with the same id", () => {
    const a: AgentManifest = { id: "new", commands: ["a"], states: {} };
    const b: AgentManifest = { id: "new", commands: ["b"], states: {} };
    const merged = mergeManifests(bundled, [a, b]);
    expect(merged.filter((m) => m.id === "new")).toHaveLength(1);
    expect(merged.find((m) => m.id === "new")!.commands).toEqual(["b"]);
  });

  it("returns the bundled set unchanged with no overrides", () => {
    expect(mergeManifests(bundled, [])).toEqual(bundled);
  });
});

describe("readOverrideManifests (io)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-ide-manifests-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] for a missing directory", () => {
    expect(readOverrideManifests(join(dir, "does-not-exist"))).toEqual([]);
  });

  it("reads valid .json manifests and skips invalid ones", () => {
    writeFileSync(
      join(dir, "good.json"),
      JSON.stringify({
        id: "myagent",
        commands: ["myagent"],
        states: { working: { any: [{ contains: "esc to interrupt" }] } },
      }),
    );
    writeFileSync(join(dir, "bad-shape.json"), JSON.stringify({ id: "nope" }));
    writeFileSync(join(dir, "not-json.json"), "{ this is not json");
    writeFileSync(join(dir, "ignored.txt"), "not a json file");

    const overrides = readOverrideManifests(dir);
    expect(overrides.map((m) => m.id)).toEqual(["myagent"]);
  });

  it("drops unknown state keys, keeping only blocked/working/done", () => {
    writeFileSync(
      join(dir, "x.json"),
      JSON.stringify({
        id: "x",
        commands: ["x"],
        states: { working: { any: [{ contains: "z" }] }, bogus: { any: [{ contains: "q" }] } },
      }),
    );
    const [m] = readOverrideManifests(dir);
    expect(Object.keys(m!.states)).toEqual(["working"]);
  });
});
