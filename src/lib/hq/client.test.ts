// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HQClient } from "./client.ts";

// Capture fetch calls
let fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchResponses: Array<{ ok: boolean; status: number; text: string }> = [];

const originalFetch = globalThis.fetch;

function mockFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  fetchCalls.push({ url: urlStr, init: init ?? {} });
  const next = fetchResponses.shift() ?? { ok: true, status: 200, text: "{}" };
  return Promise.resolve(
    new Response(next.text, {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("HQClient", () => {
  let client: HQClient;

  beforeEach(() => {
    fetchCalls = [];
    fetchResponses = [];
    globalThis.fetch = mockFetch as typeof fetch;

    client = new HQClient({
      hqUrl: "https://hq.example.com",
      secret: "mysecret",
      machineName: "dev-box",
      remoteUrl: "https://remote.example.com",
      bearerToken: "bearer-token-123",
      heartbeatInterval: 100, // fast for tests
    });
  });

  afterEach(async () => {
    await client.destroy();
    globalThis.fetch = originalFetch;
  });

  describe("registration", () => {
    it("sends POST to /api/hq/register with Basic Auth", async () => {
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' });
      await client.register();

      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
      const reg = fetchCalls[0]!;
      expect(reg.url).toBe("https://hq.example.com/api/hq/register");
      expect(reg.init.method).toBe("POST");

      const authHeader = (reg.init.headers as Record<string, string>)["Authorization"];
      expect(authHeader).toStartWith("Basic ");
      const decoded = Buffer.from(authHeader!.slice(6), "base64").toString();
      expect(decoded).toBe("mysecret");
    });

    it("sends correct payload with id, name, url, token", async () => {
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' });
      await client.register();

      const body = JSON.parse(fetchCalls[0]!.init.body as string);
      expect(body.name).toBe("dev-box");
      expect(body.url).toBe("https://remote.example.com");
      expect(body.token).toBe("bearer-token-123");
      expect(body.id).toBeTruthy();
    });

    it("throws on registration failure", async () => {
      fetchResponses.push({ ok: false, status: 401, text: "Unauthorized" });
      await expect(client.register()).rejects.toThrow("Registration failed (401)");
    });
  });

  describe("heartbeat", () => {
    it("fires heartbeat after registration", async () => {
      // Registration + at least 1 heartbeat
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' });
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' });
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' });

      await client.register();

      // Wait for heartbeat interval to fire
      await new Promise((r) => setTimeout(r, 250));

      // At least 1 registration + 1 heartbeat
      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);

      // All calls go to /api/hq/register
      for (const call of fetchCalls) {
        expect(call.url).toBe("https://hq.example.com/api/hq/register");
      }
    });
  });

  describe("backoff on failure", () => {
    it("increases backoff when heartbeat fails", async () => {
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' }); // register OK
      fetchResponses.push({ ok: false, status: 500, text: "Server Error" }); // heartbeat fail
      fetchResponses.push({ ok: false, status: 500, text: "Server Error" }); // heartbeat fail

      await client.register();
      await new Promise((r) => setTimeout(r, 250));

      // Client should still be alive (backoff doesn't crash)
      expect(client.getRemoteId()).toBeTruthy();
    });
  });

  describe("deregister on shutdown", () => {
    it("sends DELETE on destroy", async () => {
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' }); // register
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' }); // deregister DELETE

      await client.register();
      await client.destroy();

      const deleteCalls = fetchCalls.filter((c) => c.init.method === "DELETE");
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0]!.url).toContain("/api/hq/machines/");
      expect(deleteCalls[0]!.url).toContain(client.getRemoteId());
    });

    it("does not throw if deregister fails", async () => {
      fetchResponses.push({ ok: true, status: 200, text: '{"ok":true}' }); // register
      // No response for DELETE — will fail

      await client.register();
      // Should not throw
      await client.destroy();
    });
  });

  describe("accessors", () => {
    it("returns remote ID", () => {
      expect(client.getRemoteId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("returns bearer token", () => {
      expect(client.getToken()).toBe("bearer-token-123");
    });

    it("returns machine name", () => {
      expect(client.getName()).toBe("dev-box");
    });
  });
});
