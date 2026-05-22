/**
 * Solid registry hook — wire test (G20-P1).
 *
 * Verifies the CRUD-shape against a fetch mock:
 *   1. `useTerminals` GETs /api/project/:name/terminals on mount.
 *   2. `createTerminal` POSTs /api/.../terminals with the typed body.
 *   3. `renameTerminal` POSTs /rename.
 *   4. `deleteTerminal` DELETEs.
 *
 * No Solid render is needed — the hook resolves the resource via
 * Effect.runPromise + createResource, and the Effect helpers are
 * directly callable from a vitest async block.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  createTerminal,
  defaultShellTerminalId,
  deleteTerminal,
  fetchTerminals,
  renameTerminal,
} from "@/lib/pty/registry";

function jsonOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  globalThis.fetch = vi.fn() as typeof fetch;
});

describe("registry — fetchTerminals", () => {
  it("GETs the list endpoint and returns the terminals array", async () => {
    let captured = "";
    globalThis.fetch = vi.fn(async (input) => {
      captured = String(input);
      return jsonOk({
        terminals: [
          {
            id: "abc",
            projectId: "proj",
            scopeId: "main",
            name: "shell",
            kind: "shell",
            createdAt: "2026-05-13T00:00:00Z",
            updatedAt: "2026-05-13T00:00:00Z",
            runtime: { running: true, cols: 80, rows: 24 },
          },
        ],
      });
    }) as typeof fetch;
    const list = await Effect.runPromise(fetchTerminals("proj"));
    expect(captured).toContain("/api/project/proj/terminals");
    expect(list).toHaveLength(1);
    expect(list[0]!.runtime.running).toBe(true);
  });
});

describe("registry — create / rename / delete", () => {
  it("createTerminal POSTs the typed body", async () => {
    const calls: Array<{ url: string; body: unknown; method: string }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({
        url: String(input),
        method: (init?.method as string) ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonOk({
        ok: true,
        terminal: {
          id: "new",
          projectId: "proj",
          scopeId: "main",
          name: "Dev",
          kind: "shell",
          createdAt: "2026-05-13T00:00:00Z",
          updatedAt: "2026-05-13T00:00:00Z",
        },
      });
    }) as typeof fetch;
    const term = await Effect.runPromise(createTerminal("proj", { scopeId: "main", name: "Dev" }));
    expect(term.id).toBe("new");
    const call = calls.find((c) => c.url.endsWith("/terminals"));
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ scopeId: "main", name: "Dev" });
  });

  it("renameTerminal POSTs to /<id>/rename", async () => {
    let url = "";
    let body: unknown = null;
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input);
      body = init?.body ? JSON.parse(String(init.body)) : null;
      return jsonOk({
        ok: true,
        terminal: {
          id: "abc",
          projectId: "proj",
          scopeId: "main",
          name: "Renamed",
          kind: "shell",
          createdAt: "2026-05-13T00:00:00Z",
          updatedAt: "2026-05-13T00:00:00Z",
        },
      });
    }) as typeof fetch;
    const term = await Effect.runPromise(renameTerminal("proj", "abc", { name: "Renamed" }));
    expect(url).toContain("/api/project/proj/terminals/abc/rename");
    expect(body).toEqual({ name: "Renamed" });
    expect(term.name).toBe("Renamed");
  });

  it("deleteTerminal sends DELETE", async () => {
    let method = "";
    let url = "";
    globalThis.fetch = vi.fn(async (input, init) => {
      url = String(input);
      method = (init?.method as string) ?? "GET";
      return jsonOk({ ok: true });
    }) as typeof fetch;
    await Effect.runPromise(deleteTerminal("proj", "abc"));
    expect(method).toBe("DELETE");
    expect(url).toContain("/api/project/proj/terminals/abc");
  });
});

describe("registry — defaultShellTerminalId", () => {
  it("returns the same 32-char id for the same session+dir", async () => {
    const a = await defaultShellTerminalId({
      projectId: "proj",
      scopeId: "/Users/me/repo",
    });
    const b = await defaultShellTerminalId({
      projectId: "proj",
      scopeId: "/Users/me/repo",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });
});
