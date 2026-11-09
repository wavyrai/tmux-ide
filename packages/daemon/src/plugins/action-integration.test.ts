/**
 * End to end without a daemon process: a real plugin host behind the real
 * supervisor, served by the daemon's own Hono app, driven by the real CLI
 * and the TUI's catalog client. Only the network hop is replaced.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../command-center/server.ts";
import { createApplicationPluginCommands } from "../tui/mirror/runtime/application-plugin-commands.ts";
import { runActionCli } from "./action-cli.ts";
import type { PluginCliIo } from "./cli.ts";
import { grantConsent, hashPluginDirectory } from "./consent.ts";
import { PluginSupervisor } from "./supervisor.ts";

const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "host", "entry.ts");
const OWNER = "owner-token-0123456789";

let home: string;
let supervisor: PluginSupervisor;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-action-e2e-"));
  const dir = join(home, "plugins", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name: "tasks", version: "1.0.0", api: "^1.0" }),
  );
  writeFileSync(
    join(dir, "init.lua"),
    `ide.action.register{
       id = "new", title = "New task", category = "Tasks",
       params = { { name = "name", label = "Branch name", pattern = "^[%w-]+$" } },
       run = function(ctx, args) return "made " .. args.name .. " from " .. ctx.source end,
     }
     ide.action.register{ id = "remove", title = "Remove task", dangerous = true,
       run = function() return "removed" end }`,
  );
  grantConsent(home, "tasks", hashPluginDirectory(dir));
  supervisor = new PluginSupervisor({
    stateHome: home,
    productVersion: "9.9.9",
    hostCommand: [process.execPath, "--import", "tsx", hostEntry],
    hostEnv: { ...process.env, HOME: home, TMUX_IDE_HOME: home },
    onLog: () => {},
  });
  await supervisor.start();
});
afterEach(async () => {
  await supervisor.stop();
  rmSync(home, { recursive: true, force: true });
});

function appFetch() {
  const app = createApp({
    remoteAccess: { ownerToken: OWNER, localBypassToken: OWNER },
    pluginBackend: supervisor,
  });
  return (async (url: string | URL | Request, init?: RequestInit) =>
    app.request(String(url).replace(/^http:\/\/[^/]+/u, ""), init)) as typeof fetch;
}

function cliIo(out: string[], err: string[]): PluginCliIo {
  return {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    readFile: () => "",
    readStdin: () => "",
    daemon: async () => ({ baseUrl: "http://daemon", ownerToken: OWNER }),
    fetch: appFetch(),
    stateHome: () => home,
    sleep: async () => {},
    interactive: () => false,
    ask: async () => "",
    tmuxPane: () => "%4",
    dispatchBuiltin: vi.fn(),
  };
}

describe("plugin actions end to end", () => {
  it("lists and runs a plugin command from the CLI", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(await runActionCli(["list"], cliIo(out, err))).toBe(0);
    expect(out[0]).toContain("plugin.tasks.new     New task");
    expect(
      await runActionCli(["run", "plugin.tasks.new", "--arg", "name=fix-login"], cliIo(out, err)),
    ).toBe(0);
    expect(out.at(-1)).toBe("made fix-login from cli");
    expect(
      await runActionCli(["run", "plugin.tasks.new", "--arg", "name=bad name"], cliIo(out, err)),
    ).toBe(1);
    expect(err.at(-1)).toMatch(/does not match/u);
    expect(await runActionCli(["run", "plugin.tasks.remove"], cliIo(out, err))).toBe(2);
    expect(await runActionCli(["run", "plugin.tasks.remove", "--yes"], cliIo(out, err))).toBe(0);
    expect(out.at(-1)).toBe("removed");
  }, 30_000);

  it("feeds the TUI palette and runs its form's result", async () => {
    const client = createApplicationPluginCommands({
      daemon: () => ({ bindHostname: "127.0.0.1", port: 1, authToken: OWNER }) as never,
      fetch: appFetch(),
    });
    await client.refresh();
    expect(client.commands().map((command) => [command.id, command.dangerous])).toEqual([
      ["plugin.tasks.new", false],
      ["plugin.tasks.remove", true],
    ]);
    expect(
      await client.invoke("plugin.tasks.new", { name: "x" }, { source: "palette" }, false),
    ).toEqual({ ok: true, value: "made x from palette" });
    expect(await client.invoke("plugin.tasks.remove", {}, { source: "palette" }, false)).toEqual({
      ok: false,
      error: "E_CONFIRM: 'Remove task' must be confirmed first",
    });
  }, 30_000);
});
