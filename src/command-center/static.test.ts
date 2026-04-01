import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { serveDashboard } from "./static.ts";

describe("serveDashboard", () => {
  it("serves index.html for root path", async () => {
    const app = new Hono();
    app.get("/api/test", (c) => c.json({ ok: true }));
    app.use("*", serveDashboard());

    const res = await app.request("/");
    // Dashboard out/ exists from build, should serve HTML
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");
  });

  it("does not intercept /api routes", async () => {
    const app = new Hono();
    app.get("/api/test", (c) => c.json({ ok: true }));
    app.use("*", serveDashboard());

    const res = await app.request("/api/test");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("does not intercept /health", async () => {
    const app = new Hono();
    app.get("/health", (c) => c.json({ ok: true }));
    app.use("*", serveDashboard());

    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("serves fallback HTML for /project/any-name/", async () => {
    const app = new Hono();
    app.use("*", serveDashboard());

    const res = await app.request("/project/my-project/");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");
  });

  it("sets immutable cache for _next/static assets", async () => {
    const app = new Hono();
    app.use("*", serveDashboard());

    // Find a real _next/static file from the build output
    const { readdirSync, existsSync } = await import("node:fs");
    const { join, resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const staticDir = join(pkgRoot, "dashboard", "out", "_next", "static");

    if (existsSync(staticDir)) {
      // Find any JS file in the static dir recursively
      const findFile = (dir: string): string | null => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(".js")) {
            return `/_next/static/${dir.slice(staticDir.length + 1)}/${entry.name}`.replace(
              /\/+/g,
              "/",
            );
          }
          if (entry.isDirectory()) {
            const found = findFile(join(dir, entry.name));
            if (found) return found;
          }
        }
        return null;
      };

      const jsFile = findFile(staticDir);
      if (jsFile) {
        const res = await app.request(jsFile);
        expect(res.status).toBe(200);
        const cacheControl = res.headers.get("cache-control");
        expect(cacheControl).toContain("immutable");
      }
    }
  });
});
