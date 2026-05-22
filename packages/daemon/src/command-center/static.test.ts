import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveDashboard } from "./static.ts";

// Post-G16 cutover: the dashboard SPA bundle lives at dashboard/dist/.
// Build-dependent tests look there and self-skip when the workspace
// hasn't run `pnpm --filter @tmux-ide/dashboard build` yet (CI lights
// it up via the build:dashboard step).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const outDir = join(pkgRoot, "dashboard", "dist");
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

  it("serves SPA fallback HTML for unknown client routes", async () => {
    if (!hasDashboardBuild) return; // skip in CI where dashboard isn't built

    const app = new Hono();
    app.use("*", serveDashboard());

    // Solid Router owns `/v2/project/:name` on the client — the server
    // just needs to hand back index.html for every non-asset path.
    const res = await app.request("/v2/project/my-project");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/html");
  });

  it("sets immutable cache for hashed /assets/ bundles", async () => {
    if (!hasDashboardBuild) return; // skip in CI where dashboard isn't built

    const app = new Hono();
    app.use("*", serveDashboard());

    const { readdirSync } = await import("node:fs");

    const assetsDir = join(outDir, "assets");
    if (!existsSync(assetsDir)) return;

    const jsFile = readdirSync(assetsDir).find((f) => f.endsWith(".js"));
    if (jsFile) {
      const res = await app.request(`/assets/${jsFile}`);
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
