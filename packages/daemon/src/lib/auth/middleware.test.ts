// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { AuthService } from "./auth-service.ts";
import { authMiddleware, validateWsToken } from "./middleware.ts";
import type { AuthConfig } from "./types.ts";

describe("authMiddleware", () => {
  let auth: AuthService;
  const SECRET = "test-middleware-secret";

  beforeEach(() => {
    auth = new AuthService(SECRET);
  });

  afterEach(() => {
    auth.dispose();
  });

  function buildApp(config: AuthConfig): Hono {
    const app = new Hono();
    app.use("/*", authMiddleware(auth, config));
    app.get("/health", (c) => c.json({ ok: true }));
    app.get("/api/auth/challenge", (c) => c.json({ bypassed: true }));
    app.get("/api/sessions", (c) => c.json({ sessions: [] }));
    return app;
  }

  describe("method = none (backward compatible)", () => {
    it("passes through all requests without auth", async () => {
      const app = buildApp({ method: "none", token_expiry: 86400 });
      const res = await app.request("/api/sessions");
      expect(res.status).toBe(200);
    });
  });

  describe("method = ssh", () => {
    const config: AuthConfig = { method: "ssh", token_expiry: 86400 };

    it("bypasses /health", async () => {
      const app = buildApp(config);
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    });

    it("bypasses /api/auth/* routes", async () => {
      const app = buildApp(config);
      const res = await app.request("/api/auth/challenge");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bypassed).toBe(true);
    });

    it("rejects requests without Authorization header", async () => {
      const app = buildApp(config);
      const res = await app.request("/api/sessions");
      expect(res.status).toBe(401);
    });

    it("rejects requests with invalid token", async () => {
      const app = buildApp(config);
      const res = await app.request("/api/sessions", {
        headers: { Authorization: "Bearer invalid-token" },
      });
      expect(res.status).toBe(401);
    });

    it("allows requests with valid token", async () => {
      const app = buildApp(config);
      const token = auth.generateToken("alice");
      const res = await app.request("/api/sessions", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    });

    it("rejects requests with non-Bearer auth", async () => {
      const app = buildApp(config);
      const res = await app.request("/api/sessions", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    });
  });
});

describe("validateWsToken", () => {
  let auth: AuthService;
  const SECRET = "test-ws-secret";

  beforeEach(() => {
    auth = new AuthService(SECRET);
  });

  afterEach(() => {
    auth.dispose();
  });

  it("returns 'anonymous' when method is none", () => {
    const result = validateWsToken(auth, { method: "none", token_expiry: 86400 }, null);
    expect(result).toBe("anonymous");
  });

  it("returns null when method is ssh and no token provided", () => {
    const result = validateWsToken(auth, { method: "ssh", token_expiry: 86400 }, null);
    expect(result).toBeNull();
  });

  it("returns userId for valid token", () => {
    const token = auth.generateToken("bob");
    const result = validateWsToken(auth, { method: "ssh", token_expiry: 86400 }, token);
    expect(result).toBe("bob");
  });

  it("returns null for invalid token", () => {
    const result = validateWsToken(auth, { method: "ssh", token_expiry: 86400 }, "bad-token");
    expect(result).toBeNull();
  });
});
