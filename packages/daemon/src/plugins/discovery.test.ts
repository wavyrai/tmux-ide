import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPlugins } from "./discovery.ts";
import { apiSatisfies, PluginManifestSchemaZ } from "./manifest.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-discovery-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function plugin(dirName: string, manifest: unknown, entry = "init.lua") {
  const dir = join(home, "plugins", dirName);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, entry), "return true");
  return dir;
}

const manifest = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  version: "1.0.0",
  api: "^1.0",
  ...extra,
});

describe("apiSatisfies", () => {
  it("matches the same major and an equal or lower minor", () => {
    expect(apiSatisfies("^1.0", "1.0")).toBe(true);
    expect(apiSatisfies("1.0", "1.3")).toBe(true);
    expect(apiSatisfies("^1.2", "1.1")).toBe(false);
    expect(apiSatisfies("^2.0", "1.9")).toBe(false);
    expect(apiSatisfies(">=1.0", "1.0")).toBe(false);
  });
});

describe("manifest schema", () => {
  it("defaults entry, capabilities and settings, and rejects unknown keys", () => {
    expect(PluginManifestSchemaZ.parse(manifest("tasks"))).toEqual({
      ...manifest("tasks"),
      entry: "init.lua",
      capabilities: {},
      settings: {},
    });
    expect(PluginManifestSchemaZ.safeParse({ ...manifest("tasks"), extra: 1 }).success).toBe(false);
    expect(PluginManifestSchemaZ.safeParse(manifest("tasks", { entry: "../x.lua" })).success).toBe(
      false,
    );
    expect(PluginManifestSchemaZ.safeParse(manifest("Tasks")).success).toBe(false);
  });
});

describe("discoverPlugins", () => {
  it("finds nothing in an empty home", () => {
    expect(discoverPlugins(home)).toEqual({ specs: [], problems: [] });
  });

  it("orders plugins by name, puts init.lua last and fills in roots and defaults", () => {
    const zeta = plugin("zeta", manifest("zeta"));
    const alpha = plugin(
      "alpha",
      manifest("alpha", {
        entry: "src/main.lua",
        settings: { base: { type: "string", default: "main" } },
      }),
      "x.lua",
    );
    mkdirSync(join(alpha, "src"));
    writeFileSync(join(alpha, "src", "main.lua"), "return true");
    writeFileSync(join(home, "init.lua"), "-- user");
    const { specs, problems } = discoverPlugins(home);
    expect(problems).toEqual([]);
    expect(specs).toEqual([
      {
        name: "alpha",
        kind: "plugin",
        entry: join(alpha, "src", "main.lua"),
        includeRoots: [alpha],
        moduleRoots: [alpha, join(home, "lua")],
        settings: { base: "main" },
      },
      {
        name: "zeta",
        kind: "plugin",
        entry: join(zeta, "init.lua"),
        includeRoots: [zeta],
        moduleRoots: [zeta, join(home, "lua")],
        settings: {},
      },
      {
        name: "init",
        kind: "init",
        entry: join(home, "init.lua"),
        includeRoots: [home, join(home, "lua")],
        moduleRoots: [join(home, "lua")],
        settings: {},
      },
    ]);
  });

  it("reports each broken plugin directory instead of loading it", () => {
    plugin("missing", undefined);
    const bad = plugin("badjson", undefined);
    writeFileSync(join(bad, "manifest.json"), "{");
    plugin("mismatch", manifest("other"));
    plugin("future", manifest("future", { api: "^2.0" }));
    plugin("Upper", manifest("upper"));
    plugin("init", manifest("init"));
    plugin("noentry", manifest("noentry", { entry: "main.lua" }));
    const escape = plugin("escape", manifest("escape"));
    rmSync(join(escape, "init.lua"));
    const outside = mkdtempSync(join(tmpdir(), "tmux-ide-outside-"));
    writeFileSync(join(outside, "evil.lua"), "return true");
    symlinkSync(join(outside, "evil.lua"), join(escape, "init.lua"));
    const { specs, problems } = discoverPlugins(home);
    rmSync(outside, { recursive: true, force: true });
    expect(specs).toEqual([]);
    expect(Object.fromEntries(problems.map((p) => [p.name, p.error]))).toEqual({
      Upper: expect.stringMatching(/lowercase/u),
      badjson: expect.stringMatching(/not valid JSON/u),
      escape: "entry 'init.lua' resolves outside the plugin directory",
      future: expect.stringMatching(/needs Lua API \^2\.0/u),
      init: expect.stringMatching(/not 'init'/u),
      mismatch: "manifest name 'other' does not match its directory 'mismatch'",
      missing: "manifest.json is missing",
      noentry: "entry 'main.lua' is missing",
    });
  });

  it("skips dot-directories and plain files in plugins/", () => {
    mkdirSync(join(home, "plugins", ".cache"), { recursive: true });
    writeFileSync(join(home, "plugins", "README"), "");
    expect(discoverPlugins(home)).toEqual({ specs: [], problems: [] });
  });
});
