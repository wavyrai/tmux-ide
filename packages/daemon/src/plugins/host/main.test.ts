import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPluginDirectory } from "../consent.ts";
import type { HostEvent, PluginSpec } from "../protocol.ts";
import { PluginHost } from "./main.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-host-"));
  mkdirSync(join(dir, "tasks"));
  writeFileSync(join(dir, "tasks", "manifest.json"), "{}");
  writeFileSync(join(dir, "tasks", "init.lua"), `ide.log.info("ran")`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function spec(contentHash: string | undefined): PluginSpec {
  return {
    name: "tasks",
    kind: "plugin",
    ...(contentHash ? { contentHash } : {}),
    entry: join(dir, "tasks", "init.lua"),
    includeRoots: [join(dir, "tasks")],
    moduleRoots: [join(dir, "tasks")],
    settings: {},
  };
}

async function load(plugin: PluginSpec): Promise<HostEvent[]> {
  const events: HostEvent[] = [];
  const host = new PluginHost((event) => events.push(event));
  await host.handle({ type: "load", plugin });
  host.shutdown();
  return events.filter((event) => event.type === "loaded" || event.type === "log");
}

describe("PluginHost consent check", () => {
  it("runs a plugin whose content matches its consented hash", async () => {
    const events = await load(spec(hashPluginDirectory(join(dir, "tasks"))));
    expect(events).toEqual([
      { type: "log", plugin: "tasks", level: "info", message: "ran" },
      expect.objectContaining({ type: "loaded", plugin: "tasks", ok: true }),
    ]);
  });

  it("refuses a plugin that changed after the daemon checked consent", async () => {
    const hash = hashPluginDirectory(join(dir, "tasks"));
    writeFileSync(join(dir, "tasks", "init.lua"), `ide.log.info("swapped in")`);
    const events = await load(spec(hash));
    expect(events.some((event) => event.type === "log" && event.message === "swapped in")).toBe(
      false,
    );
    expect(events.at(-1)).toMatchObject({
      type: "loaded",
      ok: false,
      error: expect.stringMatching(/E_DENIED: the plugin changed since it was consented to/u),
    });
  });

  it("refuses a plugin sent without a consented hash", async () => {
    const events = await load(spec(undefined));
    expect(events.at(-1)).toMatchObject({ type: "loaded", ok: false });
  });
});

describe("PluginHost load queue", () => {
  it("keeps loading after a plugin yields a never-settling thenable, and init.lua still runs", async () => {
    writeFileSync(
      join(dir, "tasks", "init.lua"),
      `coroutine.yield({ ["then"] = function() end }) ide.log.info("unreachable")`,
    );
    writeFileSync(join(dir, "init.lua"), `ide.log.info("init ran")`);
    const events: HostEvent[] = [];
    const host = new PluginHost((event) => events.push(event));
    const started = performance.now();
    await Promise.all([
      host.handle({ type: "load", plugin: spec(hashPluginDirectory(join(dir, "tasks"))) }),
      host.handle({
        type: "load",
        plugin: {
          name: "init",
          kind: "init",
          entry: join(dir, "init.lua"),
          includeRoots: [dir],
          moduleRoots: [],
          settings: {},
        },
      }),
    ]);
    host.shutdown();
    expect(performance.now() - started).toBeLessThan(2000);
    const loaded = events.filter((event) => event.type === "loaded");
    expect(loaded).toEqual([
      expect.objectContaining({
        plugin: "tasks",
        ok: false,
        error: expect.stringMatching(/may only yield to wait for the host/u),
      }),
      expect.objectContaining({ plugin: "init", ok: true }),
    ]);
    expect(events.some((event) => event.type === "log" && event.message === "init ran")).toBe(true);
    expect(events.some((event) => event.type === "log" && event.message === "unreachable")).toBe(
      false,
    );
  });
});
