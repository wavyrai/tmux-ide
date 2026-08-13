import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import type { GenerationGateway } from "./generation-gateway.ts";
import { startProductionWebServer } from "./production-web-server.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

const daemon: CanonicalDaemonInfo = {
  pid: process.pid,
  port: 45454,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-13T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "daemon-owner-token",
};

async function fixture(statuses: number[] = [200]) {
  const root = await mkdtemp(join(tmpdir(), "tmux-ide-web-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html><head></head><body>app</body></html>");
  writeFileSync(join(root, "assets", "app.js"), "console.log('ok')");
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  const seen: Array<{
    authorization?: string;
    hostClientId?: string;
    method?: string;
    body: string;
    contentLength?: string;
  }> = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        authorization: request.headers.authorization,
        hostClientId:
          typeof request.headers["x-tmux-ide-host-client-id"] === "string"
            ? request.headers["x-tmux-ide-host-client-id"]
            : undefined,
        method: request.method,
        body: Buffer.concat(chunks).toString("utf8"),
        contentLength: request.headers["content-length"],
      });
      response.statusCode = statuses.shift() ?? 200;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          response.statusCode === 503
            ? { code: "canonical_daemon_unavailable" }
            : { ok: response.statusCode === 200 },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture gateway did not bind");
  const gateway: GenerationGateway = {
    origin: `http://127.0.0.1:${address.port}`,
    bearer: "gateway-secret",
    stop: vi.fn(async () => undefined),
  };
  const server = await startProductionWebServer({
    staticRoot: root,
    cliEntryPath: "/unused/cli.js",
    gateway,
    ensureDaemon: async () => ({ candidate: daemon }),
    openProject: vi.fn(async () => null),
  });
  cleanup.push(server.stop);
  return { server, gateway, seen, root };
}

describe("production Web GUI server", () => {
  it("serves an immutable production build with a document-scoped capability", async () => {
    const { server } = await fixture();
    const document = await fetch(server.url);
    const html = await document.text();
    expect(document.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(document.headers.get("cache-control")).toBe("no-store");
    expect(html).toMatch(/meta name="tmux-ide-dev-host-session" content="[^"]+"/u);

    const asset = await fetch(`${server.url}assets/app.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(await asset.text()).toContain("console.log");
  });

  it("refuses traversal through intermediate directory symlinks", async () => {
    const { server, root } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "tmux-ide-web-outside-"));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "secret.txt"), "not public");
    symlinkSync(outside, join(root, "escape"), "dir");
    const response = await fetch(`${server.url}escape/secret.txt`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("not public");
  });

  it("keeps gateway authority server-side and projects a stable document identity", async () => {
    const { server, seen } = await fixture();
    const html = await (await fetch(server.url)).text();
    expect(html).not.toContain("gateway-secret");
    expect(html).not.toContain("daemon-owner-token");
    const capability = /content="([^"]+)"/u.exec(html)?.[1];
    expect(capability).toBeTruthy();
    const origin = new URL(server.url).origin;
    const response = await fetch(`${server.url}api/resources/startup-readiness`, {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Tmux-Ide-Dev-Host-Session": capability!,
        "X-Tmux-Ide-Dev-Original-Method": "GET",
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      authorization: "Bearer gateway-secret",
      hostClientId: expect.stringMatching(/^web:/u),
      method: "GET",
      body: "",
      contentLength: undefined,
    });

    const refused = await fetch(`${server.url}api/resources/startup-readiness`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(refused.status).toBe(401);
  });

  it("preserves the original POST body and length across one daemon-recovery retry", async () => {
    const { server, seen } = await fixture([503, 200]);
    const html = await (await fetch(server.url)).text();
    const capability = /content="([^"]+)"/u.exec(html)?.[1];
    const origin = new URL(server.url).origin;
    const body = JSON.stringify({ command: "send", message: "hello" });
    const response = await fetch(`${server.url}api/v2/action/test`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Dev-Host-Session": capability!,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.map((request) => request.body)).toEqual([body, body]);
    expect(seen.map((request) => request.contentLength)).toEqual([
      String(Buffer.byteLength(body)),
      String(Buffer.byteLength(body)),
    ]);
  });

  it("isolates two documents behind different stable host identities", async () => {
    const { server, seen } = await fixture([200, 200]);
    const origin = new URL(server.url).origin;
    const first = /content="([^"]+)"/u.exec(await (await fetch(server.url)).text())?.[1];
    const second = /content="([^"]+)"/u.exec(await (await fetch(server.url)).text())?.[1];
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    for (const capability of [first, second]) {
      const response = await fetch(`${server.url}api/resources/startup-readiness`, {
        method: "POST",
        headers: {
          Origin: origin,
          "X-Tmux-Ide-Dev-Host-Session": capability!,
          "X-Tmux-Ide-Dev-Original-Method": "GET",
        },
      });
      expect(response.status).toBe(200);
    }
    expect(seen[0]?.hostClientId).not.toBe(seen[1]?.hostClientId);
  });

  it("is loopback-only and closes cleanly without owning an injected gateway", async () => {
    const { server, gateway } = await fixture();
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    await server.stop();
    expect(gateway.stop).not.toHaveBeenCalled();
  });
});
