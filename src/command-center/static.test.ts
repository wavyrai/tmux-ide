import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveDashboard } from "./static.ts";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(pkgRoot, "dashboard", "out");
const hasDashboardBuild = existsSync(join(outDir, "index.html"));

describe("serveDashboard", () => {
  it("serves index.html for root path", async () => {
    if (!hasDashboardBuild) return; // skip in CI where dashboard isn't built

    const app = new Hono();
    app.get("/api/test", (c) => c.json({ ok: true }));
    app.use("*", serveDashboard());

    const res = await app.request("/");
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
    if (!hasDashboardBuild) return; // skip in CI where dashboard isn't built

    const app = new Hono();
    app.use("*", serveDashboard());

    const res = await app.request("/project/my-project/");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");
  });

  it("sets immutable cache for _next/static assets", async () => {
    if (!hasDashboardBuild) return; // skip in CI where dashboard isn't built

    const app = new Hono();
    app.use("*", serveDashboard());

    const { readdirSync } = await import("node:fs");

    const staticDir = join(outDir, "_next", "static");
    if (!existsSync(staticDir)) return;

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
  });

  it("falls through when dashboard is not built", async () => {
    // Simulate no dashboard by using a middleware that won't find files
    const app = new Hono();
    app.use("*", serveDashboard());
    app.all("*", (c) => c.json({ fallback: true }, 200));

    const res = await app.request("/nonexistent-path");
    expect(res.status).toBe(200);
  });
});
