import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { hasUnsafeText } from "@tmux-ide/contracts";
import {
  defaultPluginCliIo,
  givesFullControl,
  runPluginCommandLine,
  type PluginCliIo,
} from "./cli.ts";
import { hashPluginDirectory, readConsent } from "./consent.ts";
import { appendPluginLog, pluginLogPath } from "./plugin-log.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-plugin-cli-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(
  reply: (path: string, init: RequestInit) => { status?: number; body: unknown },
  files: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const io: PluginCliIo = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
    readStdin: () => "return 'from stdin'",
    daemon: async () => ({ baseUrl: "http://daemon", ownerToken: "tok" }),
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("http://daemon", "");
      calls.push({
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init?.headers).get("authorization"),
      });
      const { status = 200, body } = reply(path, init ?? {});
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
    stateHome: () => home,
    sleep: async () => {},
    interactive: () => false,
    ask: async () => "",
    tmuxPane: () => undefined,
    dispatchBuiltin: async () => null,
  };
  return { io, out, err, calls };
}

const ok = (values: unknown[], logs: unknown[] = []) => ({
  body: { result: { ok: true, values, logs } },
});

describe("tmux-ide lua", () => {
  it("runs a file through the daemon with the owner token and prints values and logs", async () => {
    const h = harness(
      () =>
        ok(
          ["hello", 2, { a: 1 }],
          [
            { level: "info", message: "printed" },
            { level: "warn", message: "careful" },
          ],
        ),
      {
        "script.lua": "return 'hello'",
      },
    );
    expect(
      await runPluginCommandLine("lua", ["run", "script.lua", "--timeout", "2000"], h.io),
    ).toBe(0);
    expect(h.calls).toEqual([
      {
        path: "/api/v2/lua/run",
        method: "POST",
        body: { code: "return 'hello'", chunkName: "@script.lua", budgetMs: 2000 },
        auth: "Bearer tok",
      },
    ]);
    expect(h.out).toEqual(["printed", "hello", "2", '{"a":1}']);
    expect(h.err).toEqual(["warn: careful"]);
  });

  it("runs inline code and stdin, and exits 1 when the script fails", async () => {
    const h = harness((_, init) => {
      const body = JSON.parse(String(init.body)) as { code: string };
      return body.code.includes("error")
        ? { body: { result: { ok: false, error: "(command line):1: bad", logs: [] } } }
        : ok([body.code]);
    });
    expect(await runPluginCommandLine("lua", ["run", "-e", "return 1"], h.io)).toBe(0);
    expect(await runPluginCommandLine("lua", ["run", "-"], h.io)).toBe(0);
    expect(await runPluginCommandLine("lua", ["run", "-e", "error('bad')"], h.io)).toBe(1);
    expect(h.calls.map((call) => (call.body as { chunkName: string }).chunkName)).toEqual([
      "=(command line)",
      "=stdin",
      "=(command line)",
    ]);
    expect(h.err).toEqual(["error: (command line):1: bad"]);
  });

  it("refuses bad arguments without calling the daemon", async () => {
    const h = harness(() => ok([]));
    expect(await runPluginCommandLine("lua", ["run"], h.io)).toBe(2);
    expect(await runPluginCommandLine("lua", ["run", "a.lua", "-e", "x"], h.io)).toBe(2);
    expect(await runPluginCommandLine("lua", ["run", "-e", "x", "--timeout", "5"], h.io)).toBe(2);
    expect(await runPluginCommandLine("lua", ["run", "-e", "x", "--bogus"], h.io)).toBe(2);
    expect(await runPluginCommandLine("lua", ["frobnicate"], h.io)).toBe(2);
    expect(await runPluginCommandLine("lua", [], h.io)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("explains a missing daemon and a daemon error", async () => {
    const h = harness(() => ({
      status: 503,
      body: { error: "Plugins are not enabled in this daemon" },
    }));
    expect(await runPluginCommandLine("lua", ["run", "-e", "x"], h.io)).toBe(1);
    expect(h.err).toEqual(["Plugins are not enabled in this daemon"]);
    const none = harness(() => ok([]));
    const io = { ...none.io, daemon: async () => null };
    expect(await runPluginCommandLine("lua", ["run", "-e", "x"], io)).toBe(1);
    expect(none.err[0]).toMatch(/daemon is not running/u);
  });

  it("prints usage for --help and -h in the subcommand position", async () => {
    for (const [command, flag] of [
      ["lua", "--help"],
      ["lua", "-h"],
      ["plugin", "--help"],
      ["plugin", "-h"],
    ] as const) {
      const h = harness(() => ({ body: {} }));
      expect(await runPluginCommandLine(command, [flag], h.io)).toBe(0);
      expect(h.out[0]).toMatch(/^Usage:/u);
    }
  });

  it("lists and describes the API without a daemon", async () => {
    const h = harness(() => {
      throw new Error("no daemon calls expected");
    });
    expect(await runPluginCommandLine("lua", ["api"], h.io)).toBe(0);
    expect(h.out[0]).toMatch(/^tmux-ide Lua API 1\.0/u);
    expect(h.out[0]).toContain("ide.log.info(message, fields?)");
    expect(await runPluginCommandLine("lua", ["describe", "ide.include"], h.io)).toBe(0);
    expect(h.out[1]).toContain("Errors: E_INVALID, E_NOT_FOUND, E_DENIED");
    expect(await runPluginCommandLine("lua", ["api", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out[2]!).api).toBe("1.0");
    expect(await runPluginCommandLine("lua", ["describe", "log"], h.io)).toBe(1);
    expect(h.err[0]).toMatch(/Did you mean: ide\.log\.debug/u);
  });
});

describe("tmux-ide plugin", () => {
  const status = {
    host: { running: true, pid: 7, restarts: 1 },
    plugins: [
      { name: "tasks", kind: "plugin", state: "loaded", memoryBytes: 2 * 1024 * 1024, trips: 0 },
      {
        name: "init",
        kind: "init",
        state: "failed",
        error: "init.lua:3: boom\nstack traceback:",
        trips: 0,
      },
    ],
  };

  it("lists plugin state", async () => {
    const h = harness(() => ({ body: status }));
    expect(await runPluginCommandLine("plugin", ["list"], h.io)).toBe(0);
    expect(h.out[0]!.split("\n")).toEqual([
      "Plugin host: running (pid 7, 1 restarts)",
      "  tasks  loaded 2.0 MiB",
      "  init   failed",
      "         init.lua:3: boom",
    ]);
  });

  it("reloads all or one, and exits 1 if what it reloaded did not load", async () => {
    const h = harness(() => ({ body: status }));
    expect(await runPluginCommandLine("plugin", ["reload", "tasks"], h.io)).toBe(0);
    expect(await runPluginCommandLine("plugin", ["reload"], h.io)).toBe(1);
    expect(h.calls.map((call) => call.body)).toEqual([{ name: "tasks" }, {}]);
  });

  it("prints the plugin log, filtered by plugin", async () => {
    const path = pluginLogPath(home);
    appendPluginLog(path, {
      ts: "2026-11-09T10:00:00.000Z",
      plugin: "tasks",
      level: "info",
      message: "hi",
    });
    appendPluginLog(path, {
      ts: "2026-11-09T10:00:01.000Z",
      plugin: "init",
      level: "error",
      message: "boom",
      fields: { n: 1 },
    });
    const h = harness(() => ok([]));
    expect(await runPluginCommandLine("plugin", ["logs"], h.io)).toBe(0);
    expect(await runPluginCommandLine("plugin", ["logs", "init", "-n", "5"], h.io)).toBe(0);
    expect(h.out).toEqual([
      "10:00:00 tasks info  hi",
      '10:00:01 init error boom {"n":1}',
      '10:00:01 init error boom {"n":1}',
    ]);
  });
});

describe("tmux-ide lua and plugin output", () => {
  it("never prints control or bidi characters from plugins or the daemon", async () => {
    const nasty = "a\u001b]52;c;cHduZWQ=\u0007b\u009b2J\u202ec\rd";
    appendPluginLog(pluginLogPath(home), {
      ts: "2026-11-09T10:00:00.000Z",
      plugin: "tasks",
      level: "info",
      message: nasty,
      fields: { [nasty]: nasty },
    });
    const h = harness((path) =>
      path.startsWith("/api/v2/plugins")
        ? {
            body: {
              host: { running: true, pid: 1, restarts: 0 },
              plugins: [{ name: "tasks", kind: "plugin", state: "failed", error: nasty, trips: 0 }],
            },
          }
        : ok([nasty, { [nasty]: nasty }], [{ level: "warn", message: nasty }]),
    );
    await runPluginCommandLine("plugin", ["logs"], h.io);
    await runPluginCommandLine("plugin", ["list"], h.io);
    await runPluginCommandLine("plugin", ["list", "--json"], h.io);
    await runPluginCommandLine("lua", ["run", "-e", "return 1"], h.io);
    await runPluginCommandLine("lua", ["run", "-e", "return 1", "--json"], h.io);
    await runPluginCommandLine("plugin", ["consent", nasty], h.io);
    const lines = [...h.out, ...h.err];
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines)
      expect(hasUnsafeText(line.replaceAll("\n", " ")), JSON.stringify(line)).toBe(false);
  });
});

describe("tmux-ide plugin example", () => {
  it("lists the examples, copies one in, and it then waits for consent", async () => {
    const h = harness(() => ok([]));
    expect(await runPluginCommandLine("plugin", ["example"], h.io)).toBe(0);
    expect(h.out[0]).toContain("worktree-tasks  Tasks as git worktrees");
    expect(await runPluginCommandLine("plugin", ["example", "worktree-tasks"], h.io)).toBe(0);
    const dir = join(home, "plugins", "worktree-tasks");
    expect(h.out[1]).toContain(`Copied the worktree-tasks example to ${dir}.`);
    expect(h.out[1]).toContain("tmux-ide plugin consent worktree-tasks");
    expect(readFileSync(join(dir, "init.lua"), "utf8")).toContain('id = "new"');
    // Not allowed yet; consent shows exactly what it asks for.
    expect(readConsent(home).plugins["worktree-tasks"]).toBeUndefined();
    const consent = harness(() => ({
      body: {
        host: { running: true, pid: 1, restarts: 0 },
        plugins: [{ name: "worktree-tasks", kind: "plugin", state: "loaded", trips: 0 }],
      },
    }));
    expect(
      await runPluginCommandLine("plugin", ["consent", "worktree-tasks", "--yes"], consent.io),
    ).toBe(0);
    expect(consent.out[0]).toContain(
      "create, open and remove git worktrees and their sessions (plain sessions, with git hooks off: no layout or hook from the repository or a branch runs)",
    );
    expect(consent.out[0]).not.toContain("run these programs");
    expect(consent.out[0]).not.toContain("type into your terminals");
    // A second copy does not overwrite the first, and unknown names are refused.
    expect(await runPluginCommandLine("plugin", ["example", "worktree-tasks"], h.io)).toBe(1);
    expect(h.err.at(-1)).toMatch(/already exists/u);
    expect(await runPluginCommandLine("plugin", ["example", "nope"], h.io)).toBe(2);
  });
});

describe("tmux-ide plugin consent", () => {
  function install() {
    const dir = join(home, "plugins", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        name: "tasks",
        version: "1.2.0",
        api: "^1.0",
        description: "Worktree tasks",
        capabilities: { exec: ["git"], sidebar: true },
      }),
    );
    writeFileSync(join(dir, "init.lua"), "return true");
    return dir;
  }
  const reloaded = () => ({
    body: {
      host: { running: true, pid: 1, restarts: 0 },
      plugins: [{ name: "tasks", kind: "plugin", state: "loaded", trips: 0 }],
    },
  });

  it("shows what the plugin asks for, records its hash with --yes and reloads it", async () => {
    const dir = install();
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "tasks", "--yes"], h.io)).toBe(0);
    expect(h.out[0]).toContain("tasks 1.2.0");
    expect(h.out[0]).toContain("run these programs: git");
    expect(h.out[0]).toContain("add rows to the sidebar");
    expect(h.out.slice(1)).toEqual(["Allowed tasks.", "tasks: loaded"]);
    expect(readConsent(home).plugins.tasks?.hash).toBe(hashPluginDirectory(dir));
    expect(h.calls).toEqual([
      expect.objectContaining({ path: "/api/v2/plugins/reload", body: { name: "tasks" } }),
    ]);
    expect(await runPluginCommandLine("plugin", ["consent", "tasks"], h.io)).toBe(0);
    expect(h.out.at(-1)).toBe("tasks is already allowed to run.");
  });

  it("warns when a plugin asks for a shell, and makes no promise about what programs cannot touch", async () => {
    const dir = join(home, "plugins", "shelly");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        name: "shelly",
        version: "1.0.0",
        api: "^1.0",
        capabilities: { shell: true },
      }),
    );
    writeFileSync(join(dir, "init.lua"), "return true");
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "shelly", "--yes"], h.io)).toBe(0);
    expect(h.out[0]).toContain("run ANY shell command line, with full access to your account");
    expect(h.out[0]).not.toMatch(/cannot (change|touch)/u);
    expect(h.out[0]).toContain("Allow only plugins you trust.");
  });

  it("calls every program full control except a short reviewed list", async () => {
    const dir = join(home, "plugins", "runner");
    mkdirSync(dir, { recursive: true });
    const exec = [
      "jq",
      "cat",
      "tmux-ide",
      "git",
      "Git",
      "TMUX",
      "python3.14",
      "perl5.34",
      "script",
      "xcrun",
      "arch",
      "nice",
      "time",
      "expect",
      "tclsh",
      "swift",
      "vi",
      "less",
      "JQ",
    ];
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ name: "runner", version: "1.0.0", api: "^1.0", capabilities: { exec } }),
    );
    writeFileSync(join(dir, "init.lua"), "return true");
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "runner", "--yes"], h.io)).toBe(0);
    const note = h.out[0]!.split("\n").find((line) => line.includes("NOTE:"))!;
    expect(note).toContain(
      "can run other commands or drive tmux, so they give full control of your account",
    );
    const named = note.slice(note.indexOf("NOTE: ") + 6, note.indexOf(" can run")).split(", ");
    expect(named).toEqual(exec.filter((program) => program !== "jq" && program !== "cat"));
  });

  it("flags an allow-listed name that resolves to another program", () => {
    const bin = join(home, "bin");
    mkdirSync(bin);
    // `cat` on this PATH is really a shell.
    symlinkSync("/bin/sh", join(bin, "cat"));
    expect(givesFullControl("cat", bin)).toBe(true);
    expect(givesFullControl("cat", "/bin")).toBe(false);
    expect(givesFullControl("cat", join(home, "empty"))).toBe(false);
    // Exact case: "CAT" is not "cat", even where the file system would find it.
    expect(givesFullControl("CAT", join(home, "empty"))).toBe(true);
    expect(givesFullControl("Jq", join(home, "empty"))).toBe(true);
    expect(givesFullControl("sh", "/bin")).toBe(true);
  });

  it("says what programs and typing into panes really allow", async () => {
    const dir = join(home, "plugins", "typist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        name: "typist",
        version: "1.0.0",
        api: "^1.0",
        capabilities: { exec: ["git"], "panes.send": true },
      }),
    );
    writeFileSync(join(dir, "init.lua"), "return true");
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "typist", "--yes"], h.io)).toBe(0);
    expect(h.out[0]).toContain(
      "run these programs: git. A program it may run can usually do anything your account can",
    );
    expect(h.out[0]).toContain(
      "type into your terminals and run commands there, which gives full access to your account",
    );
  });

  it("asks on a terminal and changes nothing unless the answer is yes", async () => {
    install();
    const h = harness(reloaded);
    const no = { ...h.io, interactive: () => true, ask: async () => "n" };
    expect(await runPluginCommandLine("plugin", ["consent", "tasks"], no)).toBe(1);
    expect(readConsent(home).plugins).toEqual({});
    const yes = { ...h.io, interactive: () => true, ask: async () => "y" };
    expect(await runPluginCommandLine("plugin", ["consent", "tasks"], yes)).toBe(0);
    expect(Object.keys(readConsent(home).plugins)).toEqual(["tasks"]);
  });

  it("refuses consent when the plugin changes while the prompt is open", async () => {
    const dir = install();
    const h = harness(reloaded);
    const racing = {
      ...h.io,
      interactive: () => true,
      ask: async () => {
        writeFileSync(join(dir, "init.lua"), "return 'swapped during review'");
        return "y";
      },
    };
    expect(await runPluginCommandLine("plugin", ["consent", "tasks"], racing)).toBe(1);
    expect(h.err[0]).toMatch(/changed while you were reviewing it/u);
    expect(readConsent(home).plugins).toEqual({});
  });

  it("refuses to consent without a terminal unless --yes is given", async () => {
    install();
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "tasks"], h.io)).toBe(2);
    expect(h.err[0]).toMatch(/--yes/u);
    expect(readConsent(home).plugins).toEqual({});
    expect(h.calls).toEqual([]);
  });

  it("asks again after the plugin changes, and revoke withdraws consent", async () => {
    const dir = install();
    const h = harness(reloaded);
    await runPluginCommandLine("plugin", ["consent", "tasks", "--yes"], h.io);
    writeFileSync(join(dir, "init.lua"), "return 'new'");
    expect(await runPluginCommandLine("plugin", ["consent", "tasks", "--yes"], h.io)).toBe(0);
    expect(h.out.some((line) => line.includes("(changed since you last allowed it)"))).toBe(true);
    expect(await runPluginCommandLine("plugin", ["revoke", "tasks"], h.io)).toBe(0);
    expect(readConsent(home).plugins).toEqual({});
  });

  it("explains unknown and invalid plugins", async () => {
    const h = harness(reloaded);
    expect(await runPluginCommandLine("plugin", ["consent", "nope", "--yes"], h.io)).toBe(1);
    expect(h.err[0]).toMatch(/No plugin named 'nope'/u);
    mkdirSync(join(home, "plugins", "broken"), { recursive: true });
    expect(await runPluginCommandLine("plugin", ["consent", "broken", "--yes"], h.io)).toBe(1);
    expect(h.err[1]).toBe("broken cannot run: manifest.json is missing");
  });
});

// The real io's daemon bridge is stubbed for the whole file: if the name check
// ever regresses, a failing run must stay local and never look for a daemon.
const bridge = vi.hoisted(() => ({
  tryDispatchAction: vi.fn(async () => {
    throw new Error("test reached the daemon bridge");
  }),
}));
vi.mock("../lib/cli-action-bridge.ts", () => ({
  tryDispatchAction: bridge.tryDispatchAction,
  resolveCanonicalDaemonEndpoint: () => {
    throw new Error("test reached the daemon bridge");
  },
  cliBridgeFetch: () => () => {
    throw new Error("test reached the daemon bridge");
  },
}));

describe("the real io's built-in dispatch", () => {
  it("refuses a name that is no built-in action before it reaches the daemon", async () => {
    const io = await defaultPluginCliIo();
    await expect(io.dispatchBuiltin("no.such-action", {})).rejects.toThrow(
      "No command named 'no.such-action'.",
    );
    expect(bridge.tryDispatchAction).not.toHaveBeenCalled();
  });
});
