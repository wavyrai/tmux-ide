import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyTmuxClients } from "./daemon-plugins.ts";
import { sandboxedArgv } from "./exec-sandbox.ts";
import {
  createHostCallHandler,
  ownerCapabilities,
  paneContextFromTmux,
  type HostCallCaller,
  type HostCallDependencies,
} from "./host-calls.ts";
import { STORE_MAX_BYTES, STORE_MAX_KEYS } from "./plugin-store.ts";

const run = promisify(execFile);
const sandboxAvailable = sandboxedArgv(["true"], { stateHome: "/", writable: "/" }).ok;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-calls-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const tasks: HostCallCaller = {
  plugin: "tasks",
  capabilities: { exec: ["echo", "pwd", "env"], shell: false, panes: false },
};
/** A plugin granted `panes.send`. */
const typist: HostCallCaller = {
  plugin: "typist",
  capabilities: { exec: ["echo", "pwd", "env"], shell: false, panes: true },
};
const endpoint = {
  kind: "pane" as const,
  environmentId: "44444444-4444-4444-8444-444444444444",
  serverScope: {
    serverId: `tmux-server.${"a".repeat(32)}`,
    generation: "55555555-5555-4555-8555-555555555555",
  },
  paneLifetimeId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "demo",
  semanticPaneId: "pane.aaaaaaaaaaaaaaaaaaaa",
};
const handle = {
  generation: "22222222-2222-4222-8222-222222222222",
  operationId: "33333333-3333-4333-8333-333333333333",
};

function handler(overrides: Partial<HostCallDependencies> = {}) {
  const requests: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("http://daemon", "");
    requests.push({
      path,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (path === "/api/v1/automation/panes")
      return Response.json({
        version: 1,
        panes: [{ endpoint, title: "editor", sessionName: "demo" }],
      });
    if (path === "/api/v1/automation/reserve")
      return Response.json({ version: 1, handle }, { status: 201 });
    if (path === "/api/v1/automation/execute") {
      const read = (requests.at(-1)!.body as { intent: { kind: string } }).intent.kind === "read";
      return Response.json({
        version: 1,
        handle,
        result: read
          ? { kind: "read", capturedBytes: 4, returnedBytes: 4, truncated: false }
          : { kind: "send", submitted: true },
        ...(read ? { read: { availability: "available", text: "text" } } : {}),
      });
    }
    if (path.startsWith("/api/v2/action/"))
      return path.endsWith("workspace.pane.kill")
        ? Response.json(
            { ok: false, error: { code: "invalid", message: "no such pane" } },
            { status: 404 },
          )
        : Response.json({ ok: true, result: { done: true } });
    return Response.json({ error: "unknown" }, { status: 404 });
  });
  const notify = vi.fn(async () => {});
  const calls = createHostCallHandler({
    stateHome: home,
    endpoint: () => ({ baseUrl: "http://daemon", ownerToken: "owner-token" }),
    fetch: fetch as never,
    tmux: async () => "",
    baseEnv: () => ({ PATH: "/usr/bin:/bin", HOME: home }),
    secrets: () => new Set(["owner-token-secret"]),
    notify,
    ...overrides,
  });
  return { calls, requests, notify };
}

describe("host calls to the daemon", () => {
  it("lists panes and reads and types through the automation API with the owner token", async () => {
    const { calls, requests } = handler();
    expect(await calls.handle(tasks, "_panes", [])).toEqual([
      { endpoint, title: "editor", session: "demo" },
    ]);
    expect(await calls.handle(tasks, "_pane_read", [endpoint])).toBe("text");
    await expect(calls.handle(tasks, "_pane_send", [endpoint, "ls", true])).rejects.toThrow(
      "E_DENIED: typing into a pane needs the manifest capability 'panes.send'",
    );
    expect(await calls.handle(typist, "_pane_send", [endpoint, "ls", true])).toBe(true);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/v1/automation/panes",
      "POST /api/v1/automation/reserve",
      "POST /api/v1/automation/execute",
      "POST /api/v1/automation/reserve",
      "POST /api/v1/automation/execute",
    ]);
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer owner-token")).toBe(
      true,
    );
    expect(requests[3]!.body).toEqual({
      version: 1,
      origin: "sdk",
      intent: { kind: "send", target: endpoint, source: null, text: "ls", enter: true },
    });
  });

  it("dispatches allowed workspace actions with an operation id, and nothing else", async () => {
    const { calls, requests } = handler();
    expect(
      await calls.handle(tasks, "_action", ["workspace.pane.select", { workspaceName: "demo" }]),
    ).toEqual({ done: true });
    expect(requests[0]!.headers.get("x-tmux-ide-operation-id")).toMatch(/^[0-9a-f-]{36}$/u);
    for (const name of ["daemon.shutdown", "project.launch", "config.set", "workspace.open"]) {
      await expect(calls.handle(tasks, "_action", [name, {}])).rejects.toThrow(
        `E_DENIED: plugins may not run '${name}'`,
      );
    }
    await expect(calls.handle(tasks, "_action", ["workspace.pane.kill", {}])).rejects.toThrow(
      "E_FAILED: no such pane",
    );
    expect(requests).toHaveLength(2);
  });

  it("refuses bad arguments and unknown methods", async () => {
    const { calls } = handler();
    await expect(calls.handle(typist, "_pane_send", [endpoint, "", true])).rejects.toThrow(
      /E_INVALID/u,
    );
    await expect(calls.handle(tasks, "_pane_read", [{ kind: "pane" }])).rejects.toThrow(
      /E_INVALID/u,
    );
    await expect(calls.handle(tasks, "_nope", [])).rejects.toThrow(
      "E_INVALID: no host function '_nope'",
    );
    await expect(calls.handle(tasks, "toString", [])).rejects.toThrow(/no host function/u);
  });

  it("says the daemon is not ready before it listens", async () => {
    const { calls } = handler({ endpoint: () => null });
    await expect(calls.handle(tasks, "_panes", [])).rejects.toThrow(
      "E_UNAVAILABLE: the daemon is not ready yet",
    );
  });

  it("notifies with clipped, single-line text", async () => {
    const { calls, notify } = handler();
    await calls.handle(tasks, "_notify", [`line one\nline two ${"x".repeat(300)}`, "warn"]);
    expect(notify).toHaveBeenCalledWith(
      "tasks",
      expect.stringMatching(/^line one line two x+$/u),
      "warn",
    );
    expect((notify.mock.calls[0] as unknown as [string, string])[1]).toHaveLength(200);
    expect(await calls.handle(tasks, "_notify", ["   "])).toBe(false);
  });
});

describe("plugin store", () => {
  it("keeps each plugin's values apart, and deletes with nil", async () => {
    const { calls } = handler();
    await calls.handle(tasks, "_store_set", ["count", 3]);
    await calls.handle({ ...tasks, plugin: "other" }, "_store_set", ["count", 9]);
    expect(await calls.handle(tasks, "_store_get", ["count"])).toBe(3);
    expect(await calls.handle(tasks, "_store_keys", [])).toEqual(["count"]);
    await calls.handle(tasks, "_store_set", ["count"]);
    expect(await calls.handle(tasks, "_store_get", ["count"])).toBeNull();
    expect(JSON.parse(readFileSync(join(home, "plugin-store", "other.json"), "utf8"))).toEqual({
      count: 9,
    });
  });

  it("never writes or reads through a symlink a plugin's program planted", async () => {
    // Programs may write plugin-data/<plugin>; the store lives elsewhere, and
    // even a symlink at the store path itself is replaced, not followed.
    const consent = join(home, "consent", "plugins.json");
    mkdirSync(join(home, "consent"), { recursive: true });
    writeFileSync(consent, '{"plugins":{}}');
    mkdirSync(join(home, "plugin-store"), { recursive: true });
    const storePath = join(home, "plugin-store", "tasks.json");
    symlinkSync(consent, storePath);
    // The old fixed temp name, planted too.
    symlinkSync(consent, `${storePath}.${process.pid}.tmp`);
    const { calls } = handler();
    await expect(calls.handle(tasks, "_store_get", ["plugins"])).rejects.toThrow(
      /E_FAILED: the store file is unusable .* symlink/u,
    );
    await expect(calls.handle(tasks, "_store_set", ["a", 1])).rejects.toThrow(/symlink/u);
    expect(readFileSync(consent, "utf8")).toBe('{"plugins":{}}');
    rmSync(storePath);
    await calls.handle(tasks, "_store_set", ["a", 1]);
    expect(readFileSync(consent, "utf8")).toBe('{"plugins":{}}');
    expect(lstatSync(storePath).isFile()).toBe(true);
    expect(await calls.handle(tasks, "_store_get", ["a"])).toBe(1);
    // A store swapped for a symlink after a write is still not followed.
    rmSync(storePath);
    symlinkSync(consent, storePath);
    await expect(calls.handle(tasks, "_store_keys", [])).rejects.toThrow(/symlink/u);
    expect(readFileSync(consent, "utf8")).toBe('{"plugins":{}}');
  });

  it("refuses a store file that is not a regular file or is too large", async () => {
    mkdirSync(join(home, "plugin-store", "tasks.json"), { recursive: true });
    const { calls } = handler();
    await expect(calls.handle(tasks, "_store_get", ["a"])).rejects.toThrow(/not a regular file/u);
    rmSync(join(home, "plugin-store", "tasks.json"), { recursive: true });
    writeFileSync(join(home, "plugin-store", "tasks.json"), " ".repeat(STORE_MAX_BYTES + 1));
    await expect(calls.handle(tasks, "_store_get", ["a"])).rejects.toThrow(/larger than/u);
  });

  it("holds at most STORE_MAX_KEYS keys, but may still change one", async () => {
    mkdirSync(join(home, "plugin-store"), { recursive: true });
    const full = Object.fromEntries(Array.from({ length: STORE_MAX_KEYS }, (_, i) => [`k${i}`, i]));
    writeFileSync(join(home, "plugin-store", "tasks.json"), JSON.stringify(full));
    const { calls } = handler();
    await expect(calls.handle(tasks, "_store_set", ["one-more", 1])).rejects.toThrow(
      `E_LIMIT: the store holds at most ${STORE_MAX_KEYS} keys`,
    );
    await calls.handle(tasks, "_store_set", ["k0", "changed"]);
    expect(await calls.handle(tasks, "_store_get", ["k0"])).toBe("changed");
    expect((await calls.handle(tasks, "_store_keys", [])) as string[]).toHaveLength(STORE_MAX_KEYS);
  });

  it("caps the store and has none for lua run", async () => {
    const { calls } = handler();
    await expect(
      calls.handle(tasks, "_store_set", ["big", "x".repeat(STORE_MAX_BYTES)]),
    ).rejects.toThrow(/E_LIMIT/u);
    await expect(calls.handle({ ...tasks, plugin: "run" }, "_store_get", ["a"])).rejects.toThrow(
      /no store/u,
    );
    await expect(calls.handle(tasks, "_store_set", ["", 1])).rejects.toThrow(/E_INVALID/u);
  });
});

describe("pane context", () => {
  it("parses tmux's answer into TMUX and the cwd", () => {
    expect(paneContextFromTmux("%3", "/tmp/tmux-501/default\t4242\t$7\t/home/u/repo\n")).toEqual({
      tmux: "/tmp/tmux-501/default,4242,7",
      pane: "%3",
      cwd: "/home/u/repo",
    });
    expect(paneContextFromTmux("%3", "garbage")).toBeNull();
  });

  (sandboxAvailable ? it : it.skip)(
    "runs a program in a real pane's cwd with its TMUX and TMUX_PANE (private tmux socket)",
    async () => {
      const socket = join(home, "tmux.sock");
      const cwd = mkdtempSync(join(tmpdir(), "tmux-ide-pane-cwd-"));
      const tmux = async (args: readonly string[]) =>
        (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args])).stdout;
      await tmux(["new-session", "-d", "-s", "ctx", "-c", cwd]);
      try {
        const pane = (await tmux(["display-message", "-p", "-t", "ctx", "#{pane_id}"])).trim();
        const { calls } = handler({ tmux });
        const pwd = (await calls.handle(typist, "_exec", [{ cmd: "pwd", context: pane }])) as {
          stdout: string;
        };
        expect(pwd.stdout.trim()).toBe((await run("realpath", [cwd])).stdout.trim());
        const env = (await calls.handle(typist, "_exec", [{ cmd: "env", context: pane }])) as {
          stdout: string;
        };
        expect(env.stdout).toContain(`TMUX_PANE=${pane}\n`);
        expect(env.stdout).toContain(`TMUX=${socket},`);
      } finally {
        await tmux(["kill-server"]).catch(() => "");
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe("exec capabilities", () => {
  it("passes the caller's consented programs to the runner, and its own data dir", async () => {
    const exec = vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      timed_out: false,
      truncated: false,
    }));
    const { calls } = handler({
      exec,
      unreadable: () => [join(home, "daemon.json")],
      execMaxTimeoutMs: 1234,
    });
    await calls.handle(tasks, "_exec", [{ cmd: "echo" }]);
    await calls.handle(typist, "_exec", [{ cmd: "echo" }]);
    expect(exec).toHaveBeenNthCalledWith(
      1,
      { cmd: "echo" },
      expect.objectContaining({
        policy: { programs: ["echo", "pwd", "env"], shell: false, panes: false },
        sandbox: {
          stateHome: home,
          writable: join(home, "plugin-data", "tasks"),
          unreadable: [join(home, "daemon.json")],
        },
        maxTimeoutMs: 1234,
      }),
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      { cmd: "echo" },
      expect.objectContaining({
        policy: { programs: ["echo", "pwd", "env"], shell: false, panes: true },
      }),
    );
    // The caller's liveness check reaches the runner.
    let alive = true;
    await calls.handle({ ...tasks, active: () => alive }, "_exec", [{ cmd: "echo" }]);
    const stillAllowed = (exec.mock.calls[2] as unknown[])[1] as { stillAllowed: () => boolean };
    expect(stillAllowed.stillAllowed()).toBe(true);
    alive = false;
    expect(stillAllowed.stillAllowed()).toBe(false);
  });

  it("gives init.lua and lua run every capability, and plugins none by default", () => {
    expect(ownerCapabilities("init")).toEqual({ exec: "any", shell: true, panes: true });
    expect(ownerCapabilities("run")).toEqual({ exec: "any", shell: true, panes: true });
    expect(ownerCapabilities("tasks")).toBeNull();
  });
});

describe("notifyTmuxClients", () => {
  it("shows the message on every attached client, escaping tmux formats", async () => {
    const calls: string[][] = [];
    const tmux = async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "list-clients" ? "/dev/ttys001\n/dev/ttys002\n" : "";
    };
    await notifyTmuxClients(tmux, "tasks", "50% done #{pane_id}", "warn");
    expect(calls).toEqual([
      ["list-clients", "-F", "#{client_name}"],
      ["display-message", "-c", "/dev/ttys001", "-d", "4000", "tasks: warn: 50% done ##{pane_id}"],
      ["display-message", "-c", "/dev/ttys002", "-d", "4000", "tasks: warn: 50% done ##{pane_id}"],
    ]);
  });
});

describe("host call wiring", () => {
  it("serves exactly the methods the host exposes", async () => {
    const { HOST_CALL_METHODS } = await import("./protocol.ts");
    expect([...handler().calls.methods].sort()).toEqual([...HOST_CALL_METHODS].sort());
  });

  it("reaches the daemon's real action route, through its owner gate", async () => {
    const { createApp } = await import("../command-center/server.ts");
    const app = createApp({
      remoteAccess: { ownerToken: "owner-token", localBypassToken: "owner-token" },
    });
    const viaApp = (token: string) =>
      createHostCallHandler({
        stateHome: home,
        endpoint: () => ({ baseUrl: "http://daemon", ownerToken: token }),
        fetch: (async (url: string | URL | Request, init?: RequestInit) =>
          app.request(String(url).replace("http://daemon", ""), init)) as typeof fetch,
        tmux: async () => "",
        baseEnv: () => ({}),
        secrets: () => new Set(),
        notify: async () => {},
      });
    const input = {
      workspaceName: "demo",
      semanticPaneId: "pane.aaaaaaaaaaaaaaaaaaaa",
    };
    // The right token passes the gate and meets the dispatcher (no backend in this app).
    await expect(
      viaApp("owner-token").handle(tasks, "_action", ["workspace.pane.select", input]),
    ).rejects.toThrow("E_FAILED: Multiplexer verbs are not available from this daemon.");
    // A wrong token is stopped by the same gate the app and CLI face.
    await expect(
      viaApp("wrong-token").handle(tasks, "_action", ["workspace.pane.select", input]),
    ).rejects.toThrow("E_FAILED: Host mutation capability required");
  });
});
