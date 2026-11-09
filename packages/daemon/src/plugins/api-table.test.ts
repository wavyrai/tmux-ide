import { describe, expect, it } from "vitest";
import { API_ENTRIES, findApiEntry, ideTableNames } from "./api-table.ts";
import { PluginLuaState } from "./host/lua-state.ts";
import { DEFAULT_PLUGIN_LIMITS, PLUGIN_API_VERSION } from "./protocol.ts";

async function bound(code: string): Promise<unknown[]> {
  const state = await PluginLuaState.create({
    spec: { name: "probe", includeRoots: [], moduleRoots: [], settings: {} },
    apiVersion: PLUGIN_API_VERSION,
    productVersion: "0.0.0",
    limits: DEFAULT_PLUGIN_LIMITS,
    hooks: { busy() {}, idle() {}, log() {}, trip() {} },
  });
  try {
    return JSON.parse(
      await state.runSource(code, "=probe", { budgetMs: 1000, wallClockMs: 5000 }),
    ) as unknown[];
  } finally {
    state.close();
  }
}

describe("API table", () => {
  it("names every entry once, with a signature that starts with its name", () => {
    const names = API_ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of API_ENTRIES) expect(entry.signature.startsWith(entry.name)).toBe(true);
    expect(findApiEntry("ide.log.info")?.kind).toBe("function");
  });

  it("matches the ide table the host binds, entry for entry", async () => {
    const [names] = await bound(`
      local out = {}
      local function walk(prefix, t)
        for k, v in pairs(t) do
          local name = prefix .. "." .. k
          if type(v) == "table" and name ~= "ide.settings" then walk(name, v)
          else out[#out + 1] = name end
        end
      end
      walk("ide", ide)
      table.sort(out)
      return out`);
    expect(names).toEqual([...ideTableNames()].sort());
  });

  it("documents the globals plugins rely on, and they exist", async () => {
    const globals = API_ENTRIES.filter((entry) => entry.kind === "global").map(
      (entry) => entry.name,
    );
    const [types] = await bound(
      `local t = {} for _, n in ipairs({${globals.map((g) => JSON.stringify(g)).join(",")}}) do t[n] = type(_G[n]) end return t`,
    );
    expect(types).toEqual(Object.fromEntries(globals.map((name) => [name, "function"])));
  });

  it("reports ide.api as the protocol's API version", async () => {
    expect(await bound("return ide.api")).toEqual([PLUGIN_API_VERSION]);
  });
});
