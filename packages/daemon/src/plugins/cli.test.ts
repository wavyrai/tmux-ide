import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPluginCommandLine, type PluginCliIo } from "./cli.ts";
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
