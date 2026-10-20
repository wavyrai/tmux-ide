import { expect, it } from "bun:test";
import { readTmuxServerDiagnostics } from "./tmux-server-client.ts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const options = {
  baseUrl: "http://127.0.0.1:1",
  ownerToken: "private",
  hostClientId: "test",
  origin: "http://localhost",
};
it("old route404 is optional and performs exactly one authenticated GET", async () => {
  let calls = 0;
  const result = await readTmuxServerDiagnostics(
    {
      ...options,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toEndWith("/diagnostics");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private");
        return new Response("", { status: 404 });
      },
    },
    scope,
  );
  expect(result).toBeNull();
  expect(calls).toBe(1);
});
it("accepts exact scope and rejects replacement scope or malformed versions", async () => {
  for (const version of ["3.7c", "3.8"]) {
    const result = await readTmuxServerDiagnostics(
      {
        ...options,
        fetch: async () => Response.json({ version: 1, server: scope, tmuxVersion: version }),
      },
      scope,
    );
    expect(result?.tmuxVersion).toBe(version);
  }
  for (const value of [
    {
      version: 1,
      server: { ...scope, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      tmuxVersion: "3.8",
    },
    { version: 1, server: scope, tmuxVersion: "/private/secret" },
  ])
    await expect(
      readTmuxServerDiagnostics({ ...options, fetch: async () => Response.json(value) }, scope),
    ).rejects.toThrow();
});
it("aborted caller cannot publish metadata or interpret404 as availability", async () => {
  const abort = new AbortController();
  await expect(
    readTmuxServerDiagnostics(
      {
        ...options,
        fetch: async () => {
          abort.abort();
          return new Response("", { status: 404 });
        },
      },
      scope,
      abort.signal,
    ),
  ).rejects.toThrow();
});

it("bounds metadata response bytes without retry", async () => {
  let calls = 0;
  await expect(
    readTmuxServerDiagnostics(
      {
        ...options,
        fetch: async () => {
          calls++;
          return new Response(" ".repeat(4097));
        },
      },
      scope,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it("times out while reading an unfinished response body", async () => {
  let cancelled = false;
  await expect(
    readTmuxServerDiagnostics(
      {
        ...options,
        timeoutMs: 10,
        fetch: async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
                init!.signal!.addEventListener(
                  "abort",
                  () => {
                    cancelled = true;
                    controller.error(init!.signal!.reason);
                  },
                  { once: true },
                );
              },
            }),
          ),
      },
      scope,
    ),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});
