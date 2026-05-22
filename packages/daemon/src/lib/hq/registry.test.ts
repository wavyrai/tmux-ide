// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { RemoteRegistry } from "./registry.ts";

// Mock fetch for health checks (always succeed in tests to avoid pruning)
const originalFetch = globalThis.fetch;

describe("RemoteRegistry", () => {
  let registry: RemoteRegistry;
  let shuttingDown = false;

  beforeEach(() => {
    shuttingDown = false;
    // Mock fetch so health checks succeed
    globalThis.fetch = (() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 }))) as typeof fetch;

    registry = new RemoteRegistry({
      healthInterval: 60_000, // long interval so health checks don't interfere
      healthTimeout: 1000,
      isShuttingDown: () => shuttingDown,
    });
  });

  afterEach(() => {
    registry.destroy();
    globalThis.fetch = originalFetch;
  });

  describe("register", () => {
    it("registers a machine and it appears in list", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://dev.example.com",
        token: "tok-1",
      });

      const machines = registry.getMachines();
      expect(machines.length).toBe(1);
      expect(machines[0]!.name).toBe("dev-box");
      expect(machines[0]!.url).toBe("https://dev.example.com");
    });

    it("sets registeredAt and lastHeartbeat to now", () => {
      const before = Date.now();
      const m = registry.register({
        id: "m2",
        name: "prod-1",
        url: "https://prod.example.com",
        token: "tok-2",
      });
      const after = Date.now();

      expect(m.registeredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(m.registeredAt.getTime()).toBeLessThanOrEqual(after);
      expect(m.lastHeartbeat.getTime()).toBeGreaterThanOrEqual(before);
    });

    it("initializes sessionIds as empty set", () => {
      const m = registry.register({
        id: "m3",
        name: "staging",
        url: "https://staging.example.com",
        token: "tok-3",
      });
      expect(m.sessionIds.size).toBe(0);
    });
  });

  describe("duplicate registration updates", () => {
    it("re-registration with same ID updates fields", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://old.example.com",
        token: "tok-old",
      });

      const updated = registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://new.example.com",
        token: "tok-new",
      });

      expect(registry.getMachines().length).toBe(1);
      expect(updated.url).toBe("https://new.example.com");
      expect(updated.token).toBe("tok-new");
    });

    it("rejects different ID with same name", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://one.example.com",
        token: "tok-1",
      });

      expect(() =>
        registry.register({
          id: "m2",
          name: "dev-box",
          url: "https://two.example.com",
          token: "tok-2",
        }),
      ).toThrow("already registered");
    });
  });

  describe("unregister", () => {
    it("removes machine from list", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://dev.example.com",
        token: "tok-1",
      });
      expect(registry.getMachines().length).toBe(1);

      const result = registry.unregister("m1");
      expect(result).toBe(true);
      expect(registry.getMachines().length).toBe(0);
    });

    it("returns false for unknown ID", () => {
      expect(registry.unregister("nonexistent")).toBe(false);
    });
  });

  describe("session-to-remote mapping", () => {
    it("maps sessions to machines", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://dev.example.com",
        token: "tok-1",
      });

      registry.updateSessions("m1", ["sess-a", "sess-b"]);

      const found = registry.getMachineBySession("sess-a");
      expect(found).toBeDefined();
      expect(found!.id).toBe("m1");

      const foundB = registry.getMachineBySession("sess-b");
      expect(foundB).toBeDefined();
      expect(foundB!.id).toBe("m1");
    });

    it("returns undefined for unmapped session", () => {
      expect(registry.getMachineBySession("unknown")).toBeUndefined();
    });

    it("cleans up session mappings on unregister", () => {
      registry.register({
        id: "m1",
        name: "dev-box",
        url: "https://dev.example.com",
        token: "tok-1",
      });
      registry.updateSessions("m1", ["sess-a"]);
      expect(registry.getMachineBySession("sess-a")).toBeDefined();

      registry.unregister("m1");
      expect(registry.getMachineBySession("sess-a")).toBeUndefined();
    });
  });

  describe("health check failure prunes", () => {
    it("removes machine when health check fails", async () => {
      // Make health check fail
      globalThis.fetch = (() =>
        Promise.resolve(new Response("Server Error", { status: 500 }))) as typeof fetch;

      // Use short health interval
      registry.destroy();
      registry = new RemoteRegistry({
        healthInterval: 50,
        healthTimeout: 50,
        isShuttingDown: () => shuttingDown,
      });

      registry.register({
        id: "m1",
        name: "unhealthy",
        url: "https://dead.example.com",
        token: "tok-1",
      });

      // Wait for health check to fire and prune
      await new Promise((r) => setTimeout(r, 200));

      expect(registry.getMachines().length).toBe(0);
    });

    it("does not prune during shutdown", async () => {
      globalThis.fetch = (() =>
        Promise.resolve(new Response("Server Error", { status: 500 }))) as typeof fetch;

      registry.destroy();
      registry = new RemoteRegistry({
        healthInterval: 50,
        healthTimeout: 50,
        isShuttingDown: () => shuttingDown,
      });

      registry.register({
        id: "m1",
        name: "box",
        url: "https://box.example.com",
        token: "tok-1",
      });

      shuttingDown = true;
      await new Promise((r) => setTimeout(r, 200));

      // Should still be registered because shutdown flag prevents pruning
      expect(registry.getMachines().length).toBe(1);
    });
  });

  describe("getMachine", () => {
    it("returns machine by ID", () => {
      registry.register({
        id: "m1",
        name: "dev",
        url: "https://dev.example.com",
        token: "tok",
      });

      expect(registry.getMachine("m1")).toBeDefined();
      expect(registry.getMachine("m1")!.name).toBe("dev");
      expect(registry.getMachine("unknown")).toBeUndefined();
    });
  });
});
