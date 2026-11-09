import {
  COMMAND_PROTOCOL_VERSION,
  hasUnsafeText,
  type CommandCatalogResource,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";
import { runActionCli } from "./action-cli.ts";
import type { PluginCliIo } from "./cli.ts";

const descriptor = (id: string, label: string, dangerous = false) => ({
  version: COMMAND_PROTOCOL_VERSION,
  id,
  owner: id.startsWith("plugin.") ? ("plugin" as const) : ("daemon" as const),
  label,
  category: "Tasks",
  schemas: { input: id },
  dangerous,
  confirmation: dangerous ? ("dialog" as const) : ("none" as const),
});

const catalog: CommandCatalogResource = {
  version: 1,
  revision: 3,
  entries: [
    { descriptor: descriptor("project.launch", "Launch project"), params: [] },
    { descriptor: descriptor("daemon.shutdown", "Shut down daemon", true), params: [] },
    {
      descriptor: descriptor("plugin.tasks.new", "New task"),
      plugin: "tasks",
      params: [
        {
          name: "name",
          type: "string",
          label: "Branch name",
          required: true,
          dynamicDefault: false,
          dynamicChoices: false,
        },
        {
          name: "count",
          type: "number",
          label: "Count",
          required: false,
          default: 1,
          dynamicDefault: false,
          dynamicChoices: false,
        },
        {
          name: "draft",
          type: "boolean",
          label: "Draft",
          required: false,
          dynamicDefault: false,
          dynamicChoices: false,
        },
        {
          name: "agent",
          type: "choice",
          label: "Agent",
          required: true,
          dynamicDefault: false,
          dynamicChoices: false,
          choices: [{ value: "claude", label: "claude" }],
        },
      ],
    },
    {
      descriptor: descriptor("plugin.tasks.remove", "Remove task", true),
      plugin: "tasks",
      params: [],
    },
  ],
};

function harness(overrides: Partial<PluginCliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const posts: unknown[] = [];
  const io: PluginCliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    readFile: () => "",
    readStdin: () => "",
    daemon: async () => ({ baseUrl: "http://d", ownerToken: "tok" }),
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://d", "");
      if (path === "/api/resources/command-catalog") return new Response(JSON.stringify(catalog));
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, value: { created: "fix-login" } }));
    }) as unknown as typeof fetch,
    stateHome: () => "/tmp",
    sleep: async () => {},
    interactive: () => false,
    ask: async () => "",
    tmuxPane: () => "%7",
    dispatchBuiltin: vi.fn(async () => ({ launched: true })),
    ...overrides,
  };
  return { io, out, err, posts };
}

describe("tmux-ide action", () => {
  it("lists plugin and built-in commands with their parameters", async () => {
    const h = harness();
    expect(await runActionCli(["list"], h.io)).toBe(0);
    const text = h.out[0]!;
    expect(text).toContain("Plugin commands");
    expect(text).toContain("plugin.tasks.new     New task");
    expect(text).toContain("count: number?, default 1");
    expect(text).toContain("agent: choice (claude)");
    expect(text).toContain("plugin.tasks.remove  Remove task  [asks to confirm]");
    expect(text).toContain("Built-in commands (take --input JSON)");
  });

  it("runs a plugin command with typed arguments and this pane as context", async () => {
    const h = harness();
    expect(
      await runActionCli(
        [
          "run",
          "plugin.tasks.new",
          "--arg",
          "name=fix-login",
          "-a",
          "count=2",
          "--arg",
          "draft=true",
          "--arg",
          "agent=claude",
        ],
        h.io,
      ),
    ).toBe(0);
    expect(h.posts).toEqual([
      {
        id: "plugin.tasks.new",
        args: { name: "fix-login", count: 2, draft: true, agent: "claude" },
        context: { source: "cli", pane: "%7" },
      },
    ]);
    expect(h.out).toEqual(['{"created":"fix-login"}']);
  });

  it("refuses unknown parameters and bad values before calling the plugin", async () => {
    const h = harness();
    for (const args of [
      ["--arg", "nope=1"],
      ["--arg", "count=two"],
      ["--arg", "draft=yes"],
      ["--arg", "name"],
      ["--arg", "name=a", "--arg", "name=b"],
      ["--input", "{}"],
    ]) {
      expect(await runActionCli(["run", "plugin.tasks.new", ...args], h.io)).toBe(2);
    }
    expect(h.posts).toEqual([]);
  });

  it("asks before a dangerous command, and needs --yes without a terminal", async () => {
    const h = harness();
    expect(await runActionCli(["run", "plugin.tasks.remove"], h.io)).toBe(2);
    expect(h.err[0]).toMatch(/pass --yes/u);
    const no = harness({ interactive: () => true, ask: async () => "n" });
    expect(await runActionCli(["run", "plugin.tasks.remove"], no.io)).toBe(1);
    expect(no.posts).toEqual([]);
    const yes = harness();
    expect(
      await runActionCli(["run", "plugin.tasks.remove", "--yes", "--pane", "%1"], yes.io),
    ).toBe(0);
    expect(yes.posts).toEqual([
      {
        id: "plugin.tasks.remove",
        args: {},
        context: { source: "cli", pane: "%1" },
        confirmed: true,
      },
    ]);
  });

  it("runs built-in commands through the typed action route", async () => {
    const h = harness();
    expect(
      await runActionCli(["run", "project.launch", "--input", '{"project":"demo"}'], h.io),
    ).toBe(0);
    expect(h.io.dispatchBuiltin).toHaveBeenCalledWith("project.launch", { project: "demo" });
    expect(h.out).toEqual(['{"launched":true}']);
    expect(await runActionCli(["run", "project.launch", "--arg", "a=1"], h.io)).toBe(2);
    expect(await runActionCli(["run", "project.launch", "--input", "{"], h.io)).toBe(2);
  });

  it("asks before a dangerous built-in command too", async () => {
    const h = harness();
    expect(await runActionCli(["run", "daemon.shutdown", "--input", "{}"], h.io)).toBe(2);
    expect(h.err[0]).toMatch(/'Shut down daemon' asks to confirm: pass --yes/u);
    const questions: string[] = [];
    const no = harness({
      interactive: () => true,
      ask: async (question) => {
        questions.push(question);
        return "n";
      },
    });
    expect(await runActionCli(["run", "daemon.shutdown"], no.io)).toBe(1);
    expect(questions).toEqual(["Shut down daemon: are you sure? [y/N] "]);
    expect(no.out).toEqual(["Cancelled."]);
    const yes = harness();
    expect(await runActionCli(["run", "daemon.shutdown", "--yes"], yes.io)).toBe(0);
    for (const run of [h, no]) expect(run.io.dispatchBuiltin).not.toHaveBeenCalled();
    expect(yes.io.dispatchBuiltin).toHaveBeenCalledWith("daemon.shutdown", {});
  });

  it("never prints control or bidi characters, whatever the daemon sends", async () => {
    // A catalog and results that skipped every earlier check.
    const nasty = "a\u001b]52;c;cHduZWQ=\u0007b\u009b2J\u202ec\rd";
    const hostile: CommandCatalogResource = {
      ...catalog,
      entries: [
        {
          descriptor: { ...descriptor("plugin.tasks.bad", nasty, true), category: nasty },
          plugin: "tasks",
          params: [
            {
              name: "x",
              type: "choice",
              label: nasty,
              required: false,
              default: nasty,
              dynamicDefault: false,
              dynamicChoices: false,
              choices: [{ value: nasty, label: nasty }],
            },
          ],
        },
      ],
    };
    const lines: string[] = [];
    let reply: unknown = { ok: true, value: { [nasty]: nasty } };
    const io = () =>
      harness({
        interactive: () => true,
        ask: async (question) => {
          lines.push(question);
          return "y";
        },
        fetch: vi.fn(async (url: string | URL | Request) =>
          String(url).endsWith("command-catalog")
            ? new Response(JSON.stringify(hostile))
            : new Response(JSON.stringify(reply)),
        ) as unknown as typeof fetch,
      });
    const runs = [];
    for (const argv of [
      ["list"],
      ["list", "--json"],
      ["run", "plugin.tasks.bad"],
      ["run", "plugin.tasks.bad", "--json"],
      ["run", `plugin.tasks.${nasty}`],
      ["run", "plugin.tasks.bad", "--arg", `${nasty}=1`],
    ]) {
      const h = io();
      await runActionCli(argv, h.io);
      runs.push(h);
    }
    reply = { ok: true, value: nasty };
    runs.push(io());
    await runActionCli(["run", "plugin.tasks.bad"], runs.at(-1)!.io);
    reply = { ok: false, error: nasty };
    runs.push(io());
    await runActionCli(["run", "plugin.tasks.bad"], runs.at(-1)!.io);
    for (const h of runs) lines.push(...h.out, ...h.err);
    expect(lines.length).toBeGreaterThan(8);
    for (const line of lines)
      expect(hasUnsafeText(line.replaceAll("\n", " ")), JSON.stringify(line)).toBe(false);
  });

  it("prints usage for --help and -h in the subcommand position", async () => {
    for (const flag of ["--help", "-h", "help"]) {
      const h = harness();
      expect(await runActionCli([flag], h.io)).toBe(0);
      expect(h.out[0]).toMatch(/^Usage:/u);
    }
  });

  it("reports an unknown command and a failing plugin", async () => {
    const h = harness();
    expect(await runActionCli(["run", "plugin.tasks.gone"], h.io)).toBe(1);
    expect(h.err[0]).toMatch(/No command named 'plugin.tasks.gone'/u);
    const failing = harness({
      fetch: vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith("command-catalog")
          ? new Response(JSON.stringify(catalog))
          : new Response(
              JSON.stringify({ ok: false, error: "E_INVALID: 'Branch name' is required" }),
            ),
      ) as unknown as typeof fetch,
    });
    expect(await runActionCli(["run", "plugin.tasks.new"], failing.io)).toBe(1);
    expect(failing.err).toEqual(["E_INVALID: 'Branch name' is required"]);
  });
});
